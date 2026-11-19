# Superpowers

这是 DFSC 社区市场中的 `superpowers` 资源插件，资源版本 **7.0.2**，许可证 **MIT**（上游 [obra/superpowers](https://github.com/obra/superpowers)，作者 Jesse Vincent；本市场副本由 Niangaol 打包适配，不修改技能内容）。

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

- **Bash**：部分技能自带 POSIX shell 脚本（如 SDD 工作区、任务简报、评审包、brainstorming 启动脚本），需要系统提供 `bash`/`sh`；Windows 需 WSL 或 Git Bash。
- **Node.js（可选）**：仅 `brainstorming` 的可视化伴侣使用，会启动本机 `node` 进程（`server.cjs`）并在 `127.0.0.1` 随机高位端口监听（带令牌校验与闲置超时）；不启用可视化伴侣时不需要。
- 安装后按宿主提示重载会话；技能通过 `step.plugin.json` 的 `skills` 声明加载，用 `/skill:<名称>` 或按技能说明调用。
- 上游的 Claude Code `hooks/` 未包含在本副本内（DFSC 无文件式 hooks），`using-superpowers` 的会话启动自动提示不会出现，可在项目 `AGENTS.md` 中写入指引。

## 权限与数据范围

- 技能本身不联网；脚本仅操作当前项目目录与临时目录（`.superpowers/` 已被 `.gitignore` 覆盖）。
- 可视化伴侣在本机回环地址监听，不上传数据；会话文件默认写入系统临时目录，可用 `--project-dir` 落到项目内。
- `using-git-worktrees`、`finishing-a-development-branch` 等技能会执行 git 命令并创建工作树/分支，属于其设计行为，需用户确认后使用。

## 停用与卸载

在插件页停用或卸载后重载会话即可；已生成的 `.superpowers/` 临时文件可手动清理。

## 来源与兼容范围

- 上游项目：[obra/superpowers](https://github.com/obra/superpowers)（MIT），打包时对应提交 `22f0b463e7a5e579904dd6211a520321035526f7`
- DFSC 打包副本：[Niangaol/superpowers-dfsc](https://github.com/Niangaol/superpowers-dfsc)，资源目录 `plugins/superpowers`，固定提交见 `registry.json`
- 已验证宿主：DFSC 0.4.0（macOS arm64）——技能清单加载通过；各技能的实际执行效果依赖模型与任务上下文
- 未验证：其他 DFSC 版本与平台、Windows 下 bash 依赖的实际可用性、可视化伴侣在非本机环境的表现、与上游后续版本的差异
