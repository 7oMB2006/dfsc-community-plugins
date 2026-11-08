# Hermes 工程桥

这是 DFSC 社区市场中的 `hermes-engineering-bridge` 资源插件，资源版本 **0.2.0**，许可证 **MIT**。

## 安装后提供什么

- Hermes 主视图入口：在支持插件桌面入口协议的 DFSC 中，从顶栏插件区域打开。
- 四页随包指南：开始使用、连接准备、第一项任务、排查问题；无须先打开私有仓库阅读入门内容。
- `hermes-engineering-evidence` 技能与 `hermes-bridge-help` 帮助命令。
- 插件自带图标与更新记录。

旧宿主仍可加载原有资源，不会因为安装插件自动获得新界面。新工作台须使用支持
桌面入口协议的宿主；不声称所有已发布 DFSC 安装包均已支持。
目标平台为 macOS Apple Silicon 和 Windows x64。

**入口出现只证明资源可以显示，不代表已连接或已配对。** 工作台当前展示本地指南，
不查询真实连接、任务或审批状态。完整工程派工需要另行取得
DFSC Hermes 0.6.0 宿主内置 Agent Bridge、Hermes companion 0.2.0，
以及使用者自己的 Hermes、模型和飞书环境，并完成独立身份、目录授权与配对。

## 安装与配套指南

在 DFSC 的「市场来源」添加社区市场，在「发现」安装 `hermes-engineering-bridge`。
安装后从插件详情或 Hermes 顶栏入口阅读“开始使用”；技能与命令的生效按宿主提示重载会话。
入门指南位于资源包的 `docs/START.md` 等文件，展示清单明确引用，不依赖被市场覆盖的 README。

工程桥项目单独维护：

- [项目与完整组件说明](https://github.com/7oMB2006/hermes-engineering-bridge)
- [配套安装、配对、重载及卸载指南](https://github.com/7oMB2006/hermes-engineering-bridge/blob/main/INSTALL.txt)

配套项目当前需要访问权限。无法打开时，应向维护者取得受支持宿主和 companion，
不要反复安装资源或使用不明来源的替代包。社区市场没有 companion 安装目录或
宿主安装器，不能用复制资源目录代替配套安装。
本次更新不修改 companion 运行代码、不增加模型请求、自动安装或权限。
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

0.2.0 的资源结构、本地页面引用和未新增执行入口有自动化检查。
完整宿主和 companion 的既有验证不等于新入口已在所有已发布宿主可用，
也不代表新用户机器已完成安装、真实飞书新委托或连续过夜运行。
