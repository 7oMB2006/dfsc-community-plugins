# DFSC 社区插件市场

[7oMB2006/dfsc-community-plugins](https://github.com/7oMB2006/dfsc-community-plugins) 是供 DFSC 添加的社区市场源，市场名称为 `dfsc-community`。

仓库保存市场清单和经过维护者审核的插件资源。DFSC 获取清单后，在「发现」中展示条目，并从本仓库的插件目录安装。第一版采用 Git 仓库分发，提供收录、固定版本同步及校验流程；网页社区、用户账号、评分和自动审核尚未实现。

## 安全与使用边界

社区插件由各自作者维护。市场收录、固定提交、哈希校验及记录范围内的验证，
不能保证插件或其依赖的全部安全性、可用性、兼容性、隐私保护及费用可控。
原生插件可能以当前系统用户权限访问文件、网络或启动进程，不属于恶意代码沙箱。
使用外部模型或服务可能上传数据、消耗套餐额度或产生费用；市场收录不等于账户或付费授权。
安装或更新前请核对来源、版本、权限、依赖和费用说明；发现问题请停用并反馈。

维护者仍需审查来源、资源差异、许可证、风险披露及所报验证，处理已知问题并按需撤下。
“收录”“来源锁定”不等于完整安全认证，受控安装测试也不代表真实业务或所有依赖已验收。
投稿须按 [CONTRIBUTING.md](CONTRIBUTING.md) 说明依赖、数据和费用行为；
这份文档不表示所有现有客户端已增加相同的安装确认界面。

主题作者另读 [主题包投稿指南](docs/theme-authoring.md)，从 v2 示例开始，
区分 UI、默认底图与可替换插槽；一体化主题也可以保持关闭。

## 添加到 DFSC

1. 打开「设置 → 插件 → 市场来源」，选择「添加市场」。
2. 填入以下仓库地址。
3. 添加成功后切到「发现」，搜索插件名称并安装。
4. 根据 DFSC 提示开启新会话或重启当前会话，以加载资源。

```text
https://github.com/7oMB2006/dfsc-community-plugins.git
```

Git 来源需要本机可用的 Git。公开 Git 源可直接访问；私有 Git 源需要 DFSC 所调用的 Git 已有有效认证。仓库的实际可见性以 GitHub 页面为准。也可以将仓库下载或克隆到本机，在「添加市场」中填写包含 `.step-plugin/marketplace.json` 的本地目录绝对路径。

当前仓库为公开市场源。浏览器或 Codex 的 GitHub 登录与 DFSC 调用的 Git 认证分别管理；无法联网的机器可先用本地目录联调。

本地来源文件夹请保留 `dfsc-community-plugins` 这样的名称，不要添加空格。当前 DFSC 0.6 会根据文件夹名派生市场来源标识，包含空格的名称会被拒绝。

当前 DFSC 0.6 的市场入口接受 Git 来源和本地目录。ZIP 需先解压，再添加本地目录；GitHub Release 的 ZIP 下载链接不能直接作为市场地址。

## 首批收录

| 插件 | 资源版本 | 提供内容 | 配套要求 |
| --- | --- | --- | --- |
| [Hermes x DFSC](docs/plugins/hermes-engineering-bridge.md) | 0.3.0 | 顶栏状态面板、四步连接引导、随包指南与工程证据资源 | 需支持所选协议的 DFSC 构建、Hermes 与独立 companion 0.2.0；通用模式不依赖飞书 |
| [BVR 视频研究](docs/plugins/bilibili-video-research.md) | 0.1.0 | 视频研究 MCP、技能与 `/bvr` | 单独安装 BVR 本体与 Node.js 24+；跟随账户及图形配置另需 BVR 新宿主 |
| [星辰巡航](docs/plugins/stellar-cruise.md) | 0.1.0 | 双龙星海动态主题、石墨阅读面板与铅笔细线 | 需包含 DFSC #210、支持 `stellar-v1` 的客户端；安装后在「外观」手动启用 |
| [自定义背景](docs/plugins/custom-background.md) | 0.1.0 | 本机 PNG/JPEG、构图调节、鼠标视差及标准界面分区材质 | 需包含 DFSC #223、提供 `custom-background-v1` 的构建；安装后进入插件配置导入图片 |

工程桥的独立项目继续在 [7oMB2006/hermes-engineering-bridge](https://github.com/7oMB2006/hermes-engineering-bridge) 维护。本市场收录其中的 DFSC 资源目录；市场安装不会自动安装 Hermes companion、创建飞书机器人或授予工程权限。宿主安装器和 companion 按各自指南单独取得与安装。

BVR 继续在 [7oMB2006/Bilibili-Video-Research](https://github.com/7oMB2006/Bilibili-Video-Research) 维护。
市场只分发配套资源，不安装 BVR 本体、npm 依赖或任意插件前端。
跟随 DFSC 账户与图形化配置依赖单独的宿主集成，不能仅凭 `0.6.0` 版本号判断支持。
本次收录草稿需等待来源 PR 审核及宿主可用后再合入；草稿 PR 不代表默认市场已能发现。

## 更新与卸载

星辰巡航的完整介绍与预览见[主题说明](docs/plugins/stellar-cruise.md)。
它是声明式主题资源，不提供技能、MCP 或任意插件前端。
仅有插件市场或相同的 `0.6.0` 版本号不代表支持主题；宿主能力需单独核对。
安装不会自动切换外观，卸载正在使用的主题会回退到「原版深色」。

自定义背景是固定的宿主适配入口，不是另一个 UI 皮肤或可执行前端插件。
内置主题可使用个人图片；主题包必须明确开放 `image-v1` 插槽，
原版星辰巡航仍保持完整场景。未开放时图片与参数保留但暂停生效。
关闭或卸载背景插件会停止生效，重新安装后需再次启用。
插件尚未声明作者与版本范围字段；能力与数据保留边界见[完整说明](docs/plugins/custom-background.md)。

- Git 来源可在「市场来源」更新，获取最新市场清单和资源副本。
- 更新市场只刷新来源，不自动替换已经安装的插件。支持显式插件更新的 DFSC 宿主
  可在检查新版后由用户点击更新，保留原安装实例和已保存配置；来源冲突或不兼容的清单变化会拒绝覆盖。
  更新成功后仍需按提示重启会话，不表示正在运行的服务已经换成新版。
- 旧宿主可能只有卸载/安装入口；不能仅凭相同 `0.6.0` 版本号推断支持。
  使用旧入口前先核对配置和数据保留规则，不把卸载重装当作无损升级承诺。
- 本地目录来源会被复制为市场快照，不能通过 Git 自动更新；更新本地来源时需重新添加最新目录。
- 卸载工程桥资源插件只移除资源；完整工程桥的停用、companion 与宿主权限分别按配套指南处理。

## 仓库结构

```text
.step-plugin/marketplace.json  # DFSC 读取的市场清单，由同步工具生成
registry.json                 # 维护者审核的来源、固定提交与收录说明
registry.lock.json            # 上游文件哈希和来源锁定记录
plugins/<id>/                 # DFSC 实际安装的资源副本
docs/plugins/<id>.md          # 本市场的安装与依赖说明
scripts/                      # 固定版本同步与市场校验
tests/                        # 路径、来源、哈希和更新边界测试
```

市场条目的 `source` 指向本仓库内的相对目录。各插件可以在独立仓库开发；收录时由同步工具把指定提交的资源复制进本市场。只在清单里填写外部仓库链接不会自动完成跨仓库安装。

## 维护与验证

从仓库根目录运行：

```sh
python3 scripts/validate-marketplace.py --check
python3 -m unittest discover -s tests -v
npm ci --ignore-scripts
npm test
node scripts/check-plugin-metadata.mjs
node scripts/check-theme-pack.mjs
```

使用已有 DFSC 0.6 开发环境和实际应用做原生市场验收：

```sh
DFSC_DESKTOP_ROOT='/absolute/path/to/desktop/checkout/Desktop' \
DFSC_VERIFY_EXE='/absolute/path/to/app/executable' \
node integration/verify-dfsc.mjs /absolute/path/to/dfsc-community-plugins
```

最后一个参数也可使用市场 Git 地址。检查在一次性 DFSC 数据目录内验证市场发现、UI 安装、技能／命令加载、卸载和重装，证据写入 `test-results/`；不修改真实账户或工程任务。
本地 Git 工作目录会通过 `file://` 原生 Git 来源验证，避免把忽略文件复制进市场快照；这不替代 GitHub 私仓网络认证的单独检查。

按 `registry.json` 中固定提交同步一个条目：

```sh
python3 scripts/sync-plugin.py --plugin hermes-engineering-bridge
```

私有上游可通过已有的 `GH_TOKEN` 或 `GITHUB_TOKEN` 提供读取权限；工具不读取本机其他 CLI 账号的配置，也不把令牌写入清单。离线同步必须已有匹配的锁定记录：

```sh
python3 scripts/sync-plugin.py --plugin hermes-engineering-bridge --source-dir /absolute/path/to/plugin-directory
```

`--source-dir` 指向直接包含 `step.plugin.json` 的目录；文件清单与哈希须和锁定记录一致。修改来源提交、依赖或权限需求后，先审核变更，再运行同步、校验和测试。收录流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

仓库校验与受控安装检查分别记录。市场能够发现和安装一个条目，不表示该插件的外部服务、真实账户、飞书业务闭环或连续过夜运行已完成验收。

本次私有联调的实际范围见 [验证记录](docs/verification.md)。
