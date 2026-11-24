---
description: 快速把一条结论写进项目记忆
---

把下面这条结论写进项目记忆：$ARGUMENTS

1. 如果内容为空或只是一句「记一下」，问用户要记的具体是什么，不要凭空补全。
2. 先 `recall` 一下关键词，确认是否已有相同或相近的条目：
   - 已有且内容一致 → 不重复写，告知用户「已有这条记忆」并给出 id。
   - 已有但结论相反 → 先 `retain` 新结论拿到 id，再 `memory_edit(op: "invalidate", id: <旧>, replacementId: <新>)`，
     并说明旧结论被标记为失效（没有删除）。
3. 否则 `retain`，`project` 用当前工作区绝对路径；按内容选 `type`：
   环境与事实用 `fact`，做过的选择用 `decision`，做法用 `lesson`，
   用户口味用 `preference`，踩过的坑用 `pitfall`。
4. 一句话确认写入结果：条目 id、类型、是否合并或新增。
