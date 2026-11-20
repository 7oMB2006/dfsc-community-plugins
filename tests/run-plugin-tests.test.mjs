// Verify scripts/run-plugin-tests.mjs: the runner decides which plugin suites CI
// executes, so its selection and failure reporting are tested directly.
//
// Each case builds a temporary repository-shaped directory and executes the real
// runner there, so behaviour (not a stub) is under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'run-plugin-tests.mjs')], {
      cwd: root, encoding: 'utf8', timeout: 120000,
    });
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
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

test('an unreadable registry fails instead of silently skipping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-tests-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts', 'run-plugin-tests.mjs'), runnerSource);
    await writeFile(join(root, 'package.json'), '{"scripts":{}}');
    await writeFile(join(root, 'registry.json'), '{ not json');
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'run-plugin-tests.mjs')], {
      cwd: root, encoding: 'utf8', timeout: 120000,
    });
    assert.notEqual(result.status, 0, 'an unreadable registry must not pass silently');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
