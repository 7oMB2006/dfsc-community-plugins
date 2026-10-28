# DFSC 社区插件市场

[7oMB2006/dfsc-community-plugins](https://github.com/7oMB2006/dfsc-community-plugins) 是供 DFSC 添加的社区市场源，市场名称为 `dfsc-community`。

仓库保存市场清单和经过维护者审核的插件资源。DFSC 获取清单后，在「发现」中展示条目，并从本仓库的插件目录安装。第一版采用 Git 仓库分发，提供收录、固定版本同步及校验流程；网页社区、用户账号、评分和自动审核尚未实现。

## 添加到 DFSC

1. 打开「设置 → 插件 → 市场来源」，选择「添加市场」。
2. 填入以下仓库地址。
3. 添加成功后切到「发现」，搜索插件名称并安装。
4. 根据 DFSC 提示开启新会话或重启当前会话，以加载资源。

```text
https://github.com/7oMB2006/dfsc-community-plugins.git
```

Git 来源需要本机可用的 Git。公开 Git 源可直接访问；私有 Git 源需要 DFSC 所调用的 Git 已有有效认证。仓库的实际可见性以 GitHub 页面为准。也可以将仓库下载或克隆到本机，在「添加市场」中填写包含 `.step-plugin/marketplace.json` 的本地目录绝对路径。

当前仓库先以**私有仓库联调**。浏览器或 Codex 的 GitHub 登录与 DFSC 调用的 Git 认证分别管理；未配置 Git 读取权限的机器可先用本地目录联调。

本地来源文件夹请保留 `dfsc-community-plugins` 这样的名称，不要添加空格。当前 DFSC 0.6 会根据文件夹名派生市场来源标识，包含空格的名称会被拒绝。

当前 DFSC 0.6 的市场入口接受 Git 来源和本地目录。ZIP 需先解压，再添加本地目录；GitHub Release 的 ZIP 下载链接不能直接作为市场地址。

## 首批收录

| 插件 | 资源版本 | 提供内容 | 配套要求 |
| --- | --- | --- | --- |
| [Hermes 工程桥协作资源](docs/plugins/hermes-engineering-bridge.md) | 0.1.0 | 工程证据技能、帮助命令与图标 | 完整派工另需 DFSC Hermes 0.6.0 宿主及 Hermes companion 0.2.0 |

工程桥的独立项目继续在 [7oMB2006/hermes-engineering-bridge](https://github.com/7oMB2006/hermes-engineering-bridge) 维护。本市场收录其中的 DFSC 资源目录；市场安装不会自动安装 Hermes companion、创建飞书机器人或授予工程权限。宿主安装器和 companion 按各自指南单独取得与安装。

## 更新与卸载

- Git 来源可在「市场来源」更新，获取最新市场清单和资源副本。
- 更新市场不会替换已经安装的插件。当前 DFSC 0.6 需卸载旧资源，再安装新资源，并按提示让会话重新加载。
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
