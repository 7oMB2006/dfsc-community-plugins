"""Pinned, declarative marketplace maintenance. No plugin code is executed here."""
import base64
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import urllib.error
import urllib.parse
import urllib.request

MAX_FILE = 8 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
MAX_FILES = 1000
MAX_MANIFEST = 512 * 1024  # Step 0.6 readStepPluginManifest limit.
MAX_PRESENTATION = 64 * 1024
COMMUNITY_CATEGORIES = frozenset({
    'development', 'research', 'text-documents', 'knowledge',
    'audio-video', 'image-design', 'automation', 'themes',
})
JS_TRIM = (' \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005'
           '\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')
HEX40 = re.compile(r'[0-9a-f]{40}')
HEX64 = re.compile(r'[0-9a-f]{64}')
NAME = re.compile(r'[a-z0-9][a-z0-9_-]{0,79}')
REPO = re.compile(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+')
RESERVED = re.compile(r'con|prn|aux|nul|com[1-9]|lpt[1-9]')
WINDOWS_DEVICE = re.compile(r'con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]')
WINDOWS_INVALID = re.compile(r'[<>:"\\|?*]')
FORBIDDEN = {'.env', 'model.json', 'human.json', 'tasks.sqlite', 'delivery.json'}


class MarketError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise MarketError(message)


def safe_name(value):
    require(isinstance(value, str) and NAME.fullmatch(value) and not RESERVED.fullmatch(value),
            'Invalid marketplace or plugin identifier')
    return value


def relative(value):
    require(isinstance(value, str) and value and '\\' not in value and ':' not in value
            and not value.startswith('/') and not any(ord(c) < 32 or ord(c) == 127
                                                     or 0xD800 <= ord(c) <= 0xDFFF for c in value),
            'Invalid relative path')
    parts = value.split('/')
    require(all(p not in ('', '.', '..') for p in parts), 'Path must stay inside its directory')
    for part in parts:
        require(not WINDOWS_INVALID.search(part) and not part.endswith(('.', ' '))
                and len(part.encode('utf-16-le')) // 2 <= 255
                and not WINDOWS_DEVICE.fullmatch(part.split('.', 1)[0].rstrip(' ').casefold()),
                'Resource path is not portable to Windows')
    require(not any(p.casefold() in FORBIDDEN or p.casefold().startswith('.env.') for p in parts),
            'Private state is not an installable resource')
    return value


def plain(root, name):
    target = root
    for part in relative(name).split('/'):
        target = target / part
        require(not target.is_symlink(), 'Symbolic links are not permitted: ' + name)
    return target


def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result, 'Duplicate JSON key: ' + key)
        result[key] = value
    return result


def decode_json(data):
    try:
        return json.loads(data, object_pairs_hook=pairs)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise MarketError('Invalid UTF-8 JSON') from error


def read_json(root, name):
    return decode_json(plain(root, name).read_bytes())


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def portable_paths(paths):
    spellings = {}
    all_files = set(paths)
    for name in paths:
        relative(name)
        parts = name.split('/')
        for count in range(1, len(parts) + 1):
            prefix = '/'.join(parts[:count])
            folded = prefix.casefold()
            require(folded not in spellings or spellings[folded] == prefix,
                    'Case-colliding resource path: ' + name)
            spellings[folded] = prefix
            require(count == len(parts) or prefix not in all_files,
                    'Resource path conflicts with a file: ' + name)


def source(value):
    require(isinstance(value, dict) and set(value) == {'repository', 'commit', 'path'}, 'Invalid source declaration')
    require(isinstance(value['repository'], str) and REPO.fullmatch(value['repository'])
            and all(p not in ('.', '..') for p in value['repository'].split('/')), 'Invalid GitHub repository')
    require(isinstance(value['commit'], str) and HEX40.fullmatch(value['commit']), 'Source must pin a full commit SHA')
    relative(value['path'])


