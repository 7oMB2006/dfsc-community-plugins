# 上游来源与 vendor 记录

本文件记录本项目从上游 vendor 的代码及其验证方式。vendor 文件**保持逐字节一致，不做任何本地修改**；升级时按新固定 commit 重新拉取并更新本文件。

## src/lib/dfsc-config.mjs（json-file-v1 配置读取器）

| 项 | 值 |
| --- | --- |
| 上游仓库 | `7oMB2006/desktop-for-step-code`（MIT） |
| 固定 commit | `0a03b3f80b497cad3d55531171ace8c7cb381bb3` |
| 上游路径 | `examples/plugins/config-starter/plugins/dfsc-config-example/server/configuration.mjs` |
| 字节数 | 5619 |
| sha256 | `0228969c84d2b7f8943b41e0b14522b1b20dc2d374ea06ab603cd339a2e65c79` |
| 行尾 | LF |
| 拉取方式 | GitHub contents API + `Accept: application/vnd.github.raw`，`?ref=<固定 commit>` |

### 验证方式

```sh
# 重新拉取并比对（应输出一致）
node -e "fetch('https://api.github.com/repos/7oMB2006/desktop-for-step-code/contents/examples/plugins/config-starter/plugins/dfsc-config-example/server/configuration.mjs?ref=0a03b3f80b497cad3d55531171ace8c7cb381bb3',{headers:{Accept:'application/vnd.github.raw'}}).then(r=>r.arrayBuffer()).then(b=>console.log(require('crypto').createHash('sha256').update(Buffer.from(b)).digest('hex')))"
sha256sum src/lib/dfsc-config.mjs
```

2026-11-11 落盘时已与社区市场中 BVR 0.2.0 已部署副本（`step-runtime/marketplaces/dfsc-community-plugins/plugins/bilibili-video-research/server/configuration.mjs`）比对，sha256 一致。

### 使用方式与已知边界

- 构造器接收 `packageUrl`（插件根目录 URL），要求插件根位于名为 `plugins` 的目录下；`current()` 返回 `{ values, secrets, revision }`。
- 该文件同时导出 `clearInheritedCredentials()`，**本项目刻意不调用**：其 env 过滤正则（含 `^STEP` 与 `key` 子串）会删除本项目自己的配置通道（`STEP_API_KEY`、`STEPAUDIO_CONFIG_PATH`、`STEPAUDIO_PROFILE_DIR` 等）。防注入改由三层完成：`step.plugin.json` 的 sentinel、占位符识别、托管布局内忽略 env。此为已记录的偏离，评审时需主动说明。
- 随 esbuild 打包进入 `dist/index.mjs`，不新增运行时依赖。

## dist/THIRD_PARTY_LICENSES.txt

由 `scripts/build.mjs` 在每次构建时从 esbuild metafile 自动归集（bundled npm 依赖的许可证），请勿手工编辑。
