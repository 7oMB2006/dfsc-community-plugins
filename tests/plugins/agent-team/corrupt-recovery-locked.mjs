/**
 * 损坏状态文件的恢复必须在持锁路径里完成。
 *
 * 复审关注点：只读查询不该改文件；备份/改名是写操作，必须在锁内做，
 * 否则两个进程同时判损坏会互相覆盖备份。
 *
 * 本测试检查三件事：
 *   1. 只读查询遇到损坏文件时不做任何文件改动（不产生 .corrupt-*）
 *   2. 写入路径会备份损坏文件，且备份内容与原文件一致
 *   3. 两个进程同时写损坏文件时，只留下一个备份，不会互相覆盖成空文件
 *
 * 运行：node tests/corrupt-recovery-locked.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../../../plugins/agent-team/server/team-gate.mjs');
const BROKEN = '{ this is definitely not json';

function startSession(stateFile) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, TEAM_GATE_STATE_FILE: stateFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  let nextId = 1;
  const pending = new Map();
  createInterface({ input: child.stdout, terminal: false }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolvePromise, rejectPromise) => {
    const id = nextId++;
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return {
    start: async () => {
      await request('initialize', { protocolVersion: '2024-11-05' });
      return {
        call: async (name, args) => JSON.parse((await request('tools/call', { name, arguments: args })).content[0].text),
        stop: () => child.kill(),
      };
    },
  };
}

const report = { cases: [] };
let failure;

try {
  // 1. 只读查询不改文件（含「缓存已建立后文件变成损坏」这条路径）
  {
    const dir = await mkdtemp(join(tmpdir(), 'tg-corrupt-ro-'));
    const file = join(dir, 'teams.json');
    // 先写合法状态，让进程建立缓存
    await writeFile(file, JSON.stringify({
      version: 3, nextMessageId: 1, nextSignalId: 1,
      teams: { keep: { signals: [], presence: {}, messages: [], createdAt: 'a', updatedAt: 'a' } },
    }));
    const session = await startSession(file).start();
    try {
      const warm = await session.call('team_status', { team: 'keep' });
      assert.equal(warm.recentSignals.length, 0);

      // 缓存建立后把文件改坏：下一次只读必须重新解析（这里最容易触发锁外备份）
      await writeFile(file, BROKEN);
      await new Promise((r) => setTimeout(r, 120));
      const afterCorrupt = await session.call('team_status', { team: 'x' });
      assert.equal(afterCorrupt.ok, true, '只读查询不应因损坏文件失败');
      await session.call('agent_recv', { team: 'x', label: 'nobody' });

      const entries = await readdir(dir);
      assert.deepEqual(entries.filter((n) => n.includes('.corrupt-')), [],
        `只读查询不应产生备份文件，实际目录：${entries.join(', ')}`);
      assert.equal(await readFile(file, 'utf8'), BROKEN, '只读查询不应改动原文件');
      report.cases.push({ case: '只读查询不做修复（含缓存已建立后变坏）', ok: true });
    } finally {
      session.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }

  // 2. 写入路径备份损坏文件
  {
    const dir = await mkdtemp(join(tmpdir(), 'tg-corrupt-w-'));
    const file = join(dir, 'teams.json');
    await writeFile(file, BROKEN);
    const session = await startSession(file).start();
    try {
      await session.call('agent_report', { team: 'y', label: 'a', task: 't' });
      const entries = await readdir(dir);
      const backups = entries.filter((n) => n.includes('.corrupt-'));
      assert.equal(backups.length, 1, `应恰好产生一个备份，实际：${backups.join(', ')}`);
      assert.equal(await readFile(join(dir, backups[0]), 'utf8'), BROKEN, '备份内容应与原文件一致');
      const state = JSON.parse(await readFile(file, 'utf8'));
      assert.ok(state.teams.y, '写入后状态文件应包含新团队');
      report.cases.push({ case: '写入路径备份损坏文件', ok: true, backups });
    } finally {
      session.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }

  // 3. 两个进程同时写损坏文件：不能出现「备份被覆盖成空状态」
  {
    const dir = await mkdtemp(join(tmpdir(), 'tg-corrupt-race-'));
    const file = join(dir, 'teams.json');
    await writeFile(file, BROKEN);
    const a = await startSession(file).start();
    const b = await startSession(file).start();
    try {
      await Promise.all([
        a.call('agent_report', { team: 'race-a', label: 'a', task: 't' }),
        b.call('agent_report', { team: 'race-b', label: 'b', task: 't' }),
      ]);
      const state = JSON.parse(await readFile(file, 'utf8'));
      assert.ok(state.teams['race-a'] && state.teams['race-b'],
        `两个进程的写入都应保留，实际团队：${Object.keys(state.teams).join(', ')}`);
      const backups = (await readdir(dir)).filter((n) => n.includes('.corrupt-'));
      assert.ok(backups.length >= 1, '至少应留下一个备份');
      // 关键：备份里必须是原始损坏内容，不能是「空状态被当成损坏再备份一次」
      for (const name of backups) {
        assert.equal(await readFile(join(dir, name), 'utf8'), BROKEN,
          `备份 ${name} 应是原始损坏内容，而不是被二次覆盖的空状态`);
      }
      report.cases.push({ case: '并发恢复不覆盖备份', ok: true, backups: backups.length });
    } finally {
      a.stop();
      b.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }

  report.ok = true;
} catch (err) {
  failure = err;
  report.ok = false;
  report.error = String(err?.message ?? err);
}

console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  console.error(failure?.stack ?? '');
  process.exit(1);
}
