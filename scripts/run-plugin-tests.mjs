#!/usr/bin/env node
// Run the per-plugin test suites that this repository has registered.
//
// The community marketplace hosts plugins from many authors; each may ship its
// own verification suite, exposed as a `test:<plugin-id>` npm script next to the
// vendored resources. This runner executes exactly the ones registered in
// `registry.json`, so:
//
//   - a repository with no plugin tests (before the first such PR merges) is a
//     successful no-op instead of a missing-script failure;
//   - helper scripts such as `test:fixtures` are never run implicitly, because
//     their name does not match a reviewed registry entry;
//   - a directory cannot add CI work by naming alone.
//
// Every selected suite runs so CI reports all failures at once. The commands
// come from the reviewed package.json, the same trust boundary as `npm test`.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

async function main() {
  let manifest;
  let registry;
  try {
    manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    registry = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'));
  } catch {
    console.error('Plugin test run failed: package.json or registry.json is unreadable.');
    process.exitCode = 1;
    return;
  }

  const scripts = manifest?.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
  const ids = Array.isArray(registry?.plugins)
    ? registry.plugins.map((item) => item?.id).filter((id) => typeof id === 'string' && id)
    : [];
  const selected = ids.filter((id) => typeof scripts['test:' + id] === 'string'
    && scripts['test:' + id].trim());

  if (selected.length === 0) {
    console.log(JSON.stringify({ ran: [], skipped: 'no plugin test scripts are registered' }));
    return;
  }

  const results = [];
  for (const id of selected) {
    const name = 'test:' + id;
    // Run the command directly rather than via `npm run`: spawning npm.cmd
    // without a shell fails on Windows, and the command text here is already
    // the reviewed script body.
    const code = await new Promise((resolveCode) => {
      const child = spawn(scripts[name], { cwd: root, stdio: 'inherit', shell: true, env: process.env });
      child.on('error', () => resolveCode(1));
      child.on('close', (exitCode) => resolveCode(typeof exitCode === 'number' ? exitCode : 1));
    });
    results.push({ plugin: id, script: name, code });
  }

  const failed = results.filter((result) => result.code !== 0);
  console.log(JSON.stringify({ ran: results, failed: failed.map((result) => result.plugin) }));
  if (failed.length) {
    console.error(`Plugin test failed: ${failed.map((result) => result.plugin).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch(() => {
  // Do not echo child output through the error path: it is author-controlled.
  console.error('Plugin test run failed: inspect the failing plugin script output above.');
  process.exitCode = 1;
});
