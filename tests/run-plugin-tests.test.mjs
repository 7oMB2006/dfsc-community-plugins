// Verify scripts/run-plugin-tests.mjs: the runner decides which plugin suites CI
// executes, so its selection and failure reporting are tested directly.
//
// Each case builds a temporary repository-shaped directory and executes the real
// runner there, so behaviour (not a stub) is under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runner = resolve(here, '../scripts/run-plugin-tests.mjs');
const runnerSource = await readFile(runner, 'utf8');

const registry = (...ids) => ({
  schemaVersion: 1,
  marketplaceName: 'dfsc-community',
  plugins: ids.map((id) => ({ id })),
});

/** Run the real runner inside a temporary repository-shaped directory. */
async function run({ package: manifest = {}, plugins = [] }) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-tests-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts', 'run-plugin-tests.mjs'), runnerSource);
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2));
    await writeFile(join(root, 'registry.json'), JSON.stringify(registry(...plugins), null, 2));
    return runIn(root, ['--all']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runIn(root, args, entry = join(root, 'scripts', 'run-plugin-tests.mjs'), nodeOptions = []) {
  const result = spawnSync(process.execPath, [...nodeOptions, entry, ...args], {
    cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, DFSC_FIXTURE_SECRET: 'fixture-value' },
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function report({ stdout, stderr }) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Missing or invalid runner report\nstdout: ${stdout}\nstderr: ${stderr}`, { cause: error });
  }
}

const manifest = { scripts: { 'test:alpha': 'node -e "process.exit(0)"', 'test:beta': 'node -e "process.exit(0)"' } };

async function withSnapshots(testCase) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-scope-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=.disabled-hooks',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
  const put = async (path, content) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof content === 'string' ? content : JSON.stringify(content));
  };
  const commit = () => {
    git('add', '--all');
    git('commit', '-qm', 'test fixture', '--no-gpg-sign');
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q');
    await put('scripts/run-plugin-tests.mjs', runnerSource);
    await put('registry.json', registry('alpha', 'beta'));
    await put('registry.lock.json', registry('alpha', 'beta'));
    await put('.step-plugin/marketplace.json', { plugins: [{ name: 'alpha' }, { name: 'beta' }] });
    await put('package.json', manifest);
    const base = commit();
    await testCase({ root, put, commit, base, git });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('no registered plugins is a successful no-op', async () => {
  // This is the normal state before the first plugin-with-tests PR merges.
  const out = await run({ package: { scripts: { test: 'node --test' } }, plugins: [] });
  assert.equal(out.code, 0, `expected success, got ${out.code}: ${out.stderr}`);
  assert.match(out.stdout, /"ran":\[\]/);
});

test('plugins without a matching script do not fail the step', async () => {
  const out = await run({ package: { scripts: {} }, plugins: ['alpha', 'beta'] });
  assert.equal(out.code, 0, `missing scripts must not fail: ${out.stderr}`);
  assert.match(out.stdout, /"ran":\[\]/);
});

test('only scripts of registered plugins are executed', async () => {
  const out = await run({
    package: {
      scripts: {
        'test:alpha': 'node -e "console.log(1)"',
        'test:fixtures': 'node -e "process.exit(7)"',
        'test:not-registered': 'node -e "process.exit(8)"',
      },
    },
    plugins: ['alpha'],
  });
  assert.equal(out.code, 0, `unrelated scripts must not run: ${out.stderr}`);
  assert.match(out.stdout, /"plugin":"alpha"/);
  assert.doesNotMatch(out.stdout, /fixtures|not-registered/);
});

test('marketplace ids with underscores work, but the runner name is reserved', async () => {
  const out = await run({
    package: { scripts: { 'test:alpha_team': 'node -e "process.exit(0)"', 'test:plugins': 'node -e "process.exit(8)"' } },
    plugins: ['alpha_team', 'plugins'],
  });
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(report(out).ran.map(({ plugin }) => plugin), ['alpha_team']);
  assert.deepEqual(report(out).skipped, [{ plugin: 'plugins', reason: 'no-suite' }]);
});

test('a failing suite fails the step and names the plugin', async () => {
  const out = await run({
    package: { scripts: { 'test:alpha': 'node -e "process.exit(3)"' } },
    plugins: ['alpha'],
  });
  assert.notEqual(out.code, 0, 'a failing plugin suite must fail the step');
  assert.match(out.stdout, /"failed":\["alpha"\]/);
});

test('multiple plugins are all run and reported individually', async () => {
  const out = await run({
    package: {
      scripts: {
        'test:alpha': 'node -e "process.exit(1)"',
        'test:beta': 'node -e "process.exit(0)"',
      },
    },
    plugins: ['alpha', 'beta'],
  });
  assert.notEqual(out.code, 0);
  assert.match(out.stdout, /"plugin":"alpha"[^}]*"code":1/, 'alpha failure must be recorded');
  assert.match(out.stdout, /"plugin":"beta"[^}]*"code":0/, 'beta must still run');
});

test('a suite can log without a newline while stdout stays a single JSON report', async () => {
  const out = await run({
    package: { scripts: { 'test:alpha': 'node -e "process.stdout.write(\'partial suite log\')"' } },
    plugins: ['alpha'],
  });
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(report(out).ran.map(({ plugin, status }) => [plugin, status]), [['alpha', 'passed']]);
  assert.match(out.stderr, /Running test:alpha/);
  assert.match(out.stderr, /partial suite log/);
});

test('an unreadable registry fails instead of silently skipping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-tests-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts', 'run-plugin-tests.mjs'), runnerSource);
    await writeFile(join(root, 'package.json'), '{"scripts":{}}');
    await writeFile(join(root, 'registry.json'), '{ not json');
    assert.notEqual(runIn(root, ['--all']).code, 0, 'an unreadable registry must not pass silently');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('market documentation alone skips every configured suite', async () => withSnapshots(async ({ root, put, commit, base }) => {
  await put('README.md', 'Marketplace notes');
  await put('docs/plugins/alpha.md', 'Author attribution');
  commit();
  const out = runIn(root, ['--base', base]);
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(report(out), {
    scope: [], ran: [], skipped: [{ plugin: 'alpha', reason: 'unchanged' }, { plugin: 'beta', reason: 'unchanged' }],
    failed: [], reason: 'no-affected-suites',
  });
}));

test('runtime Markdown and owned tests select their plugin, even with spaces and non-ASCII paths', async () => withSnapshots(async ({ root, put, commit, base }) => {
  let compare = base;
  for (const path of ['plugins/alpha/skills/\u6280\u80fd a/SKILL.md', 'tests/plugins/alpha/fixture.mjs']) {
    await put(path, 'Changed fixture');
    const head = commit();
    const out = report(runIn(root, ['--base', compare]));
    assert.deepEqual(out.scope, ['alpha']);
    assert.deepEqual(out.ran.map(({ plugin, status }) => [plugin, status]), [['alpha', 'passed']]);
    compare = head;
  }
}));

test('registry, lock, catalog and test entry changes are attributed per plugin', async () => withSnapshots(async ({ root, put, commit, base }) => {
  let compare = base;
  for (const [path, contents] of [
    ['registry.json', { ...registry(), plugins: [{ id: 'alpha', description: 'new' }, { id: 'beta' }] }],
    ['registry.lock.json', { ...registry(), plugins: [{ id: 'alpha', files: [] }, { id: 'beta' }] }],
    ['.step-plugin/marketplace.json', { plugins: [{ name: 'alpha', description: 'new' }, { name: 'beta' }] }],
    ['package.json', { scripts: { ...manifest.scripts, 'test:alpha': 'node -e "console.log(42)"' } }],
  ]) {
    await put(path, contents);
    const head = commit();
    const out = report(runIn(root, ['--base', compare]));
    assert.deepEqual(out.scope, ['alpha'], path);
    assert.deepEqual(out.ran.map(({ plugin }) => plugin), ['alpha'], path);
    compare = head;
  }
}));

test('shared tooling or scripts broaden the run to all registered suites', async () => withSnapshots(async ({ root, put, commit, base }) => {
  await put('package.json', { scripts: { ...manifest.scripts, 'test:fixtures': 'unused' } });
  const sharedScript = commit();
  const fromSharedScript = report(runIn(root, ['--base', base]));
  await put('scripts/shared.mjs', '// changed');
  commit();
  for (const out of [fromSharedScript, report(runIn(root, ['--base', sharedScript]))]) {
    assert.equal(out.scope, 'all');
    assert.deepEqual(out.ran.map(({ plugin }) => plugin), ['alpha', 'beta']);
  }
}));

test('no implicit all execution; scoped runs reject non-history SHAs and dirty checkouts', async () => withSnapshots(async ({ root, put, base }) => {
  for (const args of [[], ['--base', 'HEAD'], ['--base', 'a'.repeat(40)], ['--base', base, '--all']]) {
    assert.equal(runIn(root, args).code, 1, args.join(' '));
  }
  await put('package.json', { scripts: { 'test:alpha': 'node -e "process.exit(8)"' } });
  const out = runIn(root, ['--base', base]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /clean checkout/);
}));

function checkOutMerge(git, base, head) {
  const merge = git('commit-tree', `${head}^{tree}`, '-p', base, '-p', head, '-m', 'PR merge fixture');
  git('checkout', '--quiet', '--detach', merge);
  return merge;
}

function runReviewed(root, base, head, nodeOptions) {
  return runIn(root, ['--checkout', root, '--base', base, '--pr-head', head], runner, nodeOptions);
}

test('reviewed merge runs only the affected suite against candidate code and detects a regression', async () => withSnapshots(async ({ root, put, commit, git }) => {
  await put('tests/plugins/alpha/suite.mjs', 'import "../../../plugins/alpha/state.mjs";');
  await put('plugins/alpha/state.mjs', 'process.exit(0);');
  await put('package.json', { scripts: { ...manifest.scripts, 'test:alpha': 'node tests/plugins/alpha/suite.mjs' } });
  const base = commit();
  await put('plugins/alpha/state.mjs', 'process.exit(4);');
  const head = commit();
  const merge = checkOutMerge(git, base, head);
  git('clone', '--quiet', '--no-local', '--depth', '2', '.', 'shallow');
  const out = runReviewed(join(root, 'shallow'), base, head);
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, new RegExp(`Testing merge ${merge} .*PR head ${head}`));
  assert.deepEqual(report(out).ran.map(({ plugin, status, code }) => [plugin, status, code]), [['alpha', 'failed', 4]]);
  assert.deepEqual(report(out).skipped, [{ plugin: 'beta', reason: 'unchanged' }]);
}));

test('reviewed PR mode rejects the raw head or a merge with different parents before running commands', async () => withSnapshots(async ({ root, put, commit, base, git }) => {
  await put('package.json', { scripts: { ...manifest.scripts, 'test:alpha': 'node -e "console.log(123456789)"' } });
  const head = commit();
  const raw = runReviewed(root, base, head);
  assert.equal(raw.code, 1);
  assert.match(raw.stderr, /merge snapshot does not match/);
  checkOutMerge(git, base, head);
  for (const [main, reviewed] of [[head, head], [base, base]]) {
    const stale = runReviewed(root, main, reviewed);
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /No suites ran/);
    assert.equal(stale.stdout, '');
    assert.doesNotMatch(stale.stderr, /123456789|Running test:/);
  }
}));

test('reviewed PR uses the trusted runner and does not load the candidate runner', async () => withSnapshots(async ({ root, put, commit, base, git }) => {
  await put('scripts/run-plugin-tests.mjs', 'throw new Error("candidate runner was loaded");');
  const head = commit();
  checkOutMerge(git, base, head);
  const out = runReviewed(root, base, head);
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(report(out).ran.map(({ plugin, status }) => [plugin, status]), [['alpha', 'passed'], ['beta', 'passed']]);
}));

test('reviewed PR starts Git from the trusted directory, not the candidate', async () => withSnapshots(async ({ root, put, commit, base, git }) => {
  await put('README.md', 'Documentation-only candidate');
  const head = commit();
  checkOutMerge(git, base, head);
  const trustedRoot = resolve(here, '..');

  for (const configuredGit of ['', join(trustedRoot, 'fixture-git')]) {
    // Inspect how Git is launched without placing an executable in the candidate.
    const probe = `
      import assert from 'node:assert/strict';
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      process.env.DFSC_PLUGIN_TEST_GIT = ${JSON.stringify(configuredGit)};
      const { execFileSync } = childProcess;
      childProcess.execFileSync = (file, args, options) => {
        assert.equal(options.cwd, ${JSON.stringify(trustedRoot)}, 'Git must start outside the candidate');
        assert.deepEqual(args.slice(0, 2), ['-C', ${JSON.stringify(root)}]);
        assert.equal(file, ${JSON.stringify(configuredGit || 'git')});
        return execFileSync('git', args, options);
      };
      syncBuiltinESMExports();
    `;
    const out = runReviewed(root, base, head, ['--import', `data:text/javascript,${encodeURIComponent(probe)}`]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(report(out).reason, 'no-affected-suites');
  }
}));

test('timeout stops the process tree and a later suite still runs without unrelated env vars', async () => withSnapshots(async ({ root, put }) => {
  await put('package.json', {
    scripts: { 'test:alpha': 'node parent.mjs', 'test:beta': 'node -e "process.exit(Number(!!process.env.DFSC_FIXTURE_SECRET))"' },
  });
  await put('parent.mjs', `
    import { spawn } from 'node:child_process';
    spawn(process.execPath, ['child.mjs'], { stdio: 'ignore' });
    process.stdout.write('started suite without newline');
    setTimeout(() => {}, 12000);
  `);
  await put('child.mjs', `
    import { existsSync, writeFileSync } from 'node:fs';
    writeFileSync('started', '');
    const probe = setInterval(() => {
      if (existsSync('probe')) {
        writeFileSync('leaked', '');
        clearInterval(probe);
      }
    }, 25);
    setTimeout(() => clearInterval(probe), 12000).unref();
  `);
  let out;
  try {
    out = runIn(root, ['--all', '--timeout-ms', '1600']);
  } finally {
    // Ask any surviving grandchild to prove that it was still running after cleanup.
    await put('probe', '');
  }
  assert.equal(out.code, 1, out.stderr);
  assert.deepEqual(report(out).ran.map(({ plugin, status }) => [plugin, status]), [['alpha', 'timed-out'], ['beta', 'passed']]);
  assert.match(out.stderr, /started suite without newline/);
  assert.equal(await readFile(join(root, 'started'), 'utf8'), '');
  await delay(800);
  await assert.rejects(readFile(join(root, 'leaked')), { code: 'ENOENT' });
}));
