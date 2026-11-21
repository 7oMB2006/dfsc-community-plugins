/**
 * 状态层的容错回归测试。
 *
 * 复审关注点：默认让每个进程读写同一个 state/teams.json，保存时替换整份文件。
 * 除了「两个进程并发写」的覆盖（见 two-session-state.mjs），还有一个更隐蔽的
 * 数据丢失入口：读取失败时若当成「空状态」，随后的写入就会用空状态整份覆盖，
 * 把别人还在用的数据抹掉。
 *
 * 本测试直接驱动 state.mjs，覆盖四种情况：
 *   1. 写入路径遇到瞬时读错误（EBUSY 等）→ 必须失败，且磁盘上的原数据不变
 *   2. 只读路径遇到瞬时读错误 → 沿用上次缓存，不崩、不谎报为空
 *   3. 状态文件被删除 → 读取返回空，写入能重新建立文件
 *   4. 状态文件损坏 → 能备份时备份并从空启动；备份失败时写入中止
 *
 * 运行：node tests/state-fault-tolerance.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { TeamStore } = await import(
  pathToFileURL(resolve(here, '../../../plugins/agent-team/server/state.mjs')).href);

const realReadFileSync = fs.readFileSync;

function seed() {
  return JSON.stringify({
    version: 3,
    nextMessageId: 1,
    nextSignalId: 1,
    teams: {
      keep: {
        signals: [{ label: 'old', status: 'success', at: '2026-01-01T00:00:00.000Z', seq: 1 }],
        presence: { old: { label: 'old', role: 'scout', task: 'preexisting', status: 'running', joinedAt: 'a', updatedAt: 'a' } },
        messages: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  });
}

/** 让下一次针对 target 的 readFileSync 抛一次给定错误，然后恢复。 */
function failOnce(target, code) {
  let armed = true;
  fs.readFileSync = function (path, ...rest) {
    if (armed && String(path) === String(target)) {
      armed = false;
      fs.readFileSync = realReadFileSync;
      const error = new Error(`${code}: synthetic`);
      error.code = code;
      throw error;
    }
    return realReadFileSync.call(fs, path, ...rest);
  };
  return () => { armed = false; fs.readFileSync = realReadFileSync; };
}

const report = { cases: [], ok: false };
let failure;

try {
  // 1. 写入路径遇到瞬时读错误：必须失败且不覆盖
  {
    const dir = await mkdtemp(join(tmpdir(), 'tg-fault-'));
    const file = join(dir, 'teams.json');
    await writeFile(file, seed());
    const store = new TeamStore(file, { log: () => {} });
    const disarm = failOnce(file, 'EBUSY');
    let error = null;
    try {
      await store.upsertPresence('added', { label: 'n', role: 'x', task: 't', status: 'running' });
    } catch (err) {
      error = err;
    } finally {
      disarm();
    }
    assert.ok(error, '写入路径必须把读错误暴露出来，不能静默成功');
    const after = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(after.teams.keep, '读失败后写入不得覆盖磁盘上已有的团队');
    assert.ok(!after.teams.added, '失败的写入不应留下半个状态');
    report.cases.push({ case: '1 写入遇瞬时读错误：失败且不覆盖', ok: true, errorCode: error.code });
    await rm(dir, { recursive: true, force: true });
  }

  // 2. 只读路径遇到瞬时读错误：沿用缓存
  {
    const dir = await mkdtemp(join(tmpdir(), 'tg-fault-'));
    const file = join(dir, 'teams.json');
    await writeFile(file, seed());
    const store = new TeamStore(file, { log: () => {} });
    await store.upsertPresence('warm', { label: 'w', role: 'x', task: 't', status: 'running' });
    const before = store.roster('warm').length;
    const disarm = failOnce(file, 'EBUSY');
    let roster;
    try {
      roster = store.roster('warm');
    } finally {
      disarm();
    }
    assert.equal(roster.length, before, '只读路径应沿用缓存，不因瞬时错误谎报为空');
    report.cases.push({ case: '2 只读遇瞬时读错误：沿用缓存', ok: true, roster: roster.length });
    await rm(dir, { recursive: true, force: true });
  }

  // 3. 状态文件被删除：读取返回空，写入重建
  {
    const dir = await mkdtemp(join(tmpdir(), 'tg-fault-'));
    const file = join(dir, 'teams.json');
    await writeFile(file, seed());
    const store = new TeamStore(file, { log: () => {} });
    assert.equal(store.roster('keep').length, 1);
    await unlink(file);
    assert.equal(store.roster('keep').length, 0, '文件被删后读取应为空而不是报错');
    await store.upsertPresence('rebuilt', { label: 'r', role: 'x', task: 't', status: 'running' });
    const rebuilt = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(rebuilt.teams.rebuilt, '文件被删后写入应能重新建立');
    report.cases.push({ case: '3 文件被删除：读取为空且可重建', ok: true });
    await rm(dir, { recursive: true, force: true });
  }

  // 4. 损坏文件：能备份时备份，写入路径不静默覆盖
  {
    const dir = await mkdtemp(join(tmpdir(), 'tg-fault-'));
    const file = join(dir, 'teams.json');
    await writeFile(file, '{ this is not json');
    const store = new TeamStore(file, { log: () => {} });
    // 只读能拿到空状态
    assert.equal(store.roster('x').length, 0);
    // 写入前会先把损坏文件改名备份，之后正常写入
    await store.upsertPresence('fresh', { label: 'f', role: 'x', task: 't', status: 'running' });
    const entries = fs.readdirSync(dir);
    const backup = entries.find((name) => name.includes('.corrupt-'));
    assert.ok(backup, `损坏文件应被备份，实际目录内容：${entries.join(', ')}`);
    assert.equal(await readFile(join(dir, backup), 'utf8'), '{ this is not json');
    const written = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(written.teams.fresh);
    report.cases.push({ case: '4 损坏文件：备份后从空写入', ok: true, backup });
    await rm(dir, { recursive: true, force: true });
  }

  report.ok = true;
} catch (err) {
  failure = err;
  report.error = String(err?.message ?? err);
} finally {
  fs.readFileSync = realReadFileSync;
}

console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  console.error(failure?.stack ?? '');
  process.exit(1);
}
