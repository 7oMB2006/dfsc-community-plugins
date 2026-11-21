/**
 * 双会话验证：两个独立的 team-gate 进程同时操作同一份状态文件。
 *
 * 复现场景（复审关注点）：宿主为两个 DFSC 会话各起一个 MCP 进程，
 * 两个进程都默认读写 <插件目录>/state/teams.json。
 *
 * 做法：起两个真实的 stdio server 子进程，通过 MCP JSON-RPC 驱动，
 * 交替写入不同的团队，最后核对：
 *   1. 每个进程写入的信号/消息都还在（没有互相覆盖）
 *   2. 两个进程读到的一致（没有各读各的旧快照）
 *   3. 同一团队里并发 agent_send 不丢消息，消息 id 不重复
 *   4. 团队之间不串（team A 看不到 team B 的消息）
 *   5. 30 毫秒级别的密集写入不产生损坏的状态文件
 *
 * 运行：node tests/two-session-state.mjs
 * 依赖：只使用 Node.js 内置模块和仓库内的 server/，不需要宿主、网络或模型。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../../../plugins/agent-team/server/team-gate.mjs');

/** 一个真实的 stdio MCP 进程，按换行分隔的 JSON-RPC 2.0 通信。 */
class Session {
  constructor(stateFile) {
    this.stateFile = stateFile;
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    this.child = spawn(process.execPath, [entry], {
      env: { ...process.env, TEAM_GATE_STATE_FILE: this.stateFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => {
      this.stderr += String(chunk);
    });
    // 子进程起不来时不能让请求一直悬着：立刻失败并带上 stderr。
    this.child.on('exit', (code) => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error(`team-gate 进程提前退出（code=${code}）：${this.stderr.trim()}`));
      }
      this.pending.clear();
    });
    createInterface({ input: this.child.stdout, terminal: false }).on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    });
    const init = await this.request('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.serverInfo.name, 'team-gate');
    return this;
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** 调用一个 MCP 工具，返回解析后的 JSON 载荷。 */
  async call(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    assert.ok(Array.isArray(result?.content) && result.content.length > 0, `${name} 没有返回内容`);
    return JSON.parse(result.content[0].text);
  }

  async stop() {
    this.child.stdin.end();
    await Promise.race([
      once(this.child, 'exit'),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    this.child.kill('SIGKILL');
  }
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'team-gate-two-session-'));
  const stateFile = join(dir, 'teams.json');
  const sessions = [];
  const report = { dir, stateFile, phases: [] };
  const settle = () => new Promise((r) => setTimeout(r, 250)); // 允许实现使用写入防抖
  try {
    const a = await new Session(stateFile).start();
    const b = await new Session(stateFile).start();
    sessions.push(a, b);

    // 阶段 1：两个进程各写一个团队，交替写，验证不会互相覆盖。
    await a.call('agent_report', { team: 'session-a', label: 'alice', role: 'scout', task: 'A 会话的任务' });
    await b.call('agent_report', { team: 'session-b', label: 'bob', role: 'builder', task: 'B 会话的任务' });
    await a.call('agent_done', { team: 'session-a', label: 'alice', status: 'success', summary: 'A 完成' });
    await b.call('agent_done', { team: 'session-b', label: 'bob', status: 'success', summary: 'B 完成' });
    await a.call('agent_send', { team: 'session-a', from: 'alice', to: 'alice', content: '仅 A 可见' });
    await b.call('agent_send', { team: 'session-b', from: 'bob', to: 'bob', content: '仅 B 可见' });

    await settle();
    const disk = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.deepEqual(Object.keys(disk.teams).sort(), ['session-a', 'session-b'], '两个团队都要落盘');
    assert.equal(disk.teams['session-a'].signals.length, 1, 'A 的信号不应被 B 覆盖');
    assert.equal(disk.teams['session-b'].signals.length, 1, 'B 的信号不应被 A 覆盖');
    assert.equal(disk.teams['session-a'].messages[0].content, '仅 A 可见');
    assert.equal(disk.teams['session-b'].messages[0].content, '仅 B 可见');
    report.phases.push({ phase: '1 交替写入不互相覆盖', ok: true, teams: Object.keys(disk.teams).sort() });

    // 阶段 2：两个进程各读一遍，看到的必须是同一份最新状态。
    const fromA = await a.call('team_status', { team: 'session-b' });
    const fromB = await b.call('team_status', { team: 'session-b' });
    assert.equal(fromA.roster.length, 1);
    assert.equal(fromB.roster.length, 1);
    assert.deepEqual(fromA.roster.map((p) => p.label), ['bob']);
    assert.deepEqual(fromB.roster.map((p) => p.label), ['bob']);
    assert.deepEqual(fromA.recentSignals.map((s) => s.summary), ['B 完成'], 'A 进程要读到 B 写的信号');
    assert.deepEqual(fromB.recentSignals.map((s) => s.summary), ['B 完成']);
    report.phases.push({ phase: '2 跨进程读到同一份最新状态', ok: true });

    // 阶段 3：同一团队并发写，不丢消息、id 不重复。
    const sends = [];
    for (let i = 0; i < 20; i += 1) {
      const session = i % 2 === 0 ? a : b;
      sends.push(session.call('agent_send', { team: 'shared', from: `w${i}`, to: '*', content: `msg-${i}` }));
    }
    const results = await Promise.all(sends);
    const ids = results.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, '并发写时消息 id 不能重复');
    const shared = await a.call('team_status', { team: 'shared' });
    assert.equal(shared.recentSignals.length, 0);
    const inbox = await b.call('agent_recv', { team: 'shared', label: 'watcher' });
    assert.equal(inbox.count, 20, `20 条广播都要保留，实际 ${inbox.count}`);
    assert.deepEqual(
      inbox.unread.map((m) => m.content).sort(),
      Array.from({ length: 20 }, (_, i) => `msg-${i}`).sort(),
    );
    report.phases.push({ phase: '3 同团队并发写入不丢消息', ok: true, messages: inbox.count, uniqueIds: ids.length });

    // 阶段 4：团队之间不串。
    const aTeam = await a.call('team_status', { team: 'session-a' });
    assert.equal(aTeam.team, 'session-a');
    assert.deepEqual(aTeam.roster.map((p) => p.label), ['alice'], 'A 团队不应出现 B 团队的 agent');
    const bTeam = await b.call('team_status', { team: 'session-b' });
    assert.deepEqual(bTeam.roster.map((p) => p.label), ['bob'], 'B 团队不应出现 A 团队的 agent');
    const aInbox = await a.call('agent_recv', { team: 'session-a', label: 'alice' });
    assert.deepEqual(aInbox.unread.map((m) => m.content), ['仅 A 可见'], 'A 团队不应收到 B 团队的消息');
    report.phases.push({ phase: '4 团队之间不串', ok: true });

    // 阶段 5：密集写入后状态文件仍然可解析，且没有残留 tmp / lock 文件。
    for (let round = 0; round < 30; round += 1) {
      const session = round % 2 === 0 ? a : b;
      await session.call('agent_report', { team: `burst-${round % 3}`, label: `p${round}`, task: 't' });
    }
    await settle();
    const finalDisk = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.ok(finalDisk.teams['burst-0'] || finalDisk.teams['burst-1'] || finalDisk.teams['burst-2'],
      '密集写入后状态文件应包含 burst 团队');
    const { readdir } = await import('node:fs/promises');
    const leftovers = (await readdir(dir)).filter((n) => n.endsWith('.tmp') || n.endsWith('.lock'));
    assert.deepEqual(leftovers, [], `退出后不应残留临时文件：${leftovers.join(',')}`);
    report.phases.push({ phase: '5 密集写入后文件完好且无残留', ok: true, teams: Object.keys(finalDisk.teams).length });

    // 阶段 6：一个进程退出时另一个仍在写，状态不能丢。
    await b.stop();
    sessions.pop();
    await a.call('agent_done', { team: 'session-a', label: 'alice', status: 'success', summary: 'B 退出后 A 继续写' });
    await settle();
    const afterExit = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(afterExit.teams['session-a'].signals.length, 2, 'B 退出后 A 的写入仍要落盘');
    assert.equal(afterExit.teams['session-b'].signals.length, 1, 'B 退出不应抹掉 B 自己的团队');
    report.phases.push({ phase: '6 单进程退出后另一进程继续写', ok: true });

    report.ok = true;
  } catch (err) {
    report.ok = false;
    report.error = String(err?.stack ?? err);
  } finally {
    for (const session of sessions) await session.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

await main();
