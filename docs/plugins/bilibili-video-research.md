# BVR 视频研究

Bilibili Video Research 的 DFSC 配套资源，版本 `0.2.0`。提供：

- BVR MCP 启动声明，工具包括 Bilibili 研究、本地视频分析和精确片段检查。
- `bilibili-video-research` 研究技能，区分语言、画面和多模态证据。
- `/bvr` 提示命令、项目图标及中英文使用说明。
- 通用宿主 v1 的跟随模式和声明式独立配置，不再使用 BVR 专用账户桥。

来源：`7oMB2006/Bilibili-Video-Research` 的
`plugins/bilibili-video-research`。完整固定提交和逐文件哈希见市场根目录
`registry.json` 与 `registry.lock.json`，资源由同步工具生成。
本页由市场维护，覆盖安装资源的技术 README；中英文用户指南仍来自原项目。
市场条目合入并刷新后才可发现新版，不表示已安装副本已经更新。

## 作者与展示声明

插件作者与封装维护者均由来源项目明确声明为 `7oMB2006`，与随包 MIT
许可证署名一致；不是根据仓库所有者推测。旧版的
`Bilibili Video Research contributors` 是来源文件中的泛称，本次修正为明确署名。

`dfsc.plugin.json` 还声明用途分类 `research`、`audio-video`，关键词
「视频研究」「字幕」「语音转写」，以及中英文简介、说明、社区教程和项目链接。
市场原样同步并锁定，不在 registry 或原生清单重复维护作者、要求或标签。
GitHub Star 由支持的宿主查询，作者不自报星数或下载量。

## 宿主与外部准备

`requirements.dfsc` 声明 `0.6.0`，但相同版本号的旧构建不一定兼容。
必须包含 `dfsc.host.json` 通用宿主 v1、模式选择、独立配置快照和启动授权。
缺少这些能力时不要升级到本资源；不会退回旧账户桥，也不承诺未来版本兼容。

| 准备项 | 是否必需 | 说明 |
| --- | --- | --- |
| Node.js 24+ | 必需 | 在运行 DFSC 的同一环境加入 PATH，插件不自动安装运行时 |
| 新版 BVR 本体与依赖 | 必需 | 本体须带 `dfscHostApiVersion: 1`，完成含开发依赖的 `npm ci`，并登记路径 |
| 模型访问与额度 | 必需 | 跟随模式需可用 Step 账户及逐项确认；独立模式自备连接，ASR 按需单独配置 |
| Bilibili Cookie | 可选 | 仅在匿名访问不足时使用自己授权的本地文件，不绕过内容权限 |

FFmpeg 和 yt-dlp 通常由 BVR 的 npm 依赖提供，无需各自手动安装。
只有内置 FFmpeg 无法使用时，才需要指定可执行文件的绝对路径。
这些是作者声明，不是本机检测、依赖安装、连接成功或账户授权结果。
资源更新不会下载 Node.js、克隆/更新 BVR 本体或执行 npm/pip。

Windows 通用宿主组合的已有验收基线是 DFSC main
`dcab32806645502250ba1c8efd56e153e95d657b`。本次同步又在
`b78af40b5d0b16c7fa6063ba9796e6bafed382aa` 的宿主模块与固定
Step runtime `29eb460780489801ce8afc8bffc1a2efae7cbded` 上检查市场资源。
这些提交用于说明测试范围，不表示所有 `0.6.0` 安装包都具备相同能力。
原生 macOS、真实账户/费用、实际 Bilibili 无字幕 ASR 和旧安装端到端升级未验证。

## 从 0.1.x 迁移

本版同时改变宿主声明、启动授权和独立配置协议，不是只补作者/要求字段，
也不是可以直接复用旧配置的一键升级承诺：

1. 先确认 DFSC 具备上面的通用宿主能力；旧版 DFSC 不应安装本资源。
2. 单独更新插件之外的 BVR 本体到带 `dfscHostApiVersion: 1` 的版本，
   完成 `npm ci`、`npm run build`、`npm test`。只更新市场插件不够。
3. 更新已安装的 BVR 资源，核对本体路径，再在插件配置中明确选择模式并保存。
4. 独立模式须重新核对并填写模型连接；按提示重启需要使用 BVR 的会话。
   跟随模式的首次能力调用仍需确认。

新启动器只复用旧 schema 1/2 配置的 `runtimeDirectory`。
旧 `mode`、`hostAccess`、`envFile`、Key 和确认记录不会自动迁移成新配置或授权。
原私密文件留在原处，不导入、不覆盖、不删除；下载选项也须明确核对后重新填写。
升级遇到错误会拒绝启动或调用，不静默退回旧桥、另一种模式或其他计费渠道。

## 安装与本体路径

新安装用户先准备上面的新版 BVR 本体，再在 DFSC 添加/刷新本社区市场，
在「发现」安装 Bilibili Video Research。资源目录不是本体运行目录。
使用随包工具只登记本机运行环境：

```powershell
node "<PLUGIN>/server/configure.mjs" --profile "<DFSC数据目录>/step-runtime" --runtime "<BVR本体绝对路径>"
node "<PLUGIN>/server/start.mjs" --check
```

