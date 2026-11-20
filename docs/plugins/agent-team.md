# 智能体团队（agent-team）

这是 DFSC 社区市场中的 `agent-team` 资源插件，资源版本 **2.0.0**，许可证 **MIT**。

## 安装后提供什么

- 十二个角色 Agent：analyst（需求澄清）、scout（代码调研）、debugger（缺陷定位）、architect（方案设计）、builder（编码实现）、tester（测试保障）、reviewer（功能审查）、security-auditor（安全审计）、perf-engineer（性能把关）、ux-reviewer（界面审查）、docs-writer（文档同步）、release-engineer（交付发布）。每个角色带明确的工具白名单。
- `team-playbook` 技能：十二环节映射与五种编排模式，供主智能体按任务选用。
- 四条命令：`/team-implement`、`/team-debug`、`/team-review`、`/team-ship`。
- `team-gate` MCP server（零依赖，stdio）：六个协作工具 `team_wait`、`agent_done`、`agent_report`、`team_status`、`agent_send`、`agent_recv`，提供按团队分组、多进程安全的状态持久化与 stale 失联检测。

## 依赖与生效方式

- **Node.js ≥ 18**：`team-gate` 是 stdio MCP server，由宿主用 `node server/team-gate.mjs` 启动；插件不附带 Node.js，需系统另行准备。
- 安装后按宿主提示重启会话，使 MCP server 启动；用 `/mcp` 检查 `team-gate` 是否加载。
- 工具的实际注册名取决于宿主：插件服务以 `<插件id>__<服务名>` 命名，这里应为
  `agent-team__team-gate__team_wait` 等；以 `/mcp` 列出的名字为准。
- 技能与命令的生效按宿主提示重载会话。
- 状态落盘到插件目录的 `state/teams.json`（可用环境变量 `TEAM_GATE_STATE_FILE` 覆盖），重启后恢复进行中的团队状态。

## 两个会话同时使用时的状态归属

宿主可能复用同一个 `team-gate` 进程，也可能为不同会话分别启动一个；两种情况都读写同一个状态文件。

- 写入走「状态文件锁 + 读-改-写 + 同目录原子替换」：每次写入都基于磁盘最新内容，不会用本进程的旧快照覆盖另一个进程刚写入的状态。
- 读取会检测文件内容变化，能看到其他进程写入的最新状态。
- 锁超时 5 秒并报错（不会静默丢数据）；持锁进程崩溃后，超过 15 秒的陈旧锁会被接管。
- 验证方式与结果见「验证证据」一节。

## 权限与数据范围

- MCP server 以当前系统用户权限运行，只通过 stdio 与宿主通信，不发起网络请求，不读取项目外文件。
- **按团队分组是状态分区，不是安全边界**：所有团队的状态在同一个文件里，任何能调用 `team-gate` 的一方都能读到其他团队的在线名单、完成信号摘要与消息。不要把它当保密通道。
- 状态文件保存：
  - 任务摘要：`agent_done` 的 `summary`（截断到 8000 字符）与 `artifacts` 产出路径清单（最多 100 条）
  - 消息：`agent_send` 的点对点/广播正文（截断到 8000 字符，每团队最多 200 条）
  - 在线状态：label、角色、任务描述（截断到 2000 字符）、状态、时间戳
  - 信号：label / status / summary / artifacts / 时间戳（每团队最多 200 条）
  - 团队数上限 50，超出后淘汰最久未更新的团队
- 不保存会话正文、模型输出原文、文件内容或凭据；产出路径只是字符串记录，插件不会去读那些路径。

## 角色工具边界：哪些是强制的

各角色 frontmatter 的 `tools:` 列表由宿主作为工具白名单传给子代理进程（宿主以 `--tools <list>` 派发），**列表外的工具在子代理里不存在**。

