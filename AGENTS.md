# DFSC 社区插件市场工作约定

- 唯一 canonical 社区市场仓库为 `7oMB2006/dfsc-community-plugins`，市场名 `dfsc-community`。对外写入先核对仓库所有者和当前 GitHub 身份为 `7oMB2006`；不要沿用 `Daodaodot` 或其他账号的 CLI 配置和凭据。已有连接或来源记录不构成切换发布账号的授权。
- 只维护本社区市场。独立插件项目、DFSC 宿主源码、Hermes companion 的发布与安装仍由各自项目管理；收录资源不授予工程权限。
- 保持原生 `.step-plugin/marketplace.json` 在根目录，条目安装来源为 `plugins/<id>` 的仓库内相对路径。来源登记在 `registry.json`，固定完整提交 SHA；同步工具生成原生清单、资源副本和 `registry.lock.json`。
- 修改登记或升级来源后，审查资源差异与许可证，运行同步、`python3 scripts/validate-marketplace.py --check` 和 `python3 -m unittest discover -s tests -v`。不要直接修改生成副本或哈希来绕过来源审核；维护者说明放在 `docs/plugins/<id>.md`。
- 不提交真实配置、profile、`.env`、token、连接描述符、任务账本、原生会话、运行日志或个人绝对路径。网络同步只使用显式提供给工具的 GitHub 读取凭据，不自动寻找其他账号的认证。
- 测试使用临时目录和受控数据，不发真实消息、不调用模型、不派真实工程。区分静态校验、原生市场安装、真实业务闭环与长时间运行证据。
- 保留插件来源归属与原许可证。收录需要审查；不把本仓库描述为自动审核服务、账号社区或插件评分系统。
