/**
 * team_wait 必须只认「本轮」的新信号。
 *
 * 复审关注点：等待信号要绑定到本轮任务，别让上一轮的旧结果算成这轮完成。
 * 复现场景：同一团队、同一 label，上一轮已经发过 success；本轮重新派发后
 * 主代理调用 team_wait，如果实现按「历史里出现过这个 label」判断，会立刻返回
 * satisfied，而实际这一轮什么都没等到。
 *
 * 运行：node tests/wait-signal-scope.mjs
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

const dir = await mkdtemp(join(tmpdir(), 'team-gate-wait-scope-'));
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

  // 第一轮：发出信号，制造「历史里已有该 label」
  await call('agent_report', { team: 'rounds', label: 'worker-1', role: 'builder', task: '第一轮' });
  await call('agent_done', { team: 'rounds', label: 'worker-1', status: 'success', summary: '第一轮完成' });

  // 第二轮：同样的 label 还没回报，等待应立即超时而不是 satisfied
  const waited = await call('team_wait', {
    team: 'rounds',
    expect: ['worker-1'],
    mode: 'all',
    timeoutMs: 1200,
    staleAfterMs: 60000,
  });
  assert.equal(
    waited.status,
    'timeout',
    `上一轮的同名信号不得算作本轮完成；实际 status=${waited.status}`,
  );
  assert.deepEqual(waited.pending, ['worker-1'], 'pending 应包含尚未完成的本轮标签');
  assert.deepEqual(waited.newSignals, [], '本轮不应有新信号');
  report.cases.push({ case: '旧信号不算本轮完成', ok: true, status: waited.status, pending: waited.pending });

  // 本轮真的发信号后，等待应被满足
  const waiting = call('team_wait', {
    team: 'rounds',
    expect: ['worker-1'],
    mode: 'all',
    timeoutMs: 8000,
    staleAfterMs: 60000,
  });
  await new Promise((r) => setTimeout(r, 300));
  await call('agent_done', { team: 'rounds', label: 'worker-1', status: 'success', summary: '第二轮完成' });
  const satisfied = await waiting;
  assert.equal(satisfied.status, 'satisfied', '本轮信号到达后应满足等待');
  assert.deepEqual(
    satisfied.newSignals.map((s) => s.summary),
    ['第二轮完成'],
    'newSignals 只应包含本轮信号',
  );
  assert.deepEqual(satisfied.pending, []);
  report.cases.push({ case: '本轮信号可满足等待', ok: true, newSignals: satisfied.newSignals.length });

  // mode=any 且无 expect：也要等到本轮第一个信号
  const anyWait = call('team_wait', { team: 'rounds', mode: 'any', timeoutMs: 1200, staleAfterMs: 60000 });
  const anyResult = await anyWait;
  assert.equal(anyResult.status, 'timeout', 'mode=any 无 expect 时不应被历史信号满足');
  report.cases.push({ case: 'mode=any 也不吃历史信号', ok: true });

  // reset 后等待：重置的是状态，仍不应把旧信号算成本轮
  const resetWait = await call('team_wait', {
    team: 'rounds',
    expect: ['worker-1'],
    mode: 'all',
    reset: true,
    timeoutMs: 1000,
  });
  assert.equal(resetWait.status, 'timeout', 'reset 之后没有新信号就应超时');
  assert.equal((await call('team_status', { team: 'rounds' })).recentSignals.length, 0, 'reset 应清空信号');
  report.cases.push({ case: 'reset 后不残留旧信号', ok: true });

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
