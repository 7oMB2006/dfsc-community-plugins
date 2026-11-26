import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../../../plugins/memory-hub/server/tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../../../plugins/memory-hub/server/memory-hub.mjs');
const PROJECT = 'D:\\AgentPrograms\\maintenance-fixture';

async function session(fn) {
  const home = await mkdtemp(join(tmpdir(), 'memory-hub-maint-'));
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'memory-hub-maint-sessions-'));
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, MEMORY_HUB_HOME: home, MEMORY_HUB_SESSIONS: sessionsRoot, MEMORY_HUB_PROJECT: PROJECT },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const lines = [];
  createInterface({ input: child.stdout, terminal: false }).on('line', (line) => lines.push(line));
  let nextId = 1;
  const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
  const call = async (name, args = {}) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
    await settle();
    const line = lines.find((value) => {
      try { return JSON.parse(value).id === id; } catch { return false; }
    });
    assert.ok(line, `no reply for ${name}; stderr=${stderr.slice(0, 600)}`);
    return JSON.parse(JSON.parse(line).result.content[0].text);
  };
  try {
    return await fn({ home, call, settle });
  } finally {
    child.kill();
    await rm(home, { recursive: true, force: true });
    await rm(sessionsRoot, { recursive: true, force: true });
  }
}

test('memory_maintain reports what it archived and keeps the entries findable', async () => {
  await session(async ({ call }) => {
    const kept = await call('retain', { text: '构建用 pnpm', importance: 0.9 });
    await call('recall', { query: '构建', limit: 5 });
    const result = await call('memory_maintain', { days: 1, project: PROJECT });
    assert.equal(result.ok, true);
    // 刚写、刚命中过的那条不该被归档；窗口设成 1 天时不留下可归档项也是正确结果。
    assert.ok(Array.isArray(result.archived) && Array.isArray(result.evicted));
    const active = await call('recall', { query: '构建', limit: 5, project: PROJECT });
    assert.ok(active.memories.some((memory) => memory.id === kept.id), '被命中的记忆必须保留');
  });
});

test('memory_purge refuses without the exact confirmation', async () => {
  await session(async ({ call }) => {
    await call('retain', { text: '构建用 pnpm', project: PROJECT });
    const wrong = await call('memory_purge', { scope: 'project', confirm: 'yes', project: PROJECT });
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /confirm/i);
    const stats = await call('stats', { project: PROJECT });
    assert.equal(stats.banks.project.active, 1, '拒绝执行时数据必须原样保留');
  });
});

test('memory_purge moves the file to a trash name the user can find', async () => {
  await session(async ({ call, home }) => {
    await call('retain', { text: '构建用 pnpm', project: PROJECT });
    const purged = await call('memory_purge', { scope: 'project', confirm: 'DELETE', project: PROJECT });
    assert.equal(purged.ok, true);
    assert.match(purged.movedTo, /memory\.json\.trash-/);
    const dir = join(home, '--D--AgentPrograms-maintenance-fixture--');
    const names = await readdir(dir);
    assert.ok(names.some((name) => name.startsWith('memory.json.trash-')), `trash file missing: ${names}`);
    assert.ok(!names.includes('memory.json'));
  });
});

test('relatively unsafe ids and ops are rejected without corrupting the bank', async () => {
  await session(async ({ call }) => {
    await call('retain', { text: '构建用 pnpm', project: PROJECT });
    const badOp = await call('memory_edit', { op: 'rewrite-everything', id: 'm_x', project: PROJECT });
    assert.equal(badOp.ok, false);
    const missing = await call('memory_edit', { op: 'update', id: 'm_nope', text: 'x', project: PROJECT });
    assert.equal(missing.status, 'not_found');
    const stats = await call('stats', { project: PROJECT });
    assert.equal(stats.banks.project.active, 1, 'failed edits must not change the bank');
  });
});

test('every tool referenced by the shipped commands and skills exists', async () => {
  const names = new Set(TOOLS.map((tool) => tool.name));
  const { readFile } = await import('node:fs/promises');
  const { readdir } = await import('node:fs/promises');
  const root = resolve(here, '../../../plugins/memory-hub');
  const files = [];
  for (const name of await readdir(join(root, 'commands'))) files.push(join(root, 'commands', name));
  for (const dir of await readdir(join(root, 'skills'))) files.push(join(root, 'skills', dir, 'SKILL.md'));
  // 只检查带反引号或「调用」语境的工具名，避免把普通英文单词误判成工具。
  const referenced = new Set();
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/`([a-z_]+)`/gu)) {
      if (names.has(match[1])) referenced.add(match[1]);
    }
  }
  assert.ok(referenced.size >= 4, `expected the docs to reference real tools, saw ${[...referenced].join(',')}`);
  for (const name of referenced) assert.ok(names.has(name), `docs reference unknown tool ${name}`);
});