def registry(root):
    value = read_json(root, 'registry.json')
    require(isinstance(value, dict) and value.get('schemaVersion') == 1, 'Unsupported registry schema')
    safe_name(value.get('marketplaceName'))
    require(value['marketplaceName'] != 'builtin', 'The community source cannot replace builtin')
    require(isinstance(value.get('plugins'), list), 'plugins must be an array')
    seen = set()
    for item in value['plugins']:
        require(isinstance(item, dict), 'Invalid registry entry')
        ident = safe_name(item.get('id'))
        require(ident not in seen, 'Duplicate plugin: ' + ident)
        seen.add(ident)
        require(isinstance(item.get('description'), str) and item['description'].strip(), 'Description is required')
        require(isinstance(item.get('license'), str) and item['license'].strip(), 'License attribution is required')
        source(item.get('source'))
        relative(item.get('readme'))
        require(plain(root, item['readme']).is_file(), 'Missing reviewed plugin guide: ' + ident)
    return value


def lockfile(root):
    value = read_json(root, 'registry.lock.json')
    require(isinstance(value, dict) and value.get('schemaVersion') == 1
            and isinstance(value.get('plugins'), list), 'Unsupported lock schema')
    seen = set()
    for item in value['plugins']:
        require(isinstance(item, dict), 'Invalid lock entry')
        ident = safe_name(item.get('id'))
        require(ident not in seen, 'Duplicate locked plugin: ' + ident)
        seen.add(ident)
        source(item.get('source'))
        rows = item.get('files')
        require(isinstance(rows, list) and 0 < len(rows) <= MAX_FILES, 'Invalid locked file inventory')
        paths = set()
        total = 0
        for row in rows:
            require(isinstance(row, dict), 'Invalid locked file')
            name = relative(row.get('path'))
            require(name.casefold() not in paths, 'Duplicate or case-colliding resource: ' + name)
            paths.add(name.casefold())
            require(isinstance(row.get('gitBlobSha'), str) and HEX40.fullmatch(row['gitBlobSha']), 'Invalid Git blob SHA')
            require(isinstance(row.get('sha256'), str) and HEX64.fullmatch(row['sha256']), 'Invalid SHA256')
            require(type(row.get('size')) is int and 0 <= row['size'] <= MAX_FILE, 'Invalid resource size')
            total += row['size']
        require(total <= MAX_TOTAL, 'Plugin exceeds the resource size limit')
        portable_paths([row['path'] for row in rows])
    return value


def native_manifest(config):
    return {'name': config['marketplaceName'], 'plugins': [
        {'name': p['id'], 'source': './plugins/' + p['id'], 'description': p['description']}
        for p in sorted(config['plugins'], key=lambda p: p['id'])]}


def git_blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def record(name, data):
    return {'path': name, 'gitBlobSha': git_blob(data), 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}


def inventory(directory):
    require(directory.is_dir() and not directory.is_symlink(), 'Resource directory is missing or linked')
    files = {}
    def unreadable(error):
        raise error
    for current, directories, names in os.walk(directory, followlinks=False, onerror=unreadable):
        for name in directories + names:
            path = Path(current) / name
            require(not path.is_symlink(), 'Symbolic links are not permitted')
        for name in names:
            path = Path(current) / name
            require(stat.S_ISREG(path.stat().st_mode), 'Only regular resource files are permitted')
            rel = relative(path.relative_to(directory).as_posix())
            require(path.stat().st_size <= MAX_FILE, 'Resource exceeds the file size limit')
            files[rel] = path.read_bytes()
            require(len(files) <= MAX_FILES and sum(map(len, files.values())) <= MAX_TOTAL, 'Plugin exceeds the resource limit')
    portable_paths(files)
    return files


def verify_locked(files, rows):
    require(set(files) == {r['path'] for r in rows}, 'Resource inventory differs from the reviewed lock')
    for row in rows:
        require(record(row['path'], files[row['path']]) == row, 'Resource hash mismatch: ' + row['path'])


