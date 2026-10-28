import base64
import copy
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('marketplace', Path(__file__).resolve().parents[1] / 'scripts/marketplace.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def hashes(path, data):
    return {'path': path, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
            'gitBlobSha': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()}


class MarketplaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='marketplace-中文-')
        self.root = Path(self.temp.name).resolve()
        self.raw = {}
        self.config = {'schemaVersion': 1, 'marketplaceName': 'dfsc-community', 'plugins': []}
        self.lock = {'schemaVersion': 1, 'plugins': []}
        for ident in ('beta-plugin', 'alpha-plugin'):
            src = {'repository': 'example/' + ident, 'commit': 'a' * 40, 'path': 'resources/plugin'}
            item = {'id': ident, 'description': 'Fixture ' + ident, 'source': src,
                    'license': 'MIT', 'readme': 'docs/plugins/' + ident + '.md'}
            data = {'README.md': b'Upstream documentation\n', 'commands/help.md': b'Fixture command\n',
                    'step.plugin.json': json.dumps({'id': ident, 'version': '1.0.0', 'commands': ['commands']}).encode()}
            self.raw[ident] = data
            self.config['plugins'].append(item)
            self.lock['plugins'].append({'id': ident, 'source': copy.deepcopy(src),
                                        'files': [hashes(path, content) for path, content in sorted(data.items())]})
            guide = self.root / item['readme']
            guide.parent.mkdir(parents=True, exist_ok=True)
            guide.write_text('Reviewed guide for ' + ident + '\n', encoding='utf-8')
            for directory in (self.root / 'sources' / ident, self.root / 'plugins' / ident):
                for path, content in data.items():
                    target = directory / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(content)
            (self.root / 'plugins' / ident / 'README.md').write_bytes(guide.read_bytes())
        self.save()
        # Independent expected native declaration, deliberately sorted despite author order.
        write_json(self.root / '.step-plugin/marketplace.json', {
            'name': 'dfsc-community', 'plugins': [
                {'name': name, 'source': './plugins/' + name, 'description': 'Fixture ' + name}
                for name in ('alpha-plugin', 'beta-plugin')]})

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        write_json(self.root / 'registry.json', self.config)
        write_json(self.root / 'registry.lock.json', self.lock)

    def active(self):
        return {p.relative_to(self.root).as_posix(): p.read_bytes()
                for folder in ('plugins', '.step-plugin') for p in (self.root / folder).rglob('*') if p.is_file()} | {
                    'registry.lock.json': (self.root / 'registry.lock.json').read_bytes()}

    def entry(self):
        return self.config['plugins'][1]

    def api(self, data=None, bad_blob=False, tree_extra=None, fail_blob=None):
        data = data or self.raw['alpha-plugin']
        blobs = {hashes(name, body)['gitBlobSha']: body for name, body in data.items()}
        entries = [{'path': 'resources/plugin/' + name, 'mode': '100644', 'type': 'blob',
                    'sha': hashes(name, body)['gitBlobSha'], 'size': len(body)} for name, body in data.items()]
        entries.extend(tree_extra or [])
        def fetch(endpoint):
            if '/commits/' in endpoint:
                return {'sha': endpoint.rsplit('/', 1)[1], 'tree': {'sha': 'c' * 40}}
            if '/trees/' in endpoint:
                return {'sha': 'c' * 40, 'truncated': False, 'tree': entries}
            sha = endpoint.rsplit('/', 1)[1]
            if sha == fail_blob:
                raise m.MarketError('Synthetic connection failure')
            content = blobs[sha] + (b'tampered' if bad_blob else b'')
            return {'sha': sha, 'encoding': 'base64', 'content': base64.b64encode(content).decode()}
        return fetch

    def test_native_marketplace_contains_multiple_plugins(self):
        result = m.validate(self.root)
        self.assertEqual(result['plugins'], ['alpha-plugin', 'beta-plugin'])
        self.assertEqual(result['marketplace'], 'dfsc-community')

    def test_duplicate_ids_and_ambiguous_json_are_rejected(self):
        self.config['plugins'].append(copy.deepcopy(self.entry()))
        self.save()
        with self.assertRaisesRegex(m.MarketError, 'Duplicate plugin'):
            m.validate(self.root)
        (self.root / 'registry.json').write_text('{"schemaVersion":1,"schemaVersion":2}')
        with self.assertRaisesRegex(m.MarketError, 'Duplicate JSON key'):
            m.validate(self.root)

    def test_registry_cannot_read_outside_its_reviewed_directory(self):
        self.entry()['readme'] = '../outside.md'
        self.save()
        with self.assertRaises(m.MarketError):
            m.validate(self.root)

    def test_installed_resource_drift_and_unlisted_files_are_detected(self):
        target = self.root / 'plugins/alpha-plugin/commands/help.md'
        target.write_text('Unexpected modified command')
        with self.assertRaisesRegex(m.MarketError, 'resource drift'):
            m.validate(self.root)
        target.write_bytes(self.raw['alpha-plugin']['commands/help.md'])
        (target.parent / 'extra.md').write_text('Unreviewed resource')
        with self.assertRaisesRegex(m.MarketError, 'Unexpected or missing'):
            m.validate(self.root)

    def test_offline_sync_uses_only_existing_reviewed_bytes(self):
        outcome = m.sync(self.root, 'alpha-plugin', self.root / 'sources/alpha-plugin')
        self.assertEqual(outcome['synchronized'], ['alpha-plugin'])
        self.assertEqual((self.root / 'plugins/alpha-plugin/README.md').read_bytes(),
                         (self.root / self.entry()['readme']).read_bytes())
        self.assertEqual(m.validate(self.root)['plugins'], ['alpha-plugin', 'beta-plugin'])

    def test_offline_hash_mismatch_preserves_active_packages(self):
        before = self.active()
        (self.root / 'sources/alpha-plugin/commands/help.md').write_text('Modified upstream file')
        with self.assertRaisesRegex(m.MarketError, 'hash mismatch'):
            m.sync(self.root, 'alpha-plugin', self.root / 'sources/alpha-plugin')
        self.assertEqual(self.active(), before)

    def test_offline_directory_does_not_claim_a_different_commit(self):
        self.entry()['source']['commit'] = 'b' * 40
        self.save()
        with self.assertRaisesRegex(m.MarketError, 'matching reviewed source lock'):
            m.sync(self.root, 'alpha-plugin', self.root / 'sources/alpha-plugin')

    def test_symbolic_links_are_not_followed(self):
        path = self.root / 'sources/alpha-plugin/commands/help.md'
        path.unlink()
        try:
            path.symlink_to(self.root / 'registry.json')
        except OSError:
            self.skipTest('Host does not permit symlink fixtures')
        before = self.active()
        with self.assertRaisesRegex(m.MarketError, 'Symbolic links'):
            m.sync(self.root, 'alpha-plugin', self.root / 'sources/alpha-plugin')
        self.assertEqual(self.active(), before)

    def test_network_blob_tampering_and_partial_download_preserve_previous_version(self):
        before = self.active()
        with self.assertRaisesRegex(m.MarketError, 'hash mismatch'):
            m.sync(self.root, 'alpha-plugin', fetch=self.api(bad_blob=True))
        last_blob = hashes('step.plugin.json', self.raw['alpha-plugin']['step.plugin.json'])['gitBlobSha']
        with self.assertRaisesRegex(m.MarketError, 'Synthetic connection'):
            m.sync(self.root, 'alpha-plugin', fetch=self.api(fail_blob=last_blob))
        self.assertEqual(self.active(), before)

    def test_remote_path_escape_and_git_links_are_rejected(self):
        for extra in [
            {'path': 'resources/plugin/../escape', 'mode': '100644', 'type': 'blob'},
            {'path': 'resources/plugin/link', 'mode': '120000', 'type': 'blob'},
            {'path': 'resources/plugin/submodule', 'mode': '160000', 'type': 'commit'},
        ]:
            with self.subTest(extra=extra), self.assertRaises(m.MarketError):
                m.sync(self.root, 'alpha-plugin', fetch=self.api(tree_extra=[extra]))
        self.assertFalse((self.root / 'escape').exists())

    def test_network_update_is_pinned_and_preserves_other_plugins(self):
        beta = {p.name: p.read_bytes() for p in (self.root / 'plugins/beta-plugin').iterdir() if p.is_file()}
        self.entry()['source']['commit'] = 'b' * 40
        self.save()
        data = {**self.raw['alpha-plugin'], 'step.plugin.json':
                json.dumps({'id': 'alpha-plugin', 'version': '1.1.0', 'commands': ['commands']}).encode()}
        m.sync(self.root, 'alpha-plugin', fetch=self.api(data))
        updated = json.loads((self.root / 'registry.lock.json').read_text())
        self.assertEqual(next(p for p in updated['plugins'] if p['id'] == 'alpha-plugin')['source']['commit'], 'b' * 40)
        self.assertEqual(json.loads((self.root / 'plugins/alpha-plugin/step.plugin.json').read_text())['version'], '1.1.0')
        self.assertEqual(beta, {p.name: p.read_bytes() for p in (self.root / 'plugins/beta-plugin').iterdir() if p.is_file()})

    def test_write_failure_rolls_back_plugin_and_both_metadata_files(self):
        (self.root / self.entry()['readme']).write_text('New reviewed README\n')
        before = self.active()
        original = Path.replace
        failed = []
        def replace(path, target):
            if Path(target) == self.root / '.step-plugin/marketplace.json' and path.name.startswith('metadata-') and not failed:
                failed.append(True)
                raise OSError('Synthetic replacement failure')
            return original(path, target)
        with patch.object(Path, 'replace', replace), self.assertRaisesRegex(OSError, 'Synthetic replacement'):
            m.sync(self.root, 'alpha-plugin', self.root / 'sources/alpha-plugin')
        self.assertEqual(self.active(), before)
        self.assertFalse((self.root / '.community-sync.lock').exists())

    def test_unsupported_entry_and_outside_resource_declarations_are_rejected(self):
        for change in [{'entry': 'run.py'}, {'commands': ['../outside']}, {'mcpServers': '../mcp.json'}]:
            data = {**self.raw['alpha-plugin']}
            manifest = json.loads(data['step.plugin.json'])
            manifest.update(change)
            data['step.plugin.json'] = json.dumps(manifest).encode()
            with self.subTest(change=change), self.assertRaises(m.MarketError):
                m.sync(self.root, 'alpha-plugin', fetch=self.api(data))

    def test_case_collisions_and_private_state_are_rejected(self):
        for name in ['.env', 'model.json', 'commands/HELP.md']:
            data = {**self.raw['alpha-plugin'], name: b'fixture-only'}
            with self.subTest(name=name), self.assertRaises(m.MarketError):
                m.sync(self.root, 'alpha-plugin', fetch=self.api(data))

    def test_directory_case_collisions_do_not_merge_on_windows_or_macos(self):
        data = {**self.raw['alpha-plugin'], 'Commands/second.md': b'Another command'}
        before = self.active()
        with self.assertRaisesRegex(m.MarketError, 'Case-colliding resource path'):
            m.sync(self.root, 'alpha-plugin', fetch=self.api(data))
        self.assertEqual(self.active(), before)

    def test_windows_reserved_names_illegal_characters_and_private_case_are_rejected(self):
        before = self.active()
        invalid = ['.ENV', 'docs/.Env.Example', 'docs/MODEL.JSON', 'docs/HUMAN.JSON',
                   'docs/NUL.txt', 'docs/CoM1.md', 'docs/LPT9', 'docs/COM¹.md',
                   'docs/help.md.', 'docs/help.md ', 'docs/a?.md', 'docs/a*.md',
                   'docs/a<.md', 'docs/a>.md', 'docs/a|.md', 'docs/a".md', 'docs/a:stream']
        for name in invalid:
            data = {**self.raw['alpha-plugin'], name: b'Fixture resource'}
            with self.subTest(name=name), self.assertRaises(m.MarketError):
                m.sync(self.root, 'alpha-plugin', fetch=self.api(data))
        self.assertEqual(self.active(), before)

    def test_curated_readme_overlay_cannot_create_a_case_collision(self):
        data = {**self.raw['alpha-plugin']}
        data['readme.md'] = data.pop('README.md')
        before = self.active()
        with self.assertRaisesRegex(m.MarketError, 'Case-colliding resource path'):
            m.sync(self.root, 'alpha-plugin', fetch=self.api(data))
        self.assertEqual(self.active(), before)

    def test_optional_manifest_fields_follow_the_native_parser_types(self):
        before = self.active()
        for change in [{'name': 123}, {'name': None}, {'description': False},
                       {'description': ['unexpected']}, {'mcpServers': None}]:
            data = {**self.raw['alpha-plugin']}
            manifest = json.loads(data['step.plugin.json'])
            manifest.update(change)
            data['step.plugin.json'] = json.dumps(manifest).encode()
            with self.subTest(change=change), self.assertRaises(m.MarketError):
                m.sync(self.root, 'alpha-plugin', fetch=self.api(data))
        self.assertEqual(self.active(), before)

    def test_cli_does_not_expose_invalid_tokens_or_transport_header_errors(self):
        script = Path(__file__).resolve().parents[1] / 'scripts/sync-plugin.py'
        for token in ['fixture_secret_never_log\n', 'fixture_secret_never_log']:
            stdout, stderr = io.StringIO(), io.StringIO()
            with self.subTest(control_character=token.endswith('\n')), \
                    patch.dict(os.environ, {'GH_TOKEN': token}), \
                    patch.object(m.urllib.request, 'Request', side_effect=ValueError('Authorization: Bearer ' + token)) as request, \
                    patch.object(m.urllib.request, 'build_opener') as network, \
                    patch.object(sys, 'argv', [str(script), '--root', str(self.root), '--plugin', 'alpha-plugin']), \
                    patch.object(sys, 'path', [str(script.parent), *sys.path]), \
                    contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), \
                    self.assertRaises(SystemExit) as stopped:
                runpy.run_path(str(script), run_name='__main__')
            self.assertEqual(stopped.exception.code, 1)
            self.assertNotIn('fixture_secret_never_log', stdout.getvalue() + stderr.getvalue())
            self.assertNotIn('Traceback', stderr.getvalue())
            network.assert_not_called()
            if token.endswith('\n'):
                request.assert_not_called()

    def test_malformed_api_values_fail_without_displaying_response_contents(self):
        valid = self.api()
        before = self.active()
        for part in ('commit-tree', 'tree-path', 'blob-content'):
            def malformed(endpoint):
                value = valid(endpoint)
                if part == 'commit-tree' and '/commits/' in endpoint:
                    value['tree'] = ['fixture_private_response_never_log']
                if part == 'tree-path' and '/trees/' in endpoint:
                    value['tree'].append({'path': {'private': 'fixture_private_response_never_log'}})
                if part == 'blob-content' and '/blobs/' in endpoint:
                    value['content'] = {'private': 'fixture_private_response_never_log'}
                return value
            with self.subTest(part=part), self.assertRaises(m.MarketError) as stopped:
                m.sync(self.root, 'alpha-plugin', fetch=malformed)
            self.assertNotIn('fixture_private_response_never_log', str(stopped.exception))
        self.assertEqual(self.active(), before)

    def test_manifest_size_obeys_the_native_runtime_limit(self):
        data = {**self.raw['alpha-plugin']}
        data['step.plugin.json'] = json.dumps({'id': 'alpha-plugin', 'version': '1.0.0',
                                              'description': 'x' * (512 * 1024)}).encode()
        before = self.active()
        with self.assertRaisesRegex(m.MarketError, 'native parser limit'):
            m.sync(self.root, 'alpha-plugin', fetch=self.api(data))
        self.assertEqual(self.active(), before)


if __name__ == '__main__':
    unittest.main()
