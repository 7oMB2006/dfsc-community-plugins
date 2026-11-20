/**
 * MCP 协议层冒烟测试。
 *
 * 前面的测试关注状态一致性，这里关注「宿主实际会怎么连它」：initialize、
 * tools/list、tools/call，以及非法输入下不能崩、stdout 不能混入非协议内容
 * （stdout 一旦被日志污染，宿主的 JSON-RPC 解析会直接失败）。
 *
 * 运行：node tests/mcp-protocol.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../plugins/agent-team/server/team-gate.mjs');

const dir = await mkdtemp(join(tmpdir(), 'team-gate-protocol-'));
const child = spawn(process.execPath, [entry], {
  env: { ...process.env, TEAM_GATE_STATE_FILE: join(dir, 'teams.json') },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += String(chunk); });

const lines = [];
createInterface({ input: child.stdout, terminal: false }).on('line', (line) => lines.push(line));

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const reply = (id) => {
  const line = lines.find((l) => {
    try { return JSON.parse(l).id === id; } catch { return false; }
  });
  assert.ok(line, `没有收到 id=${id} 的响应；stderr=${stderr.slice(0, 400)}`);
  return JSON.parse(line);
};

const report = { steps: [] };
let failure;

try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await settle();
  const init = reply(1);
  assert.equal(init.result.serverInfo.name, 'team-gate');
  assert.ok(init.result.capabilities.tools, '应声明 tools 能力');
  report.steps.push({ step: 'initialize', ok: true });

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await settle(200);
  assert.ok(lines.every((l) => JSON.parse(l).id !== undefined), '通知不应产生响应');
  report.steps.push({ step: '通知不产生响应', ok: true });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await settle();
  const tools = reply(2).result.tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['agent_done', 'agent_recv', 'agent_report', 'agent_send', 'team_status', 'team_wait']);
  for (const tool of reply(2).result.tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} 应有 object inputSchema`);
  }
  report.steps.push({ step: 'tools/list 六个工具且 schema 合法', ok: true, tools });

  send({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'agent_report', arguments: { team: 'smoke', label: 'a', task: 't' } },
  });
  await settle();
  const called = JSON.parse(reply(3).result.content[0].text);
  assert.equal(called.ok, true);
  report.steps.push({ step: 'tools/call 正常返回', ok: true });

  send({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'agent_report', arguments: { team: 'bad team!', label: 'a' } },
  });
  await settle();
  const badTeam = reply(4);
  const badPayload = badTeam.error ?? JSON.parse(badTeam.result.content[0].text);
  assert.ok(badPayload.error || badPayload.ok === false, '非法 team 应被拒绝');
  report.steps.push({ step: '非法 team 被拒绝', ok: true });

  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
  await settle();
  const unknown = reply(5);
  assert.ok(unknown.error || unknown.result?.isError, '未知工具应报错');
  report.steps.push({ step: '未知工具被拒绝', ok: true });

  send({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
  await settle();
  assert.equal(reply(6).error.code, -32601, '未知方法应返回 -32601');
  report.steps.push({ step: '未知方法 → -32601', ok: true });

  child.stdin.write('{not json\n');
  await settle(200);
  send({ jsonrpc: '2.0', id: 7, method: 'ping' });
  await settle();
  assert.deepEqual(reply(7).result, {}, '畸形输入后进程仍应存活');
  report.steps.push({ step: '畸形输入不致命', ok: true });

  const offenders = lines.filter((line) => {
    try { return JSON.parse(line).jsonrpc !== '2.0'; } catch { return true; }
  });
  assert.deepEqual(offenders, [], `stdout 混入非协议内容：${offenders.slice(0, 2).join(' | ')}`);
  report.steps.push({ step: 'stdout 只含 JSON-RPC', ok: true });

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
