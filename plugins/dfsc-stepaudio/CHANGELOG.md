# 更新记录

## 0.3.2

- 修复社区包启动问题：发布入口由 `dist/index.js` 改为 `dist/index.mjs`，避免市场安装目录缺少 `package.json` 时 Node 将 ESM bundle 误判为 CommonJS。
- 同步构建产物、`step.plugin.json`、bin、测试与验收脚本入口引用；Broker、独立配置与计费路由语义不变。
- 新增最终交付目录验收：从无 `package.json` 的交付目录以假宿主上下文启动，验证 `initialize` 与 `tools/list`，确认三个工具注册且零真实模型调用。

## 0.3.1

- 声明 DFSC `>=1.0.0 <1.1.0`：1.0.0 起正式搭载 v018 运行时、凭据隔离与 Broker；1.0.1 的 host-client/Broker 协议经核对无破坏性变化。
- 功能与 0.3.0 一致；本次为宿主正式版兼容与市场元数据更新。

## 0.3.0

- **适配宿主 `independentTools`（broker-v018）**：模型行与插件自有工具可分别选择 Step Plan、开放平台 API 或独立配置；合成按 Broker 分配路由，列音色/复刻使用独立配置，未分配模型行时明确拒绝。同步上游标准 client/protocol（支持空 `independentCapabilities`），新增混合来源、纯独立工具、独立 TTS 三类回归；全量 73/73。

- 新增**跟随宿主模式**（上游 #247，宿主 r8+，merge commit `036ae94`）：包内 `dfsc.host.json` 声明 `model.tts`，server 启动时消费宿主 `DFSC_LAUNCH_CONTEXT`；`text_to_speech` 可走宿主 broker 用当前会话官方 Step 账户合成，**零 Key**，首次合成等待宿主逐能力授权。
- 跟随模式边界：仅 `text`/`voice`/`response_format`（mp3/wav/pcm）三个入参、单次 ≤1000 字符、音频解码后 ≤16 MiB，写入宿主数据目录；`model`/`instruction`/`speed`/`sample_rate`/`return_url` 被忽略并在结果中以 `follow_ignored` 声明；`list_voices`/`clone_voice` 在跟随模式下返回需独立模式的提示（broker 无音色管理入口）。
- 模式语义：`follow` 与 `independent` 失败均不静默互切；租约过期（STALE_CONTEXT）需重启会话，不自动续约；无启动上下文（老宿主/外部启动）自动按独立模式运行，行为同 0.2.0。
- vendored 宿主标准 client（`src/lib/host-client/`，源自上游 `examples/plugins/host-client`，含 LICENSE）；离线测试助手 `testing.mjs` 只进 `test/`，不进发布物（staging 排除 `test/`）。已同步至上游 #253（broker 新增 `model.image` 能力；`model.tts` 调用链与 `parseLaunch` 契约不变，五文件与上游逐字节一致）。
- 测试：新增 `test/host-broker.test.js` 6 个 broker 离线用例（mock broker：合成落盘、参数拦截、DENIED、能力不可用、过期租约、无上下文独立回归、token 不泄漏）；全量 67/67。
- 发布卫生：通过宿主官方 `verify-stepaudio-release.mjs` 验收 10/10（原生安装、托管 fixture、官方 SDK stdio 握手、工具清单、本地音色目录、空文本零二次请求、原生卸载），宿主 `main-20261115-036ae94`，详见 `docs/acceptance-runbook.md`。
- **移除 `desktop` 工作区声明**（试用反馈：顶栏入口是噪点）：不再有“语音工坊”主视图入口与三个文档页；`docs/start.md`、`docs/voices.md`、`docs/recipes.md` 仍随包发布并经 README 可达。三个 MCP 工具与跟随模式不受影响。0.4.0 WebUI 落地时恢复声明。
- **市场评审第二轮修复（Codex review）**：
  - 托管安装下逐次 `output_path` 与 `output_dir` 同样禁止指向插件包内；路径在发起合成前解析校验，避免写入破坏包指纹后 fail-closed。
  - independent 启动上下文绑定 `configurationRevision`：上下文签发后配置被改则拒绝调用并要求重启会话，不静默改用新账户/计费渠道。
  - 新增两条端到端回归；全量 70/70。
- **声明 `requirements.dfsc: "0.6.0"`** 并按社区市场规范充实外部准备项披露（Node.js 运行时；模型访问与额度——独立 Key / 跟随账户、TTS broker 构建要求、计费说明）。真实宿主验收已全过（17/17 + 官方发布验收 10/10 + follow 真机 e2e）。
- **市场评审修复（Codex review）**：
  - `clone_voice` 的 preview 前置校验移至上传与创建之前——`preview=true` 缺 `sample_text` 不再先创建付费音色资产（9.9 元/音色）再报错；新增回归断言（零上游调用）。
  - 启动上下文**存在但无效**时拒绝一切工具调用，不再静默回退独立配置（那会更换账户与计费渠道）；仅上下文**缺失**（非宿主启动/宿主发布验收最小环境）时按独立模式运行。新增回归用例。

## 0.2.0

- 新增声明式配置 `dfsc.settings.json`（json-file-v1）：DFSC 插件中心内可直接配置后端模式、接口地址、默认模型、API Key、输出目录，以及合成默认值（默认音色、默认语境、输出格式）。按调用传参仍优先于配置默认值。
- `step.plugin.json` 的 env 占位符切换为官方 sentinel `DFSC_INDEPENDENT_PLUGIN`；旧占位符 `stepaudio-managed-provider-context` 继续识别。
- 附带本地 WebUI 工作台进入设计阶段（0.3.0 实现，见 docs/webui-design.md）。
- 修复：本地音色目录兜底路径在打包产物中失效的问题（0.1.0 基线后修复，随本版发布）。

## 0.1.0

- 首个可用版本：`text_to_speech` / `list_voices` / `clone_voice` 三个 MCP 工具。
- 官方 MCP SDK 开发、esbuild 自包含打包，分发产物 `dist/index.js` 无运行时依赖。
- 支持 Step Plan 额度与任意 OpenAI 兼容网关两种后端。
- 配置：环境变量直填或插件目录外 CLI 私密配置（`scripts/configure.mjs`）。
