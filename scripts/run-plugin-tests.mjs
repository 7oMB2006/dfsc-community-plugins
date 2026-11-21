#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = /^[0-9a-f]{40}$/;
const pluginId = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const catalogs = new Map([
  ['registry.json', 'id'],
  ['registry.lock.json', 'id'],
  ['.step-plugin/marketplace.json', 'name'],
]);

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function scriptId(name) {
  const id = name.startsWith('test:') ? name.slice(5) : '';
  return pluginId.test(id) && id !== 'plugins' ? id : null;
}

function catalogParts({ plugins, ...shared }, key) {
  if (!Array.isArray(plugins)) throw new Error('Expected a plugins array in marketplace catalog.');
  return [shared, new Map(plugins.map((entry) => [entry[key], entry]))];
}

function manifestParts({ scripts = {}, ...shared }, knownIds) {
  const perPlugin = new Map();
  const sharedScripts = new Map();
  for (const [name, command] of Object.entries(scripts)) {
    const id = scriptId(name);
    if (knownIds.has(id)) perPlugin.set(id, command);
    else sharedScripts.set(name, command);
  }
  return [{ ...shared, scripts: sharedScripts }, perPlugin];
}

function noteChangedEntries(affected, [oldShared, oldEntries], [newShared, newEntries]) {
  if (!isDeepStrictEqual(oldShared, newShared)) return false;
  for (const id of new Set([...oldEntries.keys(), ...newEntries.keys()])) {
    if (!isDeepStrictEqual(oldEntries.get(id), newEntries.get(id))) affected.add(id);
  }
  return true;
}

function verifyComparison(root, base, prHead) {
  if (!sha.test(base)) throw new Error('--base must be a full SHA.');
  if (prHead) {
    // Read the raw parent headers; a depth-one checkout may hide parents in history commands.
    const head = git(root, 'cat-file', 'commit', 'HEAD').split('\n\n', 1)[0];
    const parents = [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((match) => match[1]);
    if (!isDeepStrictEqual(parents, [base, prHead])) {
      throw new Error('PR merge snapshot does not match main and the reviewed PR head. No suites ran.');
    }
    console.log(`Testing merge ${git(root, 'rev-parse', 'HEAD').trim()} (main ${base}, PR head ${prHead})`);
  } else if (!git(root, 'rev-list', '--first-parent', 'HEAD').split(/\s+/).includes(base)) {
    throw new Error('--base must be a full SHA on the first-parent history of HEAD.');
  }
  if (git(root, 'status', '--porcelain', '--untracked-files=all')) {
    throw new Error('--base requires a clean checkout so the executed files match HEAD.');
  }
}

function affectedPlugins(root, base) {
  const paths = git(root, 'diff', '--no-renames', '--name-only', '-z', base, 'HEAD', '--').split('\0').filter(Boolean);
  const affected = new Set();
  const snapshots = (path) => [base, 'HEAD'].map((revision) => JSON.parse(git(root, 'show', `${revision}:${path}`)));

  for (const path of paths) {
    const scoped = /^(?:plugins|tests\/plugins)\/([^/]+)\//.exec(path);
    if (scoped) {
      affected.add(scoped[1]);
    } else if (catalogs.has(path)) {
      if (!noteChangedEntries(affected, ...snapshots(path).map((doc) => catalogParts(doc, catalogs.get(path))))) {
        return null;
      }
    } else if (path === 'package.json') {
      const knownIds = new Set(snapshots('registry.json').flatMap((doc) => doc.plugins.map(({ id }) => id)));
      if (!noteChangedEntries(affected, ...snapshots(path).map((doc) => manifestParts(doc, knownIds)))) {
        return null;
      }
    } else if (!/^(?:(?:README|CONTRIBUTING|AGENTS)\.md|docs\/.+\.md|\.github\/PULL_REQUEST_TEMPLATE\.md)$/.test(path)) {
      // Unknown paths and shared code may affect every suite.
      return null;
    }
  }
  return affected;
}

function suiteEnvironment() {
  const allowed = /^(?:path|pathext|systemroot|windir|comspec|tmp|temp|tmpdir|lang|lc_all)$/i;
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.test(name))), CI: 'true' };
}

function runSuite(root, command, timeout) {
  const windows = process.platform === 'win32';
  return new Promise((done, reject) => {
    let timedOut = false;
    let cleanupError;
    const child = spawn(command, {
      cwd: root, stdio: 'inherit', shell: true, detached: !windows, env: suiteEnvironment(),
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (windows) {
          const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
          execFileSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch (error) {
        if (error.code !== 'ESRCH' && child.exitCode === null && child.signalCode === null) {
          cleanupError = error;
          child.kill('SIGKILL');
        }
      }
    }, timeout);
    const finish = (status, code) => {
      clearTimeout(timer);
      if (cleanupError) reject(new Error('Could not terminate the timed-out process tree.'));
      else done({ status, code });
    };
    child.once('error', () => finish('failed', null));
    child.once('close', (code) => finish(timedOut ? 'timed-out' : code === 0 ? 'passed' : 'failed', code));
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' }, all: { type: 'boolean' },
      checkout: { type: 'string' }, 'pr-head': { type: 'string' },
      'timeout-ms': { type: 'string', default: '120000' },
    },
  });
  const timeout = Number(values['timeout-ms']);
  if (Boolean(values.base) === Boolean(values.all) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000) {
    throw new Error('Select exactly one of --base <ancestor SHA> or --all; --timeout-ms must be 1-300000.');
  }
  const prHead = values['pr-head'];
  if ((values.checkout !== undefined || prHead !== undefined) && (!values.checkout || !values.base || !sha.test(prHead ?? ''))) {
    throw new Error('PR mode requires --checkout <path>, --base <main SHA> and --pr-head <reviewed SHA>.');
  }
  const root = values.checkout ? resolve(values.checkout) : runnerRoot;
  if (values.base) verifyComparison(root, values.base, prHead);
  const readJson = async (file) => JSON.parse(await readFile(join(root, file), 'utf8'));
  const [manifest, registry] = await Promise.all([readJson('package.json'), readJson('registry.json')]);
  if (!Array.isArray(registry?.plugins)) throw new Error('Invalid registry.json: expected a plugins array.');
  const affected = values.all ? null : affectedPlugins(root, values.base);

  const ran = [];
  const skipped = [];
  for (const { id } of registry.plugins) {
    const name = `test:${id}`;
    const command = manifest.scripts?.[name];
    if (scriptId(name) !== id || typeof command !== 'string' || !command.trim()) {
      skipped.push({ plugin: id, reason: 'no-suite' });
    } else if (affected && !affected.has(id)) {
      skipped.push({ plugin: id, reason: 'unchanged' });
    } else {
      console.log(`Running ${name} (timeout: ${timeout} ms)`);
      try {
        ran.push({ plugin: id, script: name, ...await runSuite(root, command, timeout) });
      } catch (error) {
        throw new Error(`${name}: ${error.message}`, { cause: error });
      }
    }
  }

  const failed = ran.filter(({ status }) => status !== 'passed').map(({ plugin }) => plugin);
  console.log(JSON.stringify({
    scope: affected ? [...affected].sort() : 'all',
    ran, skipped, failed,
    ...(ran.length === 0 && { reason: skipped.some(({ reason }) => reason === 'unchanged') ? 'no-affected-suites' : 'no-registered-suites' }),
  }));
  if (failed.length) {
    console.error(`Plugin test failed: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Plugin test run failed: ${error.message}`);
  process.exitCode = 1;
});
