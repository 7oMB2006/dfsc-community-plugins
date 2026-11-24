import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../../../plugins/memory-hub/server/memory-hub.mjs');

test('the server speaks JSON-RPC over stdio and exposes the memory tools', async () => {
  const home = await mkdtemp(join(tmpdir(), 'memory-hub-protocol-'));
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, MEMORY_HUB_HOME: home, MEMORY_HUB_PROJECT: 'D:\\AgentPrograms\\protocol-fixture' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  let stderr = '';
  let failure;
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  createInterface({ input: child.stdout, terminal: false }).on('line', (line) => lines.push(line));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
  const reply = (id) => {
    const found = lines.find((line) => {
      try { return JSON.parse(line).id === id; } catch { return false; }
    });
    assert.ok(found, `no reply for id=${id}; stderr=${stderr.slice(0, 500)}`);
    return JSON.parse(found);
  };

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    await settle();
    const init = reply(1);
    assert.equal(init.result.serverInfo.name, 'memory-hub');
    assert.ok(init.result.capabilities.tools, 'declares the tools capability');

    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await settle();
    const names = reply(2).result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['history_digest', 'memory_edit', 'memory_maintain', 'memory_purge', 'recall', 'reflect', 'retain', 'stats']);
    for (const tool of reply(2).result.tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} needs an object schema`);
    }

    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'retain', arguments: { text: '构建用 pnpm' } } });
    await settle();
    const retained = JSON.parse(reply(3).result.content[0].text);
    assert.equal(retained.ok, true);
    assert.equal(retained.action, 'added');

    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'recall', arguments: { query: '构建' } } });
    await settle();
    const recalled = JSON.parse(reply(4).result.content[0].text);
    assert.equal(recalled.memories.length, 1);
    assert.equal(recalled.project.slug, '--D--AgentPrograms-protocol-fixture--');

    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    await settle();
    assert.ok(reply(5).error || reply(5).result?.isError, 'unknown tools are rejected');

    send({ jsonrpc: '2.0', id: 6, method: 'does/not/exist' });
    await settle();
    assert.equal(reply(6).error.code, -32601);

    child.stdin.write('{ not json }\n');
    await settle();
    send({ jsonrpc: '2.0', id: 7, method: 'ping' });
    await settle();
    assert.ok(reply(7), 'a malformed line does not kill the server');

    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `stdout stayed clean, saw: ${line.slice(0, 120)}`);
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    child.kill();
    await rm(home, { recursive: true, force: true });
    if (failure) process.stderr.write(stderr);
  }
});

test('an unknown project argument falls back instead of writing outside the home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'memory-hub-protocol-'));
  // 隔离会话根：否则服务会从本机真实会话探测出项目，fallback 分支根本不会走到。
  const sessions = await mkdtemp(join(tmpdir(), 'memory-hub-sessions-'));
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, MEMORY_HUB_HOME: home, MEMORY_HUB_SESSIONS: sessions },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  createInterface({ input: child.stdout, terminal: false }).on('line', (line) => lines.push(line));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
  const reply = (id) => {
    const found = lines.find((line) => {
      try { return JSON.parse(line).id === id; } catch { return false; }
    });
    assert.ok(found, `no reply for id=${id}`);
    return JSON.parse(found);
  };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'stats', arguments: { project: '../escape' } } });
    await settle();
    const stats = JSON.parse(reply(1).result.content[0].text);
    assert.equal(stats.project.slug, '_default');
    assert.equal(stats.project.source, 'fallback');
    assert.equal(stats.storage.project.startsWith(home), true, 'storage stays inside MEMORY_HUB_HOME');
  } finally {
    child.kill();
    await rm(home, { recursive: true, force: true });
    await rm(sessions, { recursive: true, force: true });
  }
});