def plugin_classification(files):
    data = files.get('dfsc.plugin.json')
    if data is None:
        return
    require(len(data) <= MAX_PRESENTATION, 'Desktop presentation exceeds the 64 KiB limit')
    try:
        value = decode_json(data.decode('utf-8'))
    except UnicodeError:
        raise MarketError('Desktop presentation must be UTF-8 JSON') from None
    require(isinstance(value, dict) and type(value.get('schemaVersion')) in (int, float)
            and value['schemaVersion'] == 1, 'Unsupported Desktop presentation schema')
    for key, limit in (('categories', 3), ('keywords', 5)):
        if key not in value:
            continue
        terms = value[key]
        require(isinstance(terms, list) and len(terms) <= limit, key + ' must be a bounded array')
        seen = set()
        for term in terms:
            # Match host String.trim and UTF-16 limits without changing the author bytes.
            require(isinstance(term, str) and term.strip(JS_TRIM)
                    and len(term.encode('utf-16-le', errors='surrogatepass')) // 2 <= 48
                    and not any(ord(c) < 32 for c in term), 'Invalid ' + key + ' term')
            normalized = term.strip(JS_TRIM)
            require(normalized not in seen, 'Duplicate ' + key + ' term')
            seen.add(normalized)
            if key == 'categories':
                require(normalized in COMMUNITY_CATEGORIES,
                        'Unknown community category; request a taxonomy review')


def plugin_manifest(files, ident):
    # Run after the reviewed README overlay as well as on the upstream inventory.
    portable_paths(files)
    require('step.plugin.json' in files, 'Missing step.plugin.json: ' + ident)
    require(len(files['step.plugin.json']) <= MAX_MANIFEST, 'Plugin manifest exceeds the native parser limit')
    manifest = decode_json(files['step.plugin.json'])
    require(isinstance(manifest, dict) and manifest.get('id') == ident, 'Plugin manifest id differs from the registry')
    for key in ('name', 'description'):
        require(key not in manifest or isinstance(manifest[key], str), key + ' must be a string')
    version = manifest.get('version')
    require(isinstance(version, str) and re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', version), 'A version is required')
    # The desktop does not execute plugin entry points or provision external runtimes.
    require(not any(key in manifest for key in ('entry', 'provision')), 'Executable entries and provisioning are not supported by this marketplace')
    for key in ('skills', 'commands', 'agents'):
        values = manifest.get(key, [])
        require(isinstance(values, list), key + ' must be an array')
        checked = set()
        for value in values:
            path = relative(value)
            require(path not in checked, 'Duplicate resource declaration')
            checked.add(path)
            require(path in files or any(name.startswith(path + '/') for name in files), 'Missing declared ' + key + ': ' + path)
    icon = manifest.get('icon')
    if icon is not None:
        require(relative(icon) in files, 'Missing icon')
    mcp = manifest.get('mcpServers')
    if isinstance(mcp, str):
        path = relative(mcp)
        require(path in files and isinstance(decode_json(files[path]), dict), 'Missing or invalid MCP declaration')
    elif 'mcpServers' in manifest:
        require(isinstance(mcp, dict), 'MCP declarations must be an object or resource path')
    plugin_classification(files)
    return manifest


def validate(root):
    root = Path(root).resolve()
    config, locked = registry(root), lockfile(root)
    declarations = {p['id']: p for p in config['plugins']}
    locks = {p['id']: p for p in locked['plugins']}
    require(set(declarations) == set(locks), 'Registry and lock inventories differ')
    directory = plain(root, 'plugins')
    present = {p.name for p in directory.iterdir()} if directory.is_dir() else set()
    require(present == set(declarations), 'Vendored plugin inventory differs from the registry')
    for ident, item in declarations.items():
        locked_item = locks[ident]
        require(locked_item['source'] == item['source'], 'Locked source differs: ' + ident)
        files = inventory(plain(root, 'plugins/' + ident))
        guide = plain(root, item['readme']).read_bytes()
        require(guide.strip() and files.get('README.md') == guide, 'Vendored README differs from its reviewed guide')
        expected = {r['path'] for r in locked_item['files']} | {'README.md'}
        require(set(files) == expected, 'Unexpected or missing vendored resource: ' + ident)
        for row in locked_item['files']:
            if row['path'] != 'README.md':
                require(record(row['path'], files[row['path']]) == row, 'Vendored resource drift: ' + row['path'])
        plugin_manifest(files, ident)
    require(read_json(root, '.step-plugin/marketplace.json') == native_manifest(config), 'Native marketplace manifest is out of date')
    return {'valid': True, 'marketplace': config['marketplaceName'], 'plugins': sorted(declarations)}


class ApiRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlparse(newurl)
        require(target.scheme == 'https' and target.hostname == 'api.github.com'
                and target.port in (None, 443) and not target.username and not target.password,
                'GitHub API redirected outside its origin')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def github_json(endpoint):
    headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'dfsc-community-marketplace'}
    token = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
    if token:
        # http.client includes invalid header values in some ValueError messages.
        # Reject before constructing headers, and never propagate transport text.
        require(len(token) <= 4096 and not any(ord(c) < 33 or ord(c) == 127 for c in token),
                'GitHub authentication token contains invalid characters')
        headers['Authorization'] = 'Bearer ' + token
    try:
        request = urllib.request.Request('https://api.github.com/' + endpoint, headers=headers)
        with urllib.request.build_opener(ApiRedirect()).open(request, timeout=30) as response:
            data = response.read(16 * 1024 * 1024 + 1)
        require(len(data) <= 16 * 1024 * 1024, 'GitHub API response exceeds the size limit')
        value = decode_json(data)
        require(isinstance(value, dict), 'GitHub API returned an unexpected JSON value')
        return value
    except urllib.error.HTTPError as error:
        raise MarketError('GitHub API returned HTTP %s; private sources require an authorized GH_TOKEN or GITHUB_TOKEN' % error.code) from None
    except (OSError, ValueError, TypeError, http.client.HTTPException):
        raise MarketError('GitHub API request failed; check its response, network and authentication') from None


