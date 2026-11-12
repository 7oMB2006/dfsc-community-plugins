# 自定义背景

在兼容主题中使用自己的本机图片，保留主题配色与控件样式。
资源版本为 `0.1.0`，这是固定的 DFSC 宿主适配入口，
不是上传 CSS、JavaScript 或独立前端的通用插件。

## 宿主要求

需要包含 [DFSC #223](https://github.com/7oMB2006/desktop-for-step-code/pull/223)、
提供 `custom-background-v1` 的客户端构建。该实现已于 2026-11-12 合入主线，
不代表所有公开安装包都包含它；仅有市场入口或相同的 `0.6.0` 版本号不能证明支持。
旧客户端可能安装了资源，却不能打开背景配置或实际启用。

来源的 `dfsc.plugin.json` 尚未声明 `authors`、`requirements.dfsc`、
`requirements.external`，市场会保留这些提醒，不从仓库拥有者推断作者，
也不伪造兼容所有同版本构建的 semver 范围。
插件自身无需额外模型、MCP 服务或用户单独准备的 Node.js。
Git 市场获取仍需本机可用的 Git 与网络，这不表示个人背景需要联网运行。

## 安装与启用

1. 在 DFSC「插件 → 市场来源」添加本社区市场：
   `https://github.com/7oMB2006/dfsc-community-plugins.git`。
2. 在「发现」搜索 `custom-background` 或「自定义背景」并安装。
3. 打开该插件详情的配置页，导入一张 PNG 或 JPEG 图片。
4. 调整适应方式、位置、缩放、亮度、背景模糊与鼠标视差。

安装本身不会自动启用背景。导入图片后可在配置页关闭或再次启用。
标准界面及内置主题支持对话区、输入框、左栏、右栏独立透明度与界面毛玻璃。
透明度 0% 为实底，100% 移除该层遮色；文字、图标和焦点不随背景一起变淡或模糊。
输入区周围、底部状态区和摘要下方留白跟随主视图材质。
代码、菜单、审批及对话框保留阅读底色，内嵌网页和文件内容不强制透明。
亮度、模糊和透明度不能保证任意图片都具有足够文字对比度。

## 与主题的关系

内置主题允许个人背景；主题包必须明确开放 `image-v1` 背景插槽。
接受图片只允许替换底图，不授权背景插件修改主题 UI 或控件。
`stellar-v1` 等自带材质的界面仍由主题管理，不自动继承标准界面的分区透明度。

选择个人图片时，原背景释放，不同时叠加两套场景。
关闭个人背景后恢复主题默认背景。
切到未开放插槽的主题，图片和参数保留但不生效；切回兼容主题后恢复。
原版「星辰巡航」未开放替换，不应通过强制透明或修改清单绕过这一选择。
鼠标视差遵循减少动态效果设置，并在界面不可见时停止。

第一版仅支持单张静态 PNG/JPEG，不支持 WebP、GIF、视频、HTML、
远程图片地址或任意脚本。图片会经宿主解码并转存，
不是保留原始编码字节的无损文件备份工具。

## 数据、权限与停用

包内仅有三个声明 JSON、PNG 图标、README 与图标许可证，
显式声明空的技能、命令、Agent 和 MCP 列表，没有安装脚本或执行入口。
分类 `themes` 仅用于展示，不授予任何能力。

宿主校验安装记录、完整资源指纹及固定适配器声明后，才开放受限的图片配置入口。
插件本身没有文件系统、网络、Node.js、任意 IPC 或凭据访问权限；
用户明确选择的图片由宿主读取、解码并复制到 Desktop 私有资料目录，
不写入当前项目或插件安装目录。
不调用模型，不消耗套餐或独立 Key 额度，不向第三方上传个人图片，
也不会启动插件自带的后台进程。

关闭背景或卸载插件会停止生效；个人图片副本和参数保留。
重新安装后需要再次显式启用，不会自动恢复激活状态。
删除图片是单独确认的操作，只删除 Desktop 导入副本，不删除最初选择的源文件。
MiniChat 可显示共享背景，但不能导入、修改或删除图片。
市场更新不自动升级已安装副本；同 ID 只能保留一个有效安装。

这些说明不等于恶意代码沙箱、安全认证或对所有宿主构建的兼容保证。
遇到已知问题应关闭背景或停用插件，并按来源、宿主构建及复现步骤反馈。

## 来源与许可

来源为 `7oMB2006/desktop-for-step-code` 的
`theme-marketplace/plugins/custom-background`，固定到 #223 合并提交：
`ed7c6e46c5fdad85b678eff857ae0b39b96977ba`。
来源文件、原始 Git blob、SHA-256 和大小记录在 `registry.lock.json`。
资源由同步工具生成，本说明作为维护者审核的 README 覆盖；
不手工修改源资源或锁定哈希。

声明与文档适用来源仓库的 MIT 许可，完整通知保留如下。
图标是 Lucide `Wallpaper` 的 PNG，适用随包原样保留的 `ICON-LICENSE.txt`（ISC）。
本插件不分发用户图片、星辰巡航美术、字体或 Wallpaper Engine 内容。

```text
MIT License

Copyright (c) 2026 Desktop for Step Code contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 验证范围

功能依据为固定宿主提交的 Windows x64 体验包验收，包含导入、分区材质、
开放/关闭插槽、重启、卸载重装、MiniChat 权限及退出流程。
公共市场生成副本的安装验证另行记录，不把本地主题市场的通过当成公共来源已经上架。
命令、市场安装及未测边界见
[市场验证记录](https://github.com/7oMB2006/dfsc-community-plugins/blob/main/docs/verification.md)。

静态哈希和说明审核不替代宿主原生加载，也不代表真实账户、计费、
macOS/Linux、安装器升级或长期性能已经验收。
