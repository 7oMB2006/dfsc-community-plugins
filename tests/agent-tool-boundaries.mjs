/**
 * 角色工具边界的静态校验。
 *
 * 复审关注点：「只读角色」到底是提示，还是宿主强制？
 * 事实：角色 frontmatter 的 `tools:` 会被宿主当作工具白名单传给子代理进程
 * （宿主以 `--tools <list>` 派发），所以列表里没有的写工具是**真的用不了**。
 * 但带 `run_command` 的角色拿到的是完整 shell，那部分只靠指令约束。
 *
 * 这个测试锁住这两件事，防止后续改动不小心给「只读」角色加上写/命令工具，
 * 或把 run_command 的角色误标成纯只读。
 *
 * 运行：node tests/agent-tool-boundaries.mjs
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const agentsDir = resolve(here, '../plugins/agent-team/agents');

/** 纯提示约束的角色：不得有写工具或 shell。 */
const NO_WRITE_NO_SHELL = ['analyst', 'scout', 'ux-reviewer'];
/** 有 shell、没有写工具的角色：shell 权限是真实的，只靠指令约束。 */
const SHELL_WITHOUT_WRITE = ['architect', 'debugger', 'reviewer', 'security-auditor', 'perf-engineer'];
/** 有写工具的角色。 */
const WITH_WRITE = ['builder', 'docs-writer', 'release-engineer', 'tester'];

const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
const MCP_PREFIX = 'agent-team__team-gate__';
const MCP_TOOLS = ['agent_report', 'agent_done', 'team_status', 'agent_send', 'agent_recv'];

async function readTools(name) {
  const text = await readFile(join(agentsDir, `${name}.md`), 'utf8');
  const match = text.match(/^tools:\s*(.+)$/m);
  assert.ok(match, `${name}.md 缺少 tools: 行`);
  return match[1].split(',').map((t) => t.trim()).filter(Boolean);
}

const report = { agents: [], checks: [] };

const files = (await readdir(agentsDir)).filter((f) => f.endsWith('.md')).sort();
assert.equal(files.length, 12, `应有 12 个角色定义，实际 ${files.length}`);

for (const file of files) {
  const name = file.replace(/\.md$/, '');
  const tools = await readTools(name);
  const writes = tools.filter((t) => WRITE_TOOLS.has(t));
  const shell = tools.includes('run_command');
  report.agents.push({ agent: name, tools: tools.length, writes: writes.map((t) => t), shell });

  // 所有角色都能用 team-gate 的协作工具，且使用限定的插件服务名
  const mcp = tools.filter((t) => t.startsWith(MCP_PREFIX));
  assert.deepEqual(
    mcp.map((t) => t.slice(MCP_PREFIX.length)).sort(),
    [...MCP_TOOLS].sort(),
    `${name} 的 team-gate 工具集不符：${JSON.stringify(mcp)}`,
  );
  // 不允许残留旧的非限定名
  assert.ok(
    !tools.some((t) => t.startsWith('mcp__')),
    `${name} 仍引用旧写法 mcp__ 前缀的工具名`,
  );

  if (NO_WRITE_NO_SHELL.includes(name)) {
    assert.deepEqual(writes, [], `${name} 是纯只读角色，不能有写工具：${writes}`);
    assert.equal(shell, false, `${name} 是纯只读角色，不能有 run_command`);
  }
  if (SHELL_WITHOUT_WRITE.includes(name)) {
    assert.deepEqual(writes, [], `${name} 不应有写工具：${writes}`);
    assert.equal(shell, true, `${name} 预期有 run_command（用于跑只读检查命令）`);
  }
  if (WITH_WRITE.includes(name)) {
    assert.ok(writes.length > 0, `${name} 预期有写工具`);
  }
}

report.checks.push(
  { check: '12 个角色定义齐全', ok: true },
  { check: '所有角色都带完整 team-gate 工具集（限定名）', ok: true },
  { check: '无旧 mcp__ 前缀残留', ok: true },
  { check: `纯只读角色无写工具/无 shell：${NO_WRITE_NO_SHELL.join(', ')}`, ok: true },
  { check: `有 shell 无写工具：${SHELL_WITHOUT_WRITE.join(', ')}`, ok: true },
  { check: `有写工具：${WITH_WRITE.join(', ')}`, ok: true },
);

report.notes = [
  'tools: 由宿主作为工具白名单传给子代理进程，列表外工具在子代理里不存在，属真实限制。',
  '带 run_command 的角色拥有完整 shell，不能当作只读沙箱。',
];
report.ok = true;
console.log(JSON.stringify(report, null, 2));