def fetch_source(item, fetch=github_json):
    src = item['source']
    prefix = 'repos/' + src['repository'] + '/git/'
    commit = fetch(prefix + 'commits/' + src['commit'])
    require(isinstance(commit, dict) and commit.get('sha') == src['commit'], 'GitHub returned a different source commit')
    tree_ref = commit.get('tree')
    require(isinstance(tree_ref, dict), 'Missing source tree')
    tree_sha = tree_ref.get('sha')
    require(isinstance(tree_sha, str) and HEX40.fullmatch(tree_sha), 'Missing source tree')
    tree = fetch(prefix + 'trees/' + tree_sha + '?recursive=1')
    require(isinstance(tree, dict) and tree.get('sha') == tree_sha and tree.get('truncated') is False
            and isinstance(tree.get('tree'), list), 'Incomplete GitHub source tree')
    files = {}
    base = src['path'] + '/'
    for entry in tree['tree']:
        require(isinstance(entry, dict), 'Invalid GitHub tree entry')
        path = entry.get('path')
        require(isinstance(path, str) and path, 'Invalid GitHub tree path')
        if not path.startswith(base):
            continue
        if entry.get('type') == 'tree':
            relative(path[len(base):])
            continue
        name = relative(path[len(base):])
        require(entry.get('type') == 'blob' and entry.get('mode') in ('100644', '100755'), 'Source contains a link or unsupported Git object')
        require(name.casefold() not in {p.casefold() for p in files}, 'Duplicate or case-colliding source file')
        sha = entry.get('sha')
        require(isinstance(sha, str) and HEX40.fullmatch(sha), 'Invalid source blob SHA')
        require(type(entry.get('size')) is int and 0 <= entry['size'] <= MAX_FILE, 'Source file exceeds the size limit')
        blob = fetch(prefix + 'blobs/' + sha)
        require(isinstance(blob, dict) and blob.get('sha') == sha
                and blob.get('encoding') == 'base64' and isinstance(blob.get('content'), str),
                'Invalid source blob response')
        try:
            data = base64.b64decode(''.join(blob['content'].split()), validate=True)
        except (ValueError, KeyError, TypeError):
            raise MarketError('Invalid base64 source blob') from None
        require(len(data) == entry['size'] and git_blob(data) == sha, 'Source Git blob hash mismatch')
        files[name] = data
        require(len(files) <= MAX_FILES and sum(map(len, files.values())) <= MAX_TOTAL, 'Source exceeds the plugin size limit')
    portable_paths(files)
    plugin_manifest(files, item['id'])
    return files


