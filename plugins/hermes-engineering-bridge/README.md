# Hermes 工程桥

这是 DFSC 社区市场中的 `hermes-engineering-bridge` 资源插件，资源版本 **0.3.0**，许可证 **MIT**。

## 安装后提供什么

- Hermes 主视图入口：在支持 `agent-bridge-v1` 的新 DFSC 客户端中，从顶栏插件区域打开。
- 只读连接页：用户主动选择本机 profile 后，核验身份、可见目录与首批任务摘要；令牌不进入页面。
- 四页随包指南：开始使用、连接准备、第一项任务、排查问题；无须先打开私有仓库阅读入门内容。
- `hermes-engineering-evidence` 技能与 `hermes-bridge-help` 帮助命令。
- 插件自带图标与更新记录。

旧宿主仍可加载原有资源，不会因为安装插件自动获得新界面。新工作台须使用支持
连接协议的新客户端；相同 `0.6.0` 版本号不证明已有此适配，不声称已发布安装包均支持。
目标平台为 macOS Apple Silicon 和 Windows x64。

**入口出现不代表已连接。只读核验成功也不代表 companion 已加载或可以派工。**
当前桌面主线不内置 Agent Bridge 服务，工作台不能替代配套宿主。
完整工程派工需要另行取得
DFSC Hermes 0.6.0 宿主内置 Agent Bridge、Hermes companion 0.2.0，
以及使用者自己的 Hermes、模型和飞书环境，并完成独立身份、目录授权与配对。

## 安装与配套指南

在 DFSC 的「市场来源」添加社区市场，在「发现」安装 `hermes-engineering-bridge`。
安装后从 Hermes 顶栏入口进入「连接」，未准备配套组件时阅读「安装指南」。
旧宿主在插件详情阅读“开始使用”；技能与命令的生效按宿主提示重载会话。
入门指南位于资源包的 `docs/START.md` 等文件，展示清单明确引用，不依赖被市场覆盖的 README。

工程桥项目单独维护：

- [项目与完整组件说明](https://github.com/7oMB2006/hermes-engineering-bridge)
- [配套安装、配对、重载及卸载指南](https://github.com/7oMB2006/hermes-engineering-bridge/blob/main/INSTALL.txt)

配套项目当前需要访问权限。无法打开时，应向维护者取得受支持宿主和 companion，
不要反复安装资源或使用不明来源的替代包。社区市场没有 companion 安装目录或
宿主安装器，不能用复制资源目录代替配套安装。
本次更新不修改 companion 运行代码、不增加模型请求、自动安装或权限。
选择 profile 后，宿主仅检查 `config.yaml` 标记并读取 `dfsc-bridge/config.json`
及其显式 `bridgeRoot` 中对应身份的 `model.json`，不读取 YAML 内容、`human.json` 或 `.env`。
连接面板只列出首批 50 条中符合身份与真实目录交集的最多 20 项，不提供审批或任务控制。
忘记选择不修改原 profile 或配对文件；资源更新后需重新选择。
用户主动进行真实练习仍可能使用其现有模型或服务并产生对应费用。

## 更新、停用与卸载

刷新市场不会更新已经安装的副本。支持更新操作的宿主使用插件中心的更新入口；
旧宿主按其说明卸载旧资源、重新安装并重载会话。卸载本资源条目只移除指南、
入口声明、技能和命令等资源。

停用完整工程桥按配套项目指南分别处理宿主接入、Hermes 插件与智能体登记。资源卸载不会撤销身份权限或停止正在执行的工程。

## 来源与验证范围

上游为 [7oMB2006/hermes-engineering-bridge](https://github.com/7oMB2006/hermes-engineering-bridge)。
当前固定提交与文件哈希以社区市场的 `registry.json`、`registry.lock.json` 为准；
本说明由社区市场维护。所有新页面、展示清单和原始图标随固定来源同步并锁定。

0.3.0 的资源结构、固定只读声明、本地页面引用、已确认图标及未新增执行入口有自动化检查。
完整宿主和 companion 的既有验证不等于新入口已在所有已发布宿主可用，
也不代表新用户机器已完成安装、真实飞书新委托或连续过夜运行。