`<PLUGIN>` 通常为 `<DFSC数据目录>/step-runtime/plugins/bilibili-video-research`。
所有路径使用本机绝对路径；已有设置默认拒绝覆盖，核对后才加 `--replace`。
该命令不再接受 `--mode`、`--env-file`，不写 Key、不导入私密文件。
`--check` 只检查本体路径、标记和依赖，不验证模型权益或发起付费请求。

路径保存在 Desktop 自有 `step-runtime/bvr/config.json`：

```json
{
  "schemaVersion": 3,
  "runtimeDirectory": "D:/Tools/Bilibili-Video-Research"
}
```

进入「插件 → Bilibili Video Research → 配置」，明确选择模式并保存，
再按提示重启会话。安装、启用 MCP、保存模式和 Full Access 均不是付费授权。

## 跟随 DFSC 会话

- 使用实际调用会话已经生效的官方 Step 账户、地区、Plan/API 渠道和模型，
  不使用尚未应用的预选值。
- 文本、视频和语音分别申请 `model.text`、`model.video`、`model.asr`。
  首次调用各项能力时由 DFSC 确认模型、渠道、数据发送和额度消耗。
  拒绝后不反复弹窗，不改用独立 Key 或其他计费渠道。
- 宿主代发请求，不交出 Step Key、OAuth 或 Cookie。
  插件仅持有绑定安装实例和单次启动的本地 bearer，不应共享启动上下文。
- 一次研究固定一个上下文 revision。账户、模型、模式、配置或启动失效后，
  旧请求拒绝，须明确重启；ASR 和后续总结不混用修订。
- ASR 是专用能力，不冒充聊天模型；当前 Step adapter 使用同地区/渠道的
  `stepaudio-2.5-asr`。能力可用性由宿主逐项报告，不承诺真实账户必有权益。
- 单次媒体上限 23 MiB；通用视频为 MP4/WebM，音频转换为 WAV。
  不支持的能力明确报错，不自动换模型、账户或渠道。
- 取消会传到等待确认和进行中的请求，但不能撤销已经发生的提供商计费。

跟随模式不读取独立配置或旧 `provider.env`。
可在本体路径文件中显式增加 `downloads`，设置 Cookie 文件、下载目录、
下载代理、优先字幕或 FFmpeg 路径，字段说明见来源中英文用户指南。
下载代理只用于下载链路，不承诺宿主模型请求也走它。

## 独立配置

配置页由公开 `dfsc.settings.json` / `json-file-v1` 协议生成，
与模式绑定到同一个已提交配置修订，不再通过 BVR 专用 CLI 写 Key。

- 主力连接显式选择 StepFun 或 Gemini，填写自己的 Key 和模型。
  StepFun 还须填写官方国内/海外 API/Plan 四种根地址之一。
- Step ASR 的地址、Key、模型独立填写，不能借用主力连接。
  三项全空时 Step 无字幕语音不可用，但字幕或视频路径仍可用；
  只填一部分会拒绝。Gemini 主力配独立 Step ASR 目前不支持。
- 两组连接的 Key 不回显，保留、替换和删除须明确提交。
  旧私密文件不自动导入，下载设置也不读取跟随模式的 `downloads`。
- 切换 DFSC 聊天账户不会把独立模式改成跟随模式。
  独立配置改变后，旧进程在下一次请求前拒绝继续使用旧 Key，
  ASR 与总结之间也重新检查。

两种模式均不在提供商失败、能力不可用或拒绝授权后自动回退。
其他客户端直接启动 BVR 时仍使用其原有独立配置方式。

## 数据、使用与停用

示例：`/bvr <公开视频链接> 总结讲述内容，并区分证据与推断`。
MCP 标识仍为 `bilibili-video-research__bvr`，工具、技能和命令名称不变。
技能不保证对每个任务自动触发。

BVR 会访问 Bilibili、使用本地文件、启动 Node/FFmpeg/yt-dlp 并下载临时媒体。
媒体、字幕、公开元数据和采样评论可能发送给选定提供商并消耗其额度；
评论属于不可信辅助信息。Cookie 只使用用户授权文件，不绕过付费或私密权限。
每次研究分配独立临时目录并按 BVR 逻辑清理，不代表任意失败均可恢复已发生费用。

服务开关只控制 MCP，不移除技能或命令。卸载插件不会删除外部 BVR 本体、
私密文件或运行环境设置，也不会停止其他客户端；按提示重新加载会话。
数据清理、日常应用重启均由用户另外确认。
更新市场和更新已安装副本是两件事；本体与 DFSC 也分别更新。

原生插件以当前系统用户权限运行，不是恶意本地代码沙箱。
收录、哈希锁或受控测试不保证全部安全、可用性、隐私或费用可控。
不要共享启动上下文、本地 bearer、Key、Cookie、配置、会话或日志。

## 许可证

BVR 代码与文字沿用项目 MIT 许可证。`server/host-client/` 同时保留
DFSC 标准客户端的固定来源记录和 MIT 许可，不省略被引用项目署名。
本次沿用 `0.1.1` 的插画图标；外侧白边透明处理，不改内部浅色细节。
提供插画本身不证明原创或授权，素材分发许可需独立核实，
不表示 Bilibili、StepFun 或 DFSC 官方背书。
