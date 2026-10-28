# 收录与更新插件

本仓库维护 DFSC 原生市场目录。插件先在自己的项目中开发和发布，再通过 PR 申请收录；维护者审核后合入固定版本的资源副本。第一版不自动批准 PR，也不自动更新用户已安装的插件。

## 准备插件项目

- 提供有效的 `step.plugin.json`，使用稳定且唯一的插件 ID 与明确版本。
- 明确技能、命令、MCP 等实际功能，以及所需宿主版本、外部组件和权限。现有加载器不支持的执行入口不应描述为可安装功能。
- 提供许可证和来源归属，确认相应内容可在市场中分发。
- 使用可审阅的资源与代码。真实配置、凭据、profile、任务账本、原生会话和运行日志不进入收录目录。

市场清单的安装来源必须是本仓库内的插件目录。独立上游仓库地址用于同步和溯源，不能代替可安装资源副本。

## 提交收录 PR

1. 在 `registry.json` 中新增条目，填入上游仓库、完整的 40 位提交 SHA、资源路径、许可证和说明文档路径。不要把浮动分支或标签当作锁定提交。
2. 在 `docs/plugins/<id>.md` 写清资源内容、兼容版本、依赖、安装后的生效方式及停用方法。同步工具会用这份说明替换资源目录内的 README。
3. 按固定提交运行同步工具，生成 `plugins/<id>/`、锁定记录和原生市场清单。
4. 运行校验与测试。涉及新能力或资源形态时，用一次性 DFSC 数据目录验证发现、安装、实际加载与卸载，记录使用的宿主版本和结果。
5. PR 中说明用户会得到什么、上游来源与提交、权限或依赖、许可证及实际验证范围。

登记格式示例：

```json
{
  "id": "example-plugin",
  "description": "插件提供的具体功能和必要依赖。",
  "source": {
    "repository": "owner/plugin-repository",
    "commit": "<完整的 40 位提交 SHA>",
    "path": "plugins/example-plugin"
  },
  "license": "MIT",
  "readme": "docs/plugins/example-plugin.md"
}
```

这里的占位提交须替换为真实 SHA。完整注册文件还有 `schemaVersion`、`marketplaceName` 和 `plugins` 数组；以现有 `registry.json` 为起点。

## 同步和检查

```sh
python3 scripts/sync-plugin.py --plugin example-plugin
python3 scripts/validate-marketplace.py --check
python3 -m unittest discover -s tests -v
```

网络同步从 GitHub 的固定提交读取资源并检查 Git blob 哈希。私有上游可使用已有的 `GH_TOKEN` 或 `GITHUB_TOKEN`；凭据不写入仓库或 PR。离线模式只接受已有锁定记录对应的内容：

```sh
python3 scripts/sync-plugin.py --plugin example-plugin --source-dir /absolute/path/to/plugin-directory
```

锁定记录描述上游原始文件；本市场维护的 README 单独保存在 `docs/plugins/`。不要直接修改生成目录来绕过来源审核，也不要手工修改哈希以让未经核对的内容通过。

## 更新与撤下

更新插件时，审核新的上游提交及资源差异，修改固定提交后重新同步。描述版本变化、依赖和权限变化；保留已有来源归属与许可证。市场更新不会自动升级用户已经安装的副本。

撤下条目时，同时移除登记、锁定项、市场条目及资源目录，并说明原因。撤下只影响之后的发现和安装，不会远程删除用户已安装的插件或停止正在运行的工程。

维护者可以要求补充兼容验证或改正功能描述。真实服务、真实模型、账户计费、飞书消息和长时间运行结果须分别记录；受控测试不能替代这些结果。
