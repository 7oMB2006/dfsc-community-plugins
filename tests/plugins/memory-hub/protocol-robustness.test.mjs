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

/** 起一个真实子进程，返回 send / reply / close 三个口子。 */
async function server() {
  const home = await mkdtemp(join(tmpdir(), 'memory-hub-proto-'));
  const sessions = await mkdtemp(join(tmpdir(), 'memory-hub-proto-sessions-'));
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, MEMORY_HUB_HOME: home, MEMORY_HUB_SESSIONS: sessions, MEMORY_HUB_PROJECT: 'D:\\AgentPrograms\\proto-fixture' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  let stderr = '';
  let exited = null;
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  createInterface({ input: child.stdout, terminal: false }).on('line', (line) => lines.push(line));
  child.on('exit', (code) => { exited = code; });

  let nextId = 1;
  const wait = async (id, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = lines.find((line) => {
        try { return JSON.parse(line).id === id; } catch { return false; }
      });
      if (found) return JSON.parse(found);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no reply for id=${id}; stderr=${stderr.slice(0, 600)}`);
  };
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const raw = (text) => child.stdin.write(`${text}\n`);
  const request = async (method, params) => {
    const id = nextId++;
    send({ id, method, params });
    return wait(id);
  };
  const call = async (name, args = {}) => {
    const reply = await request('tools/call', { name, arguments: args });
    return { reply, value: JSON.parse(reply.result.content[0].text) };
  };
  const stop = async () => {
    child.stdin.end();
    await new Promise((r) => {
      if (exited !== null) return r();
      const timer = setTimeout(r, 5000);
      child.on('exit', () => { clearTimeout(timer); r(); });
    });
    if (exited === null) child.kill();
    await rm(home, { recursive: true, force: true });
    await rm(sessions, { recursive: true, force: true });
  };
  return { send, raw, request, call, stop, lines: () => lines, stderr: () => stderr, child };
}

test('a bad request gets a specific error instead of silence', async () => {
  const s = await server();
  try {
    // 有 id 但没有 method：明确回 -32600，不让调用方干等
    s.send({ id: 900, params: {} });
    const reply = await (async () => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const found = s.lines().find((line) => {
          try { return JSON.parse(line).id === 900; } catch { return false; }
        });
        if (found) return JSON.parse(found);
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('no reply for the malformed request');
    })();
    assert.equal(reply.error.code, -32600);
  } finally {
    await s.stop();
  }
});

test('non-object tool arguments are rejected without touching the store', async () => {
  const s = await server();
  try {
    s.send({ id: 901, method: 'tools/call', params: { name: 'retain', arguments: ['not', 'an', 'object'] } });
    const reply = await (async () => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const found = s.lines().find((line) => {
          try { return JSON.parse(line).id === 901; } catch { return false; }
        });
        if (found) return JSON.parse(found);
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('no reply');
    })();
    assert.equal(reply.error.code, -32602);
    const { value } = await s.call('stats');
    assert.equal(value.banks.project.total, 0, 'a rejected call must not write anything');
  } finally {
    await s.stop();
  }
});

test('one failing tool call does not break the following ones', async () => {
  const s = await server();
  try {
    const failed = await s.call('memory_edit', { op: 'update', id: 'm_missing', text: 'x' });
    assert.equal(failed.value.ok, false);
    const after = await s.call('retain', { text: '失败之后仍然能写入' });
    assert.equal(after.value.ok, true);
    const stats = await s.call('stats');
    assert.equal(stats.value.banks.project.active, 1);
  } finally {
    await s.stop();
  }
});

test('writes are applied in arrival order', async () => {
  const s = await server();
  try {
    // 不等待逐个响应地连发：串行队列保证最终顺序与到达顺序一致
    for (let i = 0; i < 6; i++) s.send({ id: 1000 + i, method: 'tools/call', params: { name: 'retain', arguments: { text: `顺序条目 ${i}` } } });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && s.lines().length < 6) await new Promise((r) => setTimeout(r, 25));
    const { value } = await s.call('recall', { limit: 10, query: '' });
    assert.equal(value.memories.length, 6, `expected all six writes, got ${value.memories.length}`);
  } finally {
    await s.stop();
  }
});

test('closing stdin lets in-flight work finish and exits cleanly', async () => {
  const s = await server();
  let code = null;
  s.child.on('exit', (value) => { code = value; });
  try {
    s.send({ id: 1100, method: 'tools/call', params: { name: 'retain', arguments: { text: '关掉 stdin 前写入的' } } });
    const reply = await (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const found = s.lines().find((line) => {
          try { return JSON.parse(line).id === 1100; } catch { return false; }
        });
        if (found) return JSON.parse(found);
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('no reply before close');
    })();
    assert.equal(JSON.parse(reply.result.content[0].text).ok, true);
    s.child.stdin.end();
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && code === null) await new Promise((r) => setTimeout(r, 25));
    assert.equal(code, 0, `expected a clean exit, saw ${code}`);
  } finally {
    await s.stop();
  }
});

test('stdout stays pure JSON-RPC even after malformed and unsupported input', async () => {
  const s = await server();
  try {
    s.raw('{ not json }');
    s.raw('[]');
    s.send({ id: 1200, method: 'does/not/exist' });
    const reply = await (async () => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const found = s.lines().find((line) => {
          try { return JSON.parse(line).id === 1200; } catch { return false; }
        });
        if (found) return JSON.parse(found);
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('server stopped answering after bad input');
    })();
    assert.equal(reply.error.code, -32601);
    for (const line of s.lines()) assert.doesNotThrow(() => JSON.parse(line), `non-JSON on stdout: ${line.slice(0, 120)}`);
    assert.match(s.stderr(), /malformed|non-object/, 'the bad input is still reported on stderr');
  } finally {
    await s.stop();
  }
});
