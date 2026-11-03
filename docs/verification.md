# 市场验证记录

## BVR 收录候选（2026-11-04）

新增 `bilibili-video-research` 0.1.0 候选资源，固定来源
`7oMB2006/Bilibili-Video-Research@047cb9adc4f0227c29ece23449d5e651c3ad16ec`，
路径 `plugins/bilibili-video-research`。来源 PR 为 BVR #26，当前市场仍为收录草稿。
资源由同步工具通过 GitHub 固定提交取得并校验 Git blob，不使用本地文件伪造来源锁。
既有 Hermes 来源、资源和锁定记录未改动。

| 验证 | 结果与边界 |
| --- | --- |
| 市场静态校验 | 通过；两个资源条目与各自锁定内容一致 |
| Python 单测 | 21 项：20 通过，1 项宿主不允许符号链接而跳过 |
| BVR 类型检查与单测 | 类型检查通过，42 项测试通过 |
| BVR 来源 PR 云端 CI | Ubuntu 和 Windows 通过；Windows fixture 使用规范化临时目录，兼容 8.3 短路径 |
| 实际市场副本的原生发现、安装 | 通过；使用 DFSC 原生管理器，不是仅解析 JSON |
| PNG 图标、实际技能与 `/bvr` 加载 | 通过 |
| 真实 BVR MCP 初始化及三项工具声明 | 通过；没有发出 `tools/call` 或模型请求 |
| 卸载重装及私密配置保留 | 通过；显式 Plan 独立配置不变 |

本次运行使用 Windows x64 本地 DFSC 0.6.0 预览的实际
`resources/runtime`：Step pin `81e79bc4b699148d6823fedde9b5e70d9a80255f`
及其声明的 overlays，包含尚未发布的插件中心/BVR 宿主集成。
没有修改日常用户数据目录。验收通过 BVR 的
`scripts/verify-dfsc-plugin.mjs`，显式传入本市场目录与市场名
`dfsc-community`；没有另建一个 BVR 资源副本冒充市场条目。
本地 JSON 证据留在验收输出目录，不随插件上传。

这不等于真实账户、外部视频、媒体质量、ASR 可用性、计费或 macOS/Linux
验收。市场 PR 自身的云端检查与上述本地结果分别判断。
新的图形配置和跟随账户仍依赖另行审核、交付的 DFSC 宿主；
即使静态 CI 绿色，也不自动满足市场合入或公开可用条件。

## 早期私有联调（2026-10-28）

日期：2026-10-28。社区市场：`dfsc-community`，仓库：
`7oMB2006/dfsc-community-plugins`。当前实际收录一个资源插件
`hermes-engineering-bridge`，固定来源与逐文件校验值见根目录的 registry 和 lock。

## 普通 DFSC 0.6 原生检查

使用发布版提交 `195f10f906bd2d42ed8e1a86f91614f0cef8cbe2` 对应的普通 DFSC
macOS ARM64 实际应用，配合 `integration/verify-dfsc.mjs` 和一次性用户数据目录：

| 检查 | 本地目录来源 | 本地 Git 来源（file://） |
| --- | --- | --- |
| 原生市场读取清单并发现条目 | 通过 | 通过 |
| 界面安装、版本与图标 | 通过 | 通过 |
| 实际 Step Code 加载技能与帮助命令 | 通过 | 通过 |
| 卸载、重装及原有内置插件保留 | 通过 | 通过 |
| Git 更新市场 | 不适用于目录快照 | 通过 |

Git 检查使用本地 Git 传输，覆盖原生 clone、pull 和安装路径。它不等于已经验证
GitHub 私仓的网络访问和 Git 认证。当前机器的 GitHub 连接器访问权限也不自动成为
DFSC 调用 Git 时的读取凭据。

测试不调用模型、不发送飞书、不派工程，不修改真实账户、工程任务或原有应用配置。
本机证据在忽略目录 `test-results/`，包含 JSON、日志和安装界面截图，不作为用户
运行数据上传到仓库。

## 校验和维护工具

校验覆盖市场、登记、锁文件与资源副本的一致性；同步按完整提交读取并校验 Git
blob，离线模式核对已有锁定字节。回归另覆盖多插件、错误哈希、路径边界及失败
更新保留原版本。CI 在 Ubuntu 和 Windows 运行静态校验与 Python 单测，原生应用
检查需具备实际 DFSC 开发环境后单独执行。

## 已确认的上游边界

- 本地来源文件夹名需使用 `dfsc-community-plugins` 这样的安全名称，不能含空格。
- 首个原生运行时会准备 StepPage 等内置资源；验收先建立该基线，再比较社区插件
  安装和卸载是否保留原有资源。
- 当前更新市场不替换已安装副本；资源升级沿用卸载、重装和会话重载。
- 市场资源不安装 Hermes companion 或宿主能力。Windows 实机、私仓网络认证、
  真实飞书闭环和过夜工程没有由上述 Mac 测试证明。
