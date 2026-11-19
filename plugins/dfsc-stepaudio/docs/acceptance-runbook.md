# 真机安装验收 Runbook（0.2.0）

> 目的：在市场收录前，用真实 DFSC 宿主验证 0.2.0 的安装、配置、合成与 fail-closed 全链。
> 隔离机制（抄官方 `integration/verify-dfsc.mjs`）：以 `DESKTOP_TEST_USER_DATA=<临时目录>` 启动 DFSC，**不动真实profile**。

## 执行记录（2026-11-14，已通过）

- 宿主：本机构建包（`win-unpacked`，main@2026-11-13 + #215–#238，构建记录见 `docs/host-build.md`）。
- 驱动：`node scripts/acceptance-host.mjs`（playwright `_electron.launch` + `window.desktop` API 驱动，base_url 指向本地 HTTP fixture，secret 用假 Key）。
- 结果：**17/17 通过**——启动/加本地市场源/安装/schema 8 字段/consumer.server/secret 必填/初始 unconfigured/保存 revision/宿主写 binding/安装含 dist/**按宿主设置合成成功**/Bearer 正确到达 API/请求体用设置音色模型/输出落设置目录/**改设置后 fail-closed**/卸载消失。
- 附带修复：验收后区分了“宿主未写配置绑定”（老宿主，提示升级）与“绑定失效”（提示重新保存）两种错误，补 1 个单测（61/61）。

> 残留未验（需真实 Key）：真实阶跃 API 的合成计费。上述链路已证明 Key 与请求体正确到达上游端点（fixture 捕获），真实计费留待用户持 Key 执行一次。

## 执行记录（2026-11-15，#247 broker 接入，已通过）

- 宿主：`main-20261115-036ae94`（`desktopBase` 即上游 #247 的 merge commit，r8+；runtime node v24.16.0）。
- **宿主官方发布验收**：`node Desktop/scripts/verify-stepaudio-release.mjs --source D:/StepFun/dfsc-StepAudio --runtime <win-unpacked>/resources/runtime --output <新目录>`（脚本本体取自我方 `efd3f4f`，按上游相对 import 闭包含 11 个 electron/scripts 模块，无仓库克隆）。**10/10 通过**：
  - 只读审计：开发目录按预期失败（`release-vcs`=.git、`release-runtime-dependency`=node_modules）
  - 白名单 staging：27 文件 / 778KB，audit ok
  - 原生市场安装 + 安装回执（`provenance: recorded`）+ MCP 服务 `dfsc-stepaudio__stepaudio` 可见
  - 官方 SDK stdio 握手、工具恰为 `clone_voice/list_voices/text_to_speech`
  - `list_voices(official)` 走本地目录（39 个内置音色）；空文本合成仅 1 次 fixture 请求（`/v1/audio/system_voices`），零第二次 API 请求、零外部模型请求
  - 原生卸载后目录消失
- **follow 模式（broker）**：`test/host-broker.test.js` 6 个离线用例全绿（mock broker：合成落盘宿主数据目录、参数拦截、DENIED、能力不可用、过期租约 STALE_CONTEXT 零请求、无上下文独立回归 + token 不泄漏）。全量 67/67。
- 附带修正：`npm test` 增加 `--test-concurrency=1`（broker 测试进程重，并行会互相拖超时）；发布 staging 排除 `test/`（离线 `testing.mjs` 不得进发布物）。

> 残留未验（需真实账户 GUI 回路）：宿主跟随模式在真实 Electron 宿主 + 真实 Step 账户下的端到端合成（首次授权弹窗、账户路由、真实计费）。上游同类验收使用假账户与合成音频字节；我方真实账户验证留待用户持账户驱动一次宿主实例。

## 0. 前置条件

| 项 | 要求 |
| --- | --- |
| DFSC 构建 | 包含 #215–#238 的 main 构建（设置页、托管读取、兼容更新都靠这些；`0.6.0` 版本号本身不证明包含） |
| Node.js | PATH 上 20+（宿主 runtime 为 24） |
| 凭据 | 一个可用的 Step Plan 或开放平台 API Key（真实合成用；前 5 步用假 Key 也能过） |
| 本插件 | 当前提交已 `npm run build` 且测试全绿 |

