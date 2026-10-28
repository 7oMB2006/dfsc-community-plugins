# Hermes 工程桥协作资源

这是 DFSC 社区市场中的 `hermes-engineering-bridge` 资源插件，资源版本 **0.1.0**，许可证 **MIT**。

## 安装后提供什么

- `hermes-engineering-evidence` 技能：工程协作和原生执行证据的验收规范。
- `hermes-bridge-help` 帮助命令：组件分工、连接入口与诊断说明。
- 插件图标及配套说明。

资源可由 DFSC 0.6 的原生市场加载。目标平台为 macOS Apple Silicon 和 Windows x64。

完整工程派工需要另行安装 **DFSC Hermes 0.6.0 宿主内置 Agent Bridge** 与 **Hermes companion 0.2.0**，并为每个智能体完成独立身份、目录授权与配对。安装本资源条目不会安装这些组件、注册飞书、派工或启用工程权限。

## 安装与配套指南

在 DFSC 的「市场来源」添加社区市场，在「发现」安装 `hermes-engineering-bridge`，再按 DFSC 提示让会话重新加载。

工程桥项目单独维护：

- [项目与完整组件说明](https://github.com/7oMB2006/hermes-engineering-bridge)
- [配套安装、配对、重载及卸载指南](https://github.com/7oMB2006/hermes-engineering-bridge/blob/main/INSTALL.txt)

配套项目若为私有仓库，需要获得其访问权限；维护者应另行提供所需宿主与 companion。社区市场中没有 companion 安装目录或宿主安装器，不能用复制资源目录代替配套安装。

## 更新、停用与卸载

更新社区市场后，当前 DFSC 0.6 需卸载旧资源再安装新资源，并按提示让会话重新加载。卸载本资源条目只移除技能、命令等资源。

停用完整工程桥按配套项目指南分别处理宿主接入、Hermes 插件与智能体登记。资源卸载不会撤销身份权限或停止正在执行的工程。

## 来源与验证范围

上游为 [7oMB2006/hermes-engineering-bridge](https://github.com/7oMB2006/hermes-engineering-bridge)，初始收录固定于提交 [`6b1dc36030c77b5c03d5454ce1a2c2583c704bf4`](https://github.com/7oMB2006/hermes-engineering-bridge/tree/6b1dc36030c77b5c03d5454ce1a2c2583c704bf4/plugins/hermes-engineering-bridge)。当前来源与文件哈希以社区市场的 `registry.json`、`registry.lock.json` 为准；本说明由社区市场维护。

既有资源已完成 macOS 原生市场发现、安装、技能／命令加载、卸载与重装检查。完整宿主另有双端原生验收；这些证据不等于新用户机器已完成安装、真实飞书新委托或连续过夜运行。