- **真的只读**（无写工具、无 shell）：`analyst`、`scout`、`ux-reviewer`——写不了文件，也跑不了命令。
- **只读 + 完整 shell**：`debugger`、`architect`、`reviewer`、`security-auditor`、`perf-engineer`——它们有 `run_command`，能执行任何 shell 命令（包括写文件、删文件、装依赖）。"只读命令"是给模型的指令约束，**宿主不拦**。需要严格只读时，把这些角色的 `run_command` 从 `tools:` 里去掉。
- **有写工具**：`builder`、`tester`、`docs-writer`、`release-engineer`——能改工作区文件。"tester 只许改测试""docs-writer 只写文档"同为指令约束。

## 费用

- **本地 MCP 不单独收费**：`team-gate` 不连网、不调用模型，不消耗额度。
- **子代理的模型调用另计**：每个角色都是一次真实的模型会话，消耗宿主账户额度/套餐，与 MCP 是否收费无关。角色越多、并行度越高消耗越大。

## 停用与清理

1. 在插件页停用或卸载，重启会话，MCP 进程停止。
2. 手动删除 `<插件目录>/state/` 整个目录（含 `teams.json` 及可能残留的 `.lock`、`.tmp`、`.corrupt-*`）。
3. 若设置过 `TEAM_GATE_STATE_FILE`，删除那个路径。
4. 卸载**不会**自动删除这些文件——宿主只清理它自己登记的安装资源。

## 来源与兼容范围

- 上游仓库：[Niangaol/agent-team](https://github.com/Niangaol/agent-team)
- 资源目录：`plugins/agent-team`，固定提交见 `registry.json`
- **最低宿主**：`>=0.4.0`（`requirements.dfsc`），表示清单与加载形态在 0.4.0 的插件格式内。
- **实际验证**：DFSC **0.4.0 / macOS arm64**——插件加载、`team-gate` 六个工具注册与调用、团队分组、完成信号、状态查询与消息收发跑通。
- **Windows**：`team-gate` 的 server 层已在本机验证（Node.js 24 + Git Bash，双进程共用状态文件 6 个场景全部通过）。这**不是** Windows 上 DFSC 宿主加载的验收，宿主侧仍待验证。
- **未验证**：其他 DFSC 版本与平台、Windows 宿主安装与 `/mcp` 挂载、跨机协作（状态仅存本机）、高并发与长时间运行表现。

## 验证证据

验证脚本随本市场仓库提供，可直接在仓库根运行：

```bash
npm run test:agent-team
```

- `tests/two-session-state.mjs`：起两个真实的 `team-gate` stdio 子进程，通过 MCP JSON-RPC 驱动，覆盖
  1. 两个进程交替写不同团队，互不覆盖
  2. 跨进程读到同一份最新状态
  3. 同团队 20 条并发广播不丢消息、消息 id 不重复
  4. 团队之间不串数据
  5. 30 次密集写入后状态文件完好、无残留 tmp/lock
  6. 一个进程退出后另一个继续写入，双方数据都在

  对旧实现（无锁、整份覆盖）运行同一测试会在第 1 个场景失败，可复现复审指出的覆盖问题。

- `tests/state-fault-tolerance.mjs`：四种容错场景——写入遇瞬时读错误必须失败且不覆盖、只读遇错误沿用缓存、文件被删后读取为空且可重建、损坏文件备份后从空写入。对修复前的实现跑，第 1 个场景即失败。

- `tests/agent-tool-boundaries.mjs`：校验 12 个角色的工具白名单，锁住"纯只读角色无写工具/无 shell"与"有 shell 的角色不声称只读"。
- `tests/mcp-protocol.mjs`：协议层冒烟——`initialize` / 通知不产生响应 / `tools/list` 六个工具与 schema / `tools/call` / 非法 team 与未知工具被拒绝 / 未知方法返回 -32601 / 畸形输入不致命 / stdout 只含 JSON-RPC（日志混入 stdout 会让宿主的解析失败）。

脚本内容与上游仓库 `Niangaol/agent-team` 根目录的同名文件一致，**不随插件分发**；测试对象是 `plugins/agent-team` 这个市场分发副本。