def sync(root, ident=None, source_dir=None, fetch=github_json):
    root = Path(root).resolve()
    config = registry(root)
    current = lockfile(root) if plain(root, 'registry.lock.json').exists() else {'schemaVersion': 1, 'plugins': []}
    selected = [p for p in config['plugins'] if ident is None or p['id'] == ident]
    require(selected, 'Unknown plugin identifier')
    require(source_dir is None or len(selected) == 1 and ident is not None, '--source-dir requires one --plugin')
    locks = {p['id']: p for p in current['plugins']}
    prepared = {}
    # Complete acquisition and validation before changing any active package.
    for item in selected:
        name = item['id']
        if source_dir is not None:
            locked = locks.get(name)
            require(locked and locked['source'] == item['source'], 'Offline sync requires a matching reviewed source lock')
            files = inventory(Path(source_dir))
            verify_locked(files, locked['files'])
        else:
            files = fetch_source(item, fetch)
        locks[name] = {'id': name, 'source': copy.deepcopy(item['source']),
                       'files': [record(path, data) for path, data in sorted(files.items())]}
        files['README.md'] = plain(root, item['readme']).read_bytes()
        plugin_manifest(files, name)
        prepared[name] = files
    require(set(locks) == {p['id'] for p in config['plugins']}, 'Sync every newly added plugin together before publishing')
    result_lock = {'schemaVersion': 1, 'plugins': [locks[key] for key in sorted(locks)]}
    guard = root / '.community-sync.lock'
    try:
        descriptor = os.open(guard, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise MarketError('Another synchronization is in progress; inspect .community-sync.lock') from None
    os.close(descriptor)
    try:
        with tempfile.TemporaryDirectory(prefix='.community-stage-', dir=root) as temporary:
            stage = Path(temporary)
            updates = []
            for name, files in prepared.items():
                candidate = stage / 'new' / name
                candidate.mkdir(parents=True)
                for path, data in files.items():
                    target = candidate / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                updates.append((plain(root, 'plugins/' + name), candidate))
            for name, data in [('registry.lock.json', encoded(result_lock)),
                               ('.step-plugin/marketplace.json', encoded(native_manifest(config)))]:
                pending = stage / ('metadata-' + str(len(updates)))
                pending.write_bytes(data)
                updates.append((plain(root, name), pending))
            changed = []
            try:
                for index, (active, pending) in enumerate(updates):
                    active.parent.mkdir(parents=True, exist_ok=True)
                    backup = stage / ('backup-' + str(index))
                    had_previous = active.exists()
                    if had_previous:
                        active.replace(backup)
                    changed.append((active, backup, had_previous))
                    pending.replace(active)
                outcome = validate(root)
            except Exception:
                for active, backup, had_previous in reversed(changed):
                    if active.is_dir():
                        shutil.rmtree(active)
                    elif active.exists():
                        active.unlink()
                    if had_previous:
                        backup.replace(active)
                raise
    finally:
        guard.unlink()
    return {**outcome, 'synchronized': sorted(prepared)}
