# 智能体团队（agent-team）

这是 DFSC 社区市场中的 `agent-team` 资源插件，资源版本 **2.0.0**，许可证 **MIT**。

## 安装后提供什么

- 十二个角色 Agent：analyst（需求澄清）、scout（代码调研）、debugger（缺陷定位）、architect（方案设计）、builder（编码实现）、tester（测试保障）、reviewer（功能审查）、security-auditor（安全审计）、perf-engineer（性能把关）、ux-reviewer（界面审查）、docs-writer（文档同步）、release-engineer（交付发布）。每个角色带明确的工具边界（只读 / 读写 / 限测试）。
- `team-playbook` 技能：十二环节映射与五种编排模式，供主智能体按任务选用。
- 四条命令：`/team-implement`、`/team-debug`、`/team-review`、`/team-ship`。
- `team-gate` MCP server（零依赖，stdio）：六个协作工具 `team_wait`、`agent_done`、`agent_report`、`team_status`、`agent_send`、`agent_recv`，提供团队隔离、状态持久化与 stale 失联检测。

## 依赖与生效方式

- **Node.js ≥ 18**：`team-gate` 是 stdio MCP server，由宿主用 `node ./server/team-gate.mjs` 启动；插件不附带 Node.js，需系统另行准备。
- 安装后按宿主提示重启会话，使 MCP server 启动；用 `/mcp` 检查 `team-gate` 是否加载。
- 技能与命令的生效按宿主提示重载会话。
- 状态落盘到插件目录的 `state/teams.json`（可用环境变量 `TEAM_GATE_STATE_FILE` 覆盖），重启后恢复进行中的团队状态。

## 权限与数据范围

- MCP server 以当前系统用户权限运行，只通过 stdio 与宿主通信，不发起网络请求，不读取项目外的文件。
- 状态文件仅保存团队信号、在线状态与点对点消息（每类上限 200 条、团队上限 50 个），不记录会话正文。
- 不收集账户信息，不向第三方发送数据，不消耗任何账户额度或产生额外费用。
- 角色 Agent 的读写边界由各自的工具边界决定；`builder`、`tester`、`docs-writer`、`release-engineer` 会在项目中写文件，其余角色只读。

## 停用与卸载

在插件页停用或卸载后重启会话即可移除全部能力；`state/teams.json` 不会自动删除，需要时可手动清理插件目录下的 `state/`。

## 来源与兼容范围

- 上游仓库：[Niangaol/agent-team](https://github.com/Niangaol/agent-team)
- 资源目录：`plugins/agent-team`，固定提交见 `registry.json`
- 已验证宿主：DFSC 0.4.0（macOS，team-gate 工具实际加载可用）
- 未验证：其他版本 / 平台的 MCP 加载差异、跨机团队协作（team-gate 状态仅本机）
