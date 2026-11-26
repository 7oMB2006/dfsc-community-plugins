/**
 * team_wait 的轮次标识：派发时确定，回报与等待认同一个 round。
 *
 * 复审关注点：游标只回答「等待开始后到达了什么」，认不出「本轮已经先回报」。
 * 两个漏场景：
 *   A. 主代理先派发、子代理很快回报、之后才调用 team_wait —— 那条信号在游标之前，
 *      会被当成上一轮丢掉，等待空转到超时。
 *   B. 等待超时返回后再次等待 —— 间隔期到达的信号同样落在新游标之前，被漏掉。
 * 给 agent_done 与 team_wait 同一个 round 后两者都能认到；同时不能回退原有不变量：
 * 上一轮的旧信号、以及不给 round 时的旧语义，都不得把历史结果算成本轮完成。
 *
 * 运行：node tests/plugins/agent-team/wait-round-scope.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../../../plugins/agent-team/server/team-gate.mjs');

const dir = await mkdtemp(join(tmpdir(), 'team-gate-round-scope-'));
const child = spawn(process.execPath, [entry], {
  env: { ...process.env, TEAM_GATE_STATE_FILE: join(dir, 'teams.json') },
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
const call = async (name, args) => JSON.parse((await request('tools/call', { name, arguments: args })).content[0].text);

const report = { cases: [] };
let failure;

try {
  await request('initialize', { protocolVersion: '2024-11-05' });
  const team = 'rounds';
  const quiet = { team, staleAfterMs: 60000 };

  // A. 先回报、后等待：信号早于 team_wait 到达，但同属一轮，必须认到。
  await call('agent_report', { ...quiet, label: 'worker-1', role: 'builder', task: 'A', round: 'r1' });
  await call('agent_done', { ...quiet, label: 'worker-1', status: 'success', summary: 'A 先回报', round: 'r1' });
  const early = await call('team_wait', { ...quiet, expect: ['worker-1'], mode: 'all', round: 'r1', timeoutMs: 1500 });
  assert.equal(early.status, 'satisfied', `同轮信号早于等待到达时必须认到；实际 status=${early.status}`);
  assert.deepEqual(early.pending, [], '本轮已回报的标签不应留在 pending');
  assert.deepEqual(early.newSignals.map((s) => s.summary), ['A 先回报'], 'newSignals 应只含本轮信号');
  assert.equal(early.round, 'r1', '返回体应回显本轮标识');
  report.cases.push({ case: '先回报后等待也能认到', ok: true, status: early.status });

  // B. 超时后继续等：间隔期到达的信号要在第二次等待里认到。
  const timedOut = await call('team_wait', { ...quiet, expect: ['worker-2'], mode: 'all', round: 'r2', timeoutMs: 1000 });
  assert.equal(timedOut.status, 'timeout', '本轮尚无信号时应超时');
  assert.deepEqual(timedOut.pending, ['worker-2'], 'pending 应列出尚未完成的标签');
  await call('agent_done', { ...quiet, label: 'worker-2', status: 'success', summary: 'B 间隔期', round: 'r2' });
  const resumed = await call('team_wait', { ...quiet, expect: ['worker-2'], mode: 'all', round: 'r2', timeoutMs: 1500 });
  assert.equal(resumed.status, 'satisfied', '超时后继续等应认到间隔期到达的同轮信号');
  assert.deepEqual(resumed.newSignals.map((s) => s.summary), ['B 间隔期'], 'newSignals 应含间隔期信号');
  report.cases.push({ case: '超时后继续等不漏间隔期信号', ok: true, status: resumed.status });

  // C. 旧轮次的同名标签不算新轮完成。
  const staleRound = await call('team_wait', { ...quiet, expect: ['worker-1'], mode: 'all', round: 'r3', timeoutMs: 1000 });
  assert.equal(staleRound.status, 'timeout', '旧轮次的同名标签不得算作本轮完成');
  assert.deepEqual(staleRound.pending, ['worker-1']);
  assert.deepEqual(staleRound.newSignals, []);
  report.cases.push({ case: '旧轮次信号不算本轮', ok: true, status: staleRound.status });

  // D. 不给 round 时保留原有严格语义：历史信号不得被算成本轮。
  const noRound = await call('team_wait', { ...quiet, expect: ['worker-1'], mode: 'all', timeoutMs: 1000 });
  assert.equal(noRound.status, 'timeout', '不带 round 时历史信号仍不得算作本轮完成');
  assert.deepEqual(noRound.pending, ['worker-1']);
  assert.equal(noRound.round, null, '未给 round 时返回体应为 null');
  report.cases.push({ case: '不带 round 保持原有严格语义', ok: true, status: noRound.status });

  // E. 非法 round 必须被拒绝，而不是静默当成不限轮次。
  const badRound = await call('team_wait', { ...quiet, expect: ['worker-1'], mode: 'all', round: 'bad round!', timeoutMs: 1000 });
  assert.equal(badRound.ok, false, '非法 round 应被拒绝');
  assert.match(badRound.error, /round 参数非法/);
  report.cases.push({ case: '非法 round 被拒绝', ok: true });

  // F. 部分完成后超时，继续等剩余标签：已完成的不能重复计，未完成的要能补上。
  const teamF = 'partial';
  await call('agent_report', { team: teamF, label: 'part-a', role: 'builder', task: 'a', round: 'p1', staleAfterMs: 60000 });
  await call('agent_report', { team: teamF, label: 'part-b', role: 'builder', task: 'b', round: 'p1', staleAfterMs: 60000 });
  await call('agent_done', { team: teamF, label: 'part-a', status: 'success', summary: 'a 完成', round: 'p1' });
  const partial = await call('team_wait', { team: teamF, expect: ['part-a', 'part-b'], mode: 'all', round: 'p1', timeoutMs: 1000, staleAfterMs: 60000 });
  assert.equal(partial.status, 'timeout', '只完成一部分时应超时');
  assert.deepEqual(partial.pending, ['part-b'], 'pending 只应剩未完成的标签，已完成的不得重复列出');
  assert.deepEqual(partial.newSignals.map((s) => s.label), ['part-a'], 'newSignals 只含已到达的那条');
  await call('agent_done', { team: teamF, label: 'part-b', status: 'success', summary: 'b 完成', round: 'p1' });
  const restDone = await call('team_wait', { team: teamF, expect: ['part-a', 'part-b'], mode: 'all', round: 'p1', timeoutMs: 1500, staleAfterMs: 60000 });
  assert.equal(restDone.status, 'satisfied', '剩余标签补齐后应满足');
  assert.deepEqual(restDone.pending, []);
  assert.deepEqual(restDone.newSignals.map((s) => s.label).sort(), ['part-a', 'part-b'], '继续等待应看到本轮全部信号');
  report.cases.push({ case: '部分完成后超时，继续等补齐剩余', ok: true, firstPending: partial.pending });

  // G. 非法 round 不得先清空团队状态：参数校验必须在 reset 之前。
  const teamG = 'reset-guard';
  await call('agent_done', { team: teamG, label: 'keep', status: 'success', summary: '不该被清掉', round: 'g1' });
  const rejected = await call('team_wait', { team: teamG, expect: ['keep'], mode: 'all', round: 'bad round!', reset: true, timeoutMs: 1000 });
  assert.equal(rejected.ok, false, '非法 round 应被拒绝');
  const afterReject = await call('team_status', { team: teamG });
  assert.ok(afterReject.recentSignals.length > 0, '非法 round 触发 reset 前就应中止，旧信号必须还在');
  report.cases.push({ case: '非法 round 不先执行 reset', ok: true, keptSignals: afterReject.recentSignals.length });

  // H. agent_report 的 round 要落库，便于翻 roster 核对谁属于哪一轮。
  const teamH = 'report-round';
  const reported = await call('agent_report', { team: teamH, label: 'w-r', role: 'scout', task: 'h', round: 'h1', staleAfterMs: 60000 });
  assert.equal(reported.presence.round, 'h1', 'agent_report 应把 round 存进在线状态');
  const statusH = await call('team_status', { team: teamH, label: 'w-r' });
  assert.equal(statusH.me.round, 'h1', 'team_status 应回显该 round');
  const badReport = await call('agent_report', { team: teamH, label: 'w-r', round: 'bad round!' });
  assert.equal(badReport.ok, false, '非法 round 的上报应被拒绝');
  report.cases.push({ case: 'agent_report 保存 round', ok: true });

  report.ok = true;
} catch (err) {
  failure = err;
  report.ok = false;
  report.error = String(err?.message ?? err);
} finally {
  child.kill();
  await rm(dir, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  console.error(failure?.stack ?? '');
  process.exit(1);
}
