# DFSC 接入文档

本文记录 dfsc-StepAudio 与 DFSC 的对接方式，约定以社区市场仓库 [7oMB2006/dfsc-community-plugins](https://github.com/7oMB2006/dfsc-community-plugins)（2026-11 现状，含 MCP 插件范例 `bilibili-video-research`）为准。

## 1. 插件清单：step.plugin.json

MCP 能力通过 `mcpServers` 段声明（字段取自 BVR 范例）：

```json
{
  "mcpServers": {
    "stepaudio": {
      "command": "node",
      "args": ["dist/index.mjs"],
      "env": { "STEPFUN_API_KEY": "DFSC_INDEPENDENT_PLUGIN" },
      "startup_timeout_sec": 60,
      "tool_timeout_sec": 300
    }
  }
}
```

- `args` 相对插件目录，指向**自包含打包产物** `dist/index.mjs`（官方 MCP SDK 已在开发期用 esbuild 打入，市场安装不执行 `npm install`，用户机器无任何 npm 依赖）。
- MCP 标识为 `dfsc-stepaudio__stepaudio`（插件 ID + 服务名）。
- `env` 里的 `DFSC_INDEPENDENT_PLUGIN` 是**官方非密钥哨兵**，必须写在宿主自动注入登录凭据所使用的变量 `STEPFUN_API_KEY` 上（对齐官方 config-starter / sdk-host-starter 范例）——写在其他变量名无法阻止宿主把真实凭据注入 MCP 子进程。取值等于任一已知哨兵（含 0.1.x 的自定义值 `stepaudio-managed-provider-context`）时服务视为"未配置"。
- 作者路线：官方 MCP SDK 开发 → `npm run build` 打包（含 `dist/THIRD_PARTY_LICENSES.txt` 许可证归集）→ 提交 `dist/` → 市场安装 → 插件中心预置配置 → 预留更新。

## 2. 两种模式

### 托管安装（DFSC 插件中心设置，0.2.0 起主路径）

`dfsc.settings.json`（json-file-v1 消费者）让宿主渲染配置表单，用户在插件中心填写：

- 8 字段 2 组：连接（`mode` / `base_url` / `model` / `api_key`(secret 必填) / `output_dir`(path 目录)）+ 合成默认值（`voice` / `instruction` / `response_format`）。
- 凭据由宿主保管：渲染层只见存在性，值只从宿主私有快照读取；`src/lib/dfsc-config.mjs`（vendor 官方读取器，固定 commit 见 `UPSTREAM.md`）每次工具调用前核对实例/包指纹/schema/绑定/revision。
- **托管布局下 env 与 CLI 私密配置一律不参与**；读取失败 fail-closed 并指引插件中心；输出目录不得在插件包内（会破坏指纹），缺省落系统临时目录。
- 宿主 #238 合并后：设置清单的展示调整（label/help）、保留旧值的 enum 扩展、无 default 的非秘密可选新增可随插件更新平滑迁移（保留秘密/false/空串/开关）；default 增删改、必填性变化、类型变化（含 secret↔text）仍被拒绝。

### 非托管场景（其他 MCP 客户端 / 本地开发）

`mcpServers.env` 放不了用户真实 Key，私密凭据保存在插件目录外：

```text
<profile>/stepaudio/config.json      # {"schemaVersion":1,"mode":"independent","envFile":"<绝对路径>"}
<任意插件目录外位置>/provider.env     # STEP_API_KEY=... 等
```

- 由 `node scripts/configure.mjs --profile <目录> --mode independent --env-file <绝对路径>` 写入，`--check` 复查，`--replace` 才允许覆盖。
- 解析顺序：环境变量直填（哨兵跳过）→ `STEPAUDIO_CONFIG_PATH` → 安装布局 `<step-runtime>/stepaudio/config.json`（本地开发用 `STEPAUDIO_PROFILE_DIR` 覆盖）。
- env 文件位于插件目录内一律拒绝（市场快照会公开它）；文件大小上限 128 KiB。
- 支持 Step Plan（`https://api.stepfun.com/step_plan/v1`）、开放平台（`/v1`）与任意 OpenAI 兼容网关（`STEPAUDIO_BASE_URL` 自定义）。

### 跟随 DFSC 模式（broker TTS，2026-11-15 起已接入）

DFSC 1.0+（v018 运行时，1.0.0 起正式搭载）提供受限官方账户 TTS broker，本插件已接入（`src/lib/host-client/` + `dfsc.host.json`）。1.0.1 的 host-client/Broker 协议与 broker-v018 一致；是否可用必须查 `context()`，不能只看声明或版本号。

**声明**：包内 `dfsc.host.json`——

```json
{
  "schemaVersion": 1,
  "hostApiVersion": 1,
  "consumer": { "kind": "mcp-stdio", "server": "stepaudio" },
  "capabilities": ["model.tts"]
}
```

`consumer.server` 与 `step.plugin.json` 的 `mcpServers.stepaudio` 一致；宿主用官方 `parseHostDeclaration` 校验（我们的清单无 url/transport/oauth/headers 等禁项，`STEPFUN_API_KEY` 哨兵不匹配 `DFSC_(HOST|LAUNCH)_` 命名空间）。

**启动**：server 入口创建一次 `createHostClient({pluginId, consumer})`，消费宿主注入的 `DFSC_LAUNCH_CONTEXT`（不复制、不打印、不转交；退出时 `host.close()`）。无启动上下文（如宿主发布验收的最小环境）时抛 `HOST_UNAVAILABLE`，服务降级为独立模式照常握手。

**来源分支**（两分支失败均不静默互切）：

| 启动上下文 | 合成 | 列音色 / 复刻 |
| --- | --- | --- |
| 旧版 `follow`（无 `independentCapabilities`） | 走 broker，零 Key，首次合成等宿主授权 | 不可用（broker 无音色管理入口） |
| `independentTools` + `independentCapabilities: []` | 已分配 Broker 模型行时走 broker，零 Key | 走独立配置 |
| `independentCapabilities` 包含 `model.tts` | 走独立 API Key 链路 | 走独立配置 |
| 未分配任何模型行 | 明确拒绝，不借用其他来源 | 独立配置可用时可用 |
| 旧版 `independent` / 无启动上下文 | 现有 API Key 链路（托管设置 / env / CLI 私密配置），核对 `configurationRevision` fail-closed | 可用 |

`dfsc.host.json` 声明 `independentTools: true`，让宿主把“插件自有工具”分配给独立配置，而不必占用模型行。宿主签发 `independentCapabilities: []` 时仍表示独立配置已启用；插件每次独立调用前核对配置修订。Broker 调用失败不改走独立配置，反之亦然。

**broker 调用序列**（每次 `tools/call`：`context()` 不产生模型请求，`invoke()` 首次触发宿主授权）：

```js
const context = await host.context();
const tts = context.capabilities.find(item => item.id === 'model.tts');
if (!tts?.available) throw new HostClientError(tts?.reason ?? 'CAPABILITY_UNAVAILABLE');
const result = await host.invoke({
  requestId: newRequestId(), revision: context.revision, capability: 'model.tts',
  input: { text, voice, format },
});
// result = { type: 'audio', mimeType, data(base64) }，插件自行解码落盘
```

**硬限制**：单次文本 ≤1000 Unicode 字符；`format` 仅 `mp3`/`wav`/`pcm`（对应 `audio/mpeg`、`audio/wav`、`audio/pcm`）；音频解码后 ≤16 MiB；`voice` 为专用模型支持的音色 ID 直接透传（克隆音色可用，宿主不预验证列表）；**不接受** `model`/`url`/Key/自选 headers/`outputPath`/`return_url`/上传或复刻参数，额外字段会被拒——因此跟随模式下这些入参被忽略并在结果中以 `follow_ignored` 声明。

**模型可用性按账户渠道**（2026-11-17 实测，1 字符合成）：Step Plan 路由仅 `stepaudio-2.5-tts` 可合成；`stepaudio-3-tts` / `step-tts-2` / `step-tts-mini` 返回 404（无权限）。开放平台路由（`/v1`）四模型均可用。宿主下拉列四个模型是 broker 支持清单、不等于账户权益；跟随模式选不支持的模型会在合成时明确失败（`PROVIDER_FAILED`），不静默降级——想用 3 系列需切独立配置 + 开放平台路由（按量计费）。

**授权与失效语义**：首次合成等待宿主逐能力确认；拒绝（`DENIED`）不反复弹窗；租约过期（`STALE_CONTEXT`）要求用户重启相关会话，不自动续约或重发；取消不保证已接受的提供商请求免费。播放、文件命名、落盘位置（`host.dataDirectory`，可用 `output_path` 覆盖）由插件负责；不把 base64 当 URL、文本或已存路径。

**验收**：`test/host-broker.test.js` 6 个离线用例（mock broker，假账户、合成字节）；宿主官方 `verify-stepaudio-release.mjs` 10/10 通过（见 `docs/acceptance-runbook.md`）。

## 3. dfsc.plugin.json（分类契约）

可选文件，市场按原始字节锁定：

- `schemaVersion: 1`；`categories` 取 1–3 个稳定 ID（`development`/`research`/`text-documents`/`knowledge`/`audio-video`/`image-design`/`automation`/`themes`），本插件用 `audio-video` + `automation`。
- `keywords` 最多 5 项，每项 ≤48 个 UTF-16 码元，本插件用「语音合成 / TTS / 音色复刻 / StepAudio / 配音」。
- 另可声明 `authors`、`license`、`documentation.readme`、`locales.zh/en.description`。分类描述用途，不代表能力类型或已配置状态。

## 4. 市场收录流程

1. 插件先在独立仓库开发发布；本目录可推为独立 repo。
2. 在社区仓库 `registry.json` 增加条目：上游仓库、**完整 40 位 commit SHA**、资源路径、license、readme 路径（`docs/plugins/dfsc-stepaudio.md`，会被同步工具用来替换资源目录内的 README）。
3. `python3 scripts/sync-plugin.py --plugin dfsc-stepaudio` 生成 `plugins/dfsc-stepaudio/`、锁定记录与市场清单；`python3 scripts/validate-marketplace.py --check`；`python3 -m unittest discover -s tests -v`。
4. 新能力形态需用一次性 DFSC 数据目录做原生验收：`node integration/verify-dfsc.mjs <市场目录>`，记录宿主版本与结果到 `test-results/`。
5. PR 说明用户得到什么、来源提交、依赖、许可证与实际验证范围。

注意：市场安装不升级宿主能力；旧宿主可能忽略 `dfsc.plugin.json` 的可选字段。

## 5. 宿主兼容边界

- 需要：支持原生插件、插件相对工作目录、并从 `step.plugin.json` 加载 `mcpServers` 的 DFSC 宿主；PATH 上可用的 Node.js 20+。
- 已验证：本仓库内 46 个单元测试（含 step.plugin.json / dfsc.plugin.json 契约、配置解析链、协议冒烟；协议测试启动实际打包产物）+ stdio 冒烟 + configure CLI 读写与拒绝路径 + 自包含验证（移走 node_modules 后 dist/index.mjs 仍能启动并响应 initialize/tools/list）。
- 未验证：真实 DFSC 宿主中的市场发现/安装/加载/卸载；真实 Step Plan key 下的合成、音色查询、复刻计费。这些需要宿主与凭据，按社区要求单独记录。

## 6. 本地联调

任意 MCP 客户端可直接以 stdio 连接。优先用分发产物（无需开发依赖）：

```sh
STEP_API_KEY=<key> node dist/index.mjs
```

开发期也可以直接跑源码（需先 `npm install` 装上 SDK 与 esbuild）：

```sh
STEP_API_KEY=<key> node src/index.js
```

或用环境变量直连 + 私密配置两种路径分别验证（`STEPAUDIO_CONFIG_PATH` 指向临时 config.json）。
