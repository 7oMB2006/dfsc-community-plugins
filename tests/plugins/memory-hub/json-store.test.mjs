import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../../../plugins/memory-hub/server/json-store.mjs';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'memory-hub-store-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('mutate persists and read returns the written value', async () => {
  await withDir(async (dir) => {
    const store = new JsonStore(join(dir, 'memory.json'));
    await store.mutate(() => ({ result: 'ok', next: { items: [1, 2] } }));
    const read = await store.read();
    assert.equal(read.corrupt, false);
    assert.deepEqual(read.data, { items: [1, 2] });
  });
});

test('read reports a corrupt file without touching it', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    await writeFile(file, '{ broken json');
    const store = new JsonStore(file);
    const read = await store.read();
    assert.equal(read.corrupt, true);
    assert.equal(read.data, null);
    assert.equal(await readFile(file, 'utf8'), '{ broken json', 'read must not rewrite or remove the file');
  });
});

test('mutate backs up a corrupt file before rebuilding', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    await writeFile(file, 'not json');
    const store = new JsonStore(file);
    await store.mutate(() => ({ result: 1, next: { rebuilt: true } }));
    const names = await readdir(dir);
    assert.ok(names.some((name) => name.startsWith('memory.json.corrupt-')), `expected a backup, saw ${names}`);
    assert.deepEqual((await store.read()).data, { rebuilt: true });
  });
});

test('concurrent writers keep both changes', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    const a = new JsonStore(file);
    const b = new JsonStore(file);
    await Promise.all([
      a.mutate((data) => ({ result: null, next: { ...(data ?? {}), first: true } })),
      b.mutate((data) => ({ result: null, next: { ...(data ?? {}), second: true } })),
    ]);
    const read = await a.read();
    assert.deepEqual(read.data, { first: true, second: true });
  });
});

test('a stale lock is taken over instead of blocking forever', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    const store = new JsonStore(file, { staleMs: 5, lockTimeoutMs: 2000 });
    await writeFile(`${file}.lock`, '{"pid":1}');
    const start = Date.now();
    await store.mutate(() => ({ result: null, next: { ok: true } }));
    assert.ok(Date.now() - start < 1500, 'should not wait for the full timeout');
    assert.deepEqual((await store.read()).data, { ok: true });
  });
});

test('a live lock times out with a clear error', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    const store = new JsonStore(file, { staleMs: 60_000, lockTimeoutMs: 150 });
    await writeFile(`${file}.lock`, '{"pid":1}');
    await assert.rejects(store.mutate(() => ({ result: null, next: {} })), /lock timeout/i);
  });
});

test('a failed writer does not leave a lock behind', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    const store = new JsonStore(file);
    await assert.rejects(store.mutate(() => { throw new Error('boom'); }), /boom/);
    const names = await readdir(dir);
    assert.ok(!names.includes('memory.json.lock'), `lock leaked: ${names}`);
  });
});

test('read reflects a delete instead of serving the cached copy', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    const store = new JsonStore(file);
    await store.mutate(() => ({ result: null, next: { items: [1] } }));
    assert.deepEqual((await store.read()).data, { items: [1] });
    await rm(file);
    // 缓存不能盖过「文件已被删掉」这个事实，否则 purge 之后仍读到旧数据。
    const after = await store.read();
    assert.equal(after.data, null);
    assert.equal(after.corrupt, false);
  });
});

test('a failed write leaves the previous contents readable', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    const store = new JsonStore(file);
    await store.mutate(() => ({ result: null, next: { keep: true } }));
    await assert.rejects(store.mutate(() => { throw new Error('boom'); }), /boom/);
    assert.deepEqual((await store.read()).data, { keep: true }, 'a rejected mutation must not clobber the file');
  });
});

test('an oversized store is reported as corrupt rather than loaded', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    const store = new JsonStore(file, { maxBytes: 64 });
    await writeFile(file, JSON.stringify({ padding: 'x'.repeat(200) }));
    const read = await store.read();
    assert.equal(read.corrupt, true);
  });
});

test('mutate refuses to write more than the size limit', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    const store = new JsonStore(file, { maxBytes: 64 });
    await assert.rejects(store.mutate(() => ({ result: null, next: { padding: 'x'.repeat(200) } })), /over the .* byte limit/i);
    assert.equal(await readFile(file, 'utf8').catch(() => null), null, 'nothing is written when the guard trips');
  });
});

test('a corrupt backup name is remembered only until the next good write', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    await writeFile(file, 'garbage');
    const store = new JsonStore(file);
    const first = await store.read();
    assert.equal(first.corrupt, true);
    await store.mutate(() => ({ result: null, next: { rebuilt: 1 } }));
    const after = await store.read();
    assert.equal(after.corrupt, false);
    assert.equal(after.backup, null, 'stale backup names must not linger after a healthy write');
  });
});

test('inspect sees the file while holding the lock', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    const store = new JsonStore(file);
    await store.mutate(() => ({ result: null, next: { n: 1 } }));
    const seen = await store.inspect((parsed) => parsed.data);
    assert.deepEqual(seen, { n: 1 });
    // 文件不存在时回调收到 null：调用方要能区分「没有库」和「库是空的」
    const missing = await new JsonStore(join(dir, 'absent.json')).inspect((parsed) => parsed);
    assert.equal(missing, null);
  });
});
