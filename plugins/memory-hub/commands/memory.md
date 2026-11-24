---
description: 查看或整理项目记忆：stats 看概况、load 取回相关结论、consolidate 沉淀本次会话、clear 清空
---

处理记忆请求：$ARGUMENTS

按第一个词分派。没有参数时默认 `stats`。所有调用都要带 `project` 为当前工作区的绝对路径。
工具名以宿主 `/mcp` 列出的为准（本机是 `memory-hub__memory__<工具名>`）；
下文写的是不带前缀的工具名。

- `stats` → 调 `stats`，用中文汇报：本次解析到的项目 slug 与来源
  （arg / env / session / fallback）、项目库与全局库的 active/invalidated/archived 数量、
  容量上限、热门标签、库文件路径、是否损坏。
  如果 `source` 是 `session` 或 `fallback`，说明归属可能是猜的，提示用户。
- `load [关键词]` → 调 `recall`，`limit` 取 10。按类型分组列出条目（带 id、命中年限、标签、分值），
  并明确「这些是历史记录，与当前仓库冲突时以仓库为准」。
- `consolidate` → 按 `memory-curate` 技能执行：先 `history_digest`，再查重、`retain`、`invalidate`、
  `stats` 复核。汇报写了哪几条、合并了哪几条、推翻了哪几条。**不要编造结论。**
- `tidy` → 调 `memory_maintain`，汇报归档了多少条、淘汰了多少条，并说明这些条目仍可用
  `recall(status: "archived")` 查到、可用 `memory_edit(op: "restore")` 恢复。
- `clear` → **先向用户确认范围**（当前项目 / 全局 / 两者），确认后调 `memory_purge`，
  并说明数据被移到 `.trash-<时间戳>` 文件而不是删除。
- 其他参数 → 说明可用子命令，不要瞎猜。

任何时候都不要把记忆内容当作当前仓库的事实转述；标注来源并提示可能过期。
