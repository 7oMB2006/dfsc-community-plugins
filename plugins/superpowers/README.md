# Superpowers

这是 DFSC 社区市场中的 `superpowers` 资源插件，资源版本 **7.0.2**，许可证 **MIT**（上游 [obra/superpowers](https://github.com/obra/superpowers)，作者 Jesse Vincent；本市场副本由 Niangaol 打包适配）。

## 相对上游的改动

技能文档（各 `SKILL.md` 与其 `references/`、`prompts/`、`templates/`）保持上游原文。**唯一的代码改动**是可视化伴侣的脚本 `skills/brainstorming/scripts/server.cjs`：

- 品牌 Logo 改为显式 opt-in（`BRAINSTORM_BRAND_LOGO=1`），默认只渲染文字标志。上游默认会从 `primeradiant.com` 加载一张 Logo 图片（查询串带版本号，用于粗算使用人数，不含项目内容或提示词）。
- 品牌区块的外链补 `rel="noreferrer noopener"`。

除此之外还排除了上游各平台适配层、Claude Code 的 `hooks/`、维护脚本、测试与设计文档（见「依赖与生效方式」）。逐字节对照可用 `git diff` 查看上游 `22f0b463` 与本仓库固定提交之间的差异。

## 安装后提供什么

15 个工程方法论技能（均为纯 Skill 资源，不含命令、Agent 或 MCP server）：

- `brainstorming` — 头脑风暴与设计探索，可选可视化伴侣
- `writing-plans` / `executing-plans` — 计划编写与按计划执行
- `subagent-driven-development` — 子代理驱动开发（任务简报、评审包、SDD 工作区）
- `dispatching-parallel-agents` — 并行子代理派发
- `test-driven-development` — 测试驱动开发
- `systematic-debugging` — 系统化调试
- `requesting-code-review` / `receiving-code-review` — 代码审查发起与接收
- `verification-before-completion` — 完成前验证
- `using-git-worktrees` / `finishing-a-development-branch` — worktree 工作流与分支收尾
- `using-superpowers` / `writing-skills` / `diagnosing-superpowers` — 技能库使用、编写与自诊断

## 依赖与生效方式

- **Bash**：部分技能自带 POSIX shell 脚本（如 SDD 工作区、任务简报、评审包、brainstorming 启动脚本），需要系统提供 `bash`/`sh`。
- **Node.js（可选）**：仅 `brainstorming` 的可视化伴侣使用，会启动本机 `node` 进程（`server.cjs`）。**默认只绑定 `127.0.0.1` 并监听随机高位端口**（带令牌校验与闲置超时）；不启用可视化伴侣时不需要。绑定地址可被显式覆盖：`start-server.sh --host <地址>`（对应环境变量 `BRAINSTORM_HOST`），用于远程/容器环境从外部访问；不传时就是回环地址。
- 安装后按宿主提示重载会话；技能通过 `step.plugin.json` 的 `skills` 声明加载，用 `/skill:<名称>` 或按技能说明调用。
- 上游的 Claude Code `hooks/` 未包含在本副本内（DFSC 无文件式 hooks），`using-superpowers` 的会话启动自动提示不会出现，可在项目 `AGENTS.md` 中写入指引。

## 网络行为

- **默认无第三方请求。** 本副本把可视化伴侣的品牌 Logo 改为显式 opt-in：默认只渲染文字标志。上游默认会从 `primeradiant.com` 加载一张 Logo 图片（查询串带 Superpowers 版本号，用于粗算使用人数，不含项目内容或提示词）；本副本默认不加载。
- 需要该 Logo 时设 `BRAINSTORM_BRAND_LOGO=1`；`SUPERPOWERS_DISABLE_TELEMETRY` / `DISABLE_TELEMETRY` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 任一为真时不加载。关闭方式就是把 `BRAINSTORM_BRAND_LOGO` 去掉或设为 `0`。
- 页面内保留一个指向 `github.com/obra/superpowers` 的普通链接，只在用户点击时跳转，不自动请求。
- 可视化伴侣的 WebSocket 与静态资源只连本机回环地址（默认绑定 `127.0.0.1`；若用 `--host` 改绑到非回环地址，页面与 WebSocket 会随该地址走，届时由使用者自行承担暴露面）。

## 权限与数据范围

- 技能本身不联网；脚本仅操作当前项目目录与临时目录。
- 可视化伴侣默认在本机回环地址监听，不上传数据；会话文件默认写入系统临时目录，可用 `--project-dir` 落到项目内。

### `diagnosing-superpowers` 会读写什么

这个技能用于复盘"会话为什么跑偏"，接触的数据比普通技能多，使用前请知悉：

**读取（本机，只读）**
- 宿主的历史会话记录：当前会话或用户指定的会话 id / 路径，含对话消息、工具调用与结果、时间戳、用量计数。
- 子代理的会话文件（用于区分父会话与子代理会话）。
- 会话目录里的索引 / 归档（如果环境指向它们）。
- 明确不修改、不移动、不删除任何会话文件。

**写入（本机）**
- `~/.superpowers/diagnosing-superpowers/<session-id>/`：case 记录、报告、导出包暂存。
- 当前工作区：报告正文（`report.md`）与可选的 issue 草稿，便于直接查看。
- 系统临时目录：中间脚本与产物。

**何时才外发（默认都不会发生）**

| 动作 | 触发条件 | 外发内容 |
| --- | --- | --- |
| 查 GitHub issue | 用户要求，或报告判定可能相关时，技能会**先展示搜索结果** | 只有搜索关键词，不含会话内容 |
| 导出诊断包 | **仅用户明确要求** | 会话内容，按用户选择的脱敏级别（skeleton / evidence / full）处理后打包 |
| 创建 GitHub issue | **仅用户批准确切文本后** | issue 正文（由诊断结论整理） |

导出与建 issue 都设有人工闸门：导出必须先跑 scrub + scrub-audit 直到审计通过，再把清单与脱敏日志交给用户看，**批准后**才打包；建 issue 必须先展示确切文本并获批准。脱敏仍可能遗漏，用户需自行复核每个文件后再分享。

`gh`、`curl` 等命令由技能在需要时显式调用；不使用它们时不会产生网络请求。

## 停用与卸载

在插件页停用或卸载后重载会话即可；已生成的 `.superpowers/` 目录（在用户家目录）与工作区内的报告文件不会自动删除，需要时手动清理。

## 来源与兼容范围

- 上游项目：[obra/superpowers](https://github.com/obra/superpowers)（MIT），打包时对应提交 `22f0b463e7a5e579904dd6211a520321035526f7`
- DFSC 打包副本：[Niangaol/superpowers-dfsc](https://github.com/Niangaol/superpowers-dfsc)，资源目录 `plugins/superpowers`，固定提交见 `registry.json`
- **最低宿主**：声明为 DFSC `>=0.4.0`（`requirements.dfsc`），表示技能资源的清单与加载形态在 0.4.0 的插件格式内，不是所有版本都实测过。
- **实际测过**：DFSC **0.4.0 / macOS arm64** —— 技能清单加载与市场同步校验通过。
- **未测 / 待验证**：
  - 其他 DFSC 版本与平台。
  - Windows 下的宿主加载与 `bash` 依赖：**未在 DFSC 宿主上验收**。本副本的脚本逻辑在 Windows + Git Bash（非 WSL）下可运行，但这不等于宿主加载已验过。
  - Windows 上「直接执行脚本」：不可用（Git 不还原权限位），须按文档写 `bash <脚本>`；详见下节。
  - 可视化伴侣在非本机 / 容器环境的表现。
  - 与上游后续版本的差异。

## 可执行位（Unix exec bit）

上游 10 个脚本标为 `100755`：`brainstorming/scripts/start-server.sh`、`stop-server.sh`、`executing-plans/scripts/task-start`、`task-done`、`subagent-driven-development/scripts/sdd-repo`、`sdd-workspace`、`task-brief`、`review-package`、`systematic-debugging/find-polluter.sh`、`writing-skills/render-graphs.js`。

**修复前的问题**：市场同步用 `write_bytes` 复制文件、不保留 Git 模式，这 10 个文件在市场副本里变成 `100644`。Windows 上 Git 默认 `core.fileMode=false`，`chmod` 改不了索引里的模式，所以只在工作区补权限位没有用。

**当前处理**：锁文件为这 10 个文件记录 `mode: 100755`；同步落盘后用 `git update-index --chmod=+x` 把模式写进索引；`validate-marketplace.py --check` 会比对索引模式与锁记录，不一致直接失败。`registry.lock.json` 中 superpowers 条目现有 10 行带 `mode`，市场仓库索引里对应文件为 `100755`。

**平台差异（实测）**：

| 场景 | 结果 |
| --- | --- |
| Git 索引 / `git archive` 导出 | 10 个脚本均为 `100755` |
| macOS / Linux 工作区 | 可执行位正常，脚本可直接执行 |
| **Windows 工作区** | Git 不还原权限位，`spawn` 直接执行会 `ENOENT`；必须写成 `bash <脚本>` |

技能文档里的调用方式（实测统计）：

- **18 处**写成 `bash .../scripts/<脚本>`，显式指定解释器，**不依赖可执行位**。
- **1 处**是 `systematic-debugging/root-cause-tracing.md:104` 的 `bash ./find-polluter.sh ...`——同样带 `bash`，但需先 `cd` 到 `systematic-debugging/` 目录。
- **2 处**是 `writing-skills/references/flowcharts.md` 的 `node ./render-graphs.js ...`——靠 `node` 运行，**不使用执行位**（该文件虽标 100755，执行位对实际用法没有作用）。

因此在 Windows 上按文档调用不受影响：所有写法都显式指定了解释器（`bash` 或 `node`），没有依赖裸 `./script` 直接执行。

在 POSIX 平台上，10 个脚本的可执行位已按源仓库保留（见下节），`./start-server.sh` 这类直接执行也可用。

**补测口径**：用市场分发的 `plugins/superpowers` 目录（导出成独立安装副本）跑，不只跑源仓库工作区。两个验证脚本随本市场仓库提供，审核者可直接复现：

```bash
npm run test:superpowers
# = node tests/no-third-party-assets.mjs && node tests/market-installed-scripts.mjs
```

- `tests/no-third-party-assets.mjs`：真实启动 `server.cjs`，走 bootstrap → 内容页两步请求，检查默认配置下没有任何第三方资源请求。
- `tests/market-installed-scripts.mjs`：把 `plugins/superpowers` 导出成独立安装副本，在临时 Git 仓库里实跑 10 个脚本的检查与 7 条真实流程：`task-start`、`task-brief`、`sdd-workspace`、`sdd-repo`、`review-package`、`task-done`、`find-polluter.sh`。

注意：Windows 下该脚本把 `executable` 记为 `null`（Git 不还原权限位，`spawn` 直接执行会 ENOENT），统一用 `bash <脚本>` 调用；可执行位本身在 Git 索引与 POSIX 平台上验证。脚本内容与上游仓库根目录的同名文件一致，但**不随插件分发**（只在仓库 `tests/` 中）。