## 1. 启动隔离实例

```powershell
$profile = New-Item -ItemType Directory -Path "$env:TEMP\dfsc-accept-$(Get-Random)" -Force
# 参照官方种子：关闭遥测、fixture 提供商（聊天侧不需要真实账户）
New-Item -ItemType Directory -Path "$profile\step-runtime" -Force
'defaultProvider = "fixture"
defaultModel = "fixture"
[telemetry]
enabled = false' | Set-Content "$profile\step-runtime\config.toml"
$env:DESKTOP_TEST_USER_DATA = $profile.FullName
$env:DESKTOP_TEST_NO_FOCUS = '1'
# 然后启动 DFSC 可执行文件
```

## 2. 安装（本地市场源）

1. DFSC「设置 → 插件 → 市场来源 → 添加市场」→ 选**本地目录**，指向本仓库根（含 `.step-plugin/marketplace.json`，已备好）。
2. 「发现」应出现 **dfsc-stepaudio 0.2.0**（作者/版本/外部依赖 Node.js 展示正常即说明 #230 元数据链路通）。
3. 安装 → 按提示重载会话。

## 3. 设置页渲染（插件中心）

打开插件详情 → 配置，核对：

- [ ] 两个分组（连接 / 合成默认值）共 8 个字段全部渲染，中文标签与帮助文字正常
- [ ] `api_key` 是密码输入框；`output_dir` 是目录选择器
- [ ] **不填 Key 时保存**：应被 required 拦截（或保存后工具调用报“缺少 API Key”并指引本页）

## 4. 真实合成（核心路径）

1. 填真实 Key（模式 `openapi` + 开放平台地址，或 `stepplan`），保存，按提示重启会话。
2. 会话里对 agent 说：“用 `cixingnansheng` 念：智能阶跃，十倍每一个人的可能。”
3. 核对：
   - [ ] 返回音频文件绝对路径，文件存在可播放
   - [ ] 默认输出目录 = 设置里填的目录（或未填时的系统临时目录，**不在插件包内**）
   - [ ] 提供方账户侧能看到本次调用计费（证明 Key 真的到了上游）
4. 再验证默认值：设置里填 `voice=linjiajiejie` 后重启，说“念一句你好”——应使用新默认音色。

## 5. Fail-closed 与生命周期

- [ ] **改设置不重启**：保存后（不重启会话）再次合成 → 应返回“配置已变更，请重启服务”，**不**用旧值静默成功
- [ ] **重启后生效**：重启会话后用新设置合成成功
- [ ] **停用/启用**：服务开关停用后 MCP 不可用；启用+重启后恢复
- [ ] **卸载**：卸载后插件与 MCP 声明移除；**重装不继承旧 Key**（新实例需重新填写）
- [ ] **更新兼容**（如市场里有旧版本可更）：验证“检查更新”入口行为（0.2.0 为首个市场版本时此项跳过）

## 6. 证据留存

每步截图 + DFSC 日志，统一存到 `acceptance-evidence/<日期>/`（**不要提交进仓库**——含真实 Key 的页面必须打码或避开）。通过标准：第 3–5 步全部打勾。

## 7. 通过后

1. 在 `dfsc.plugin.json` 补 `requirements.dfsc`（填写本次验证过的宿主版本范围）
2. 按 `docs/market-submission.md` 推送仓库、刷新 SHA、提 registry PR
3. 决定 `.step-plugin/marketplace.json` 去留（保留可让用户直接以本地市场源安装本仓库；社区快照会含此文件）

## 已知不做（边界）

- 真实计费金额核对、ASR/Realtime 等其他模型能力（本插件只做 TTS）
- macOS / 非 Windows 自动释放（宿主侧能力，与插件无关）
- WebUI 工作台（0.3.0 范围）
