# 主题包投稿指南

新主题采用 `dfsc.theme.json` v2；旧 v1 继续兼容，不要求已有一体化主题开放替换。
需要包含主题组合协议的 DFSC 构建。相同的应用版本号不证明存在同一批能力，
市场收录和静态检查通过也不证明旧客户端能显示该主题。

宿主侧的 [中文快速入门](https://github.com/7oMB2006/desktop-for-step-code/blob/main/docs/THEME_AUTHORING.zh-CN.md)、
[独立 v2 起步包](https://github.com/7oMB2006/desktop-for-step-code/tree/main/examples/plugins/theme-starter)
与 [完整组合协议](https://github.com/7oMB2006/desktop-for-step-code/blob/main/docs/THEME_COMPOSITION.md)
是同一套作者路径。起步包与新指南须由包含它们的宿主源码提交交付；
旧 checkout 缺少文件不表示可以用旧星辰包代替新模板。

当前交付依赖 [宿主 PR #232](https://github.com/7oMB2006/desktop-for-step-code/pull/232)；
合入前，上述 main 新文件链接尚不保证可用，市场 PR 保持草稿。
提前审阅可使用固定候选提交的
[中文指南](https://github.com/7oMB2006/desktop-for-step-code/blob/26cbdaa0f2b9b6dc93f60a68841a74b231edfef2/docs/THEME_AUTHORING.zh-CN.md)
和 [起步包](https://github.com/7oMB2006/desktop-for-step-code/tree/26cbdaa0f2b9b6dc93f60a68841a74b231edfef2/examples/plugins/theme-starter)；
这不是宣称已经合入或发布。

组合协议与个人图片编辑器不是同一批交付：主线协议负责主题和插槽，
导入、编辑及分区材质由宿主 [自定义背景候选 PR #223](https://github.com/7oMB2006/desktop-for-step-code/pull/223)
提供。默认图片主题无需该编辑器；个人替换的验收须使用包含该适配的构建，
不能仅凭主题声明或市场收录宣称用户已有图片上传入口。

## 先决定组合方式

| 内容 | 清单字段 | 当前含义 |
| --- | --- | --- |
| 界面皮肤 | `ui.renderer` | 宿主已实现的 `standard-v1` 或 `stellar-v1` |
| 默认背景 | `background.renderer/source` | 纯色、包内 PNG/JPEG 或宿主星辰场景 |
| 允许替换 | `background.accepts` | `["image-v1"]` 接受个人图片；省略或 `[]` 保持关闭 |

使用图片作为默认背景，不等于开放个人图片替换。
可组合主题和一体化主题都欢迎；关闭插槽不是审核缺陷，不必强迫作者解耦。
分类 `themes` 只是展示信息，不授予插槽、执行权限或安装豁免。
`custom-background` 是宿主专用背景编辑适配，不是每个主题都要复制的插件身份。

底图插槽也不是 UI 材质插槽：保留 UI 皮肤、颜色和前景装饰，只替换默认底图。
在包含分区材质适配的宿主构建里，星辰 UI 的材质仍由其皮肤管理，
接受图片不会自动获得标准 UI 的透明度调节。
不要通过添加未知 CSS、React、HTML、`interactive` 或 `decoupled` 字段宣称支持新能力。

## 最小声明示例

```json
{
  "schemaVersion": 2,
  "name": "My Theme",
  "author": "Your name",
  "scheme": "dark",
  "colors": {
    "bg": "#141414",
    "side": "#0d0d0d",
    "surface": "#1f1f1f",
    "ink": "#e8e8e8",
    "muted": "#a4a4a4",
    "border": "#404040",
    "code": "#101010",
    "accent": "#64cbb2"
  },
  "ui": { "renderer": "standard-v1" },
  "background": {
    "renderer": "image-v1",
    "source": "background.png",
    "accepts": ["image-v1"]
  }
}
```

把实际图片放在同一资源根目录的 `background.png`。JPEG 使用 `background.jpg`，
不接受 `background.jpeg`、子目录、远程 URL 或 SVG。
纯色背景使用 `{"renderer":"solid-v1","accepts":["image-v1"]}`，不要写 `source`。
星辰背景需要受限数值数据 `scene.json`，不是任意 Three.js 项目。
星辰 UI 目前只支持 `scheme: "dark"`。

还须提供有效的 `step.plugin.json`、授权文件和安装/生效/恢复说明。
纯数据主题显式声明空的 `skills`、`commands`、`agents`，不声明 MCP 或执行入口。
带技能或 MCP 的混合插件不因有主题文件就成为纯数据主题，仍按普通执行能力审核。
`dfsc.plugin.json` 可声明真实作者、`categories: ["themes"]`、
已验证的宿主要求与 `requirements.external`；不要照抄未验证的版本范围。

## 大小限制与素材授权

| 限制位置 | 边界 |
| --- | --- |
| 本市场同步 | 每文件至多 8 MiB、每包至多 32 MiB、至多 1000 文件 |
| 宿主主题清单 | 至多 32 KiB 的 UTF-8 JSON |
| 宿主默认图片 | 输入及解码转存的 PNG 均至多 12 MiB，单边至多 8192，总像素至多 33,554,432 |
| 星辰场景数据 | `scene.json` 至多 6 MiB，几何结构另由宿主校验 |
| 可选封面 | `cover.png` 至多 512 KiB，宽至多 1920、高至多 1080 |

**投稿遵循更严格的市场 8 MiB 单文件上限，不是宿主的 12 MiB。**
文件小不代表解码转 PNG 后也小；原生解码仍可能拒绝图片，不会自动偷偷缩图。
当前不接受视频、HTML、WebP 或 APNG 背景。
`ink` 和 `muted` 对四个阅读表面都须至少 4.5:1 对比度。

为图片、字体、图标、场景和品牌分别说明来源及再分发许可。
渲染器的 MIT 许可不授予其他作者的画作或品牌使用权。
不要直接搬用星辰示例素材、用户个人壁纸或来源不明的图片。

## 在投稿前运行

取得包含主题专项检查的本市场源码，在仓库根目录执行：

```sh
node scripts/check-theme-pack.mjs --package /absolute/path/to/my-theme
```

Windows 可使用带引号的盘符绝对路径。此命令只依赖 Node 内置模块，
不执行插件代码、不启动模型、不读取用户账户，也不联网取得 schema。
默认不带参数时读取 `registry.json`，逐个检查已同步的主题包：

```sh
python scripts/validate-marketplace.py --check
python -m unittest discover -s tests -v
npm ci --ignore-scripts
npm test
node scripts/check-plugin-metadata.mjs
node scripts/check-theme-pack.mjs
```

Python 检查负责整个资源清单、来源锁和同步限制；
主题专项检查补充组合声明、色板对比度、引用资源存在性、体积与图片头部边界。
两项不是互相替代。只运行 `--package` 不代表已经检查完整市场清单和来源锁。

未知版本/引擎/替换类型、错误 v2 字段、低对比度、漏资源和超限默认图片会失败。
合法关闭插槽的 v2 主题通过；v1 提醒迁移但不会被强行拒绝；
可选封面失效给 warning，并保留宿主回退规则。
没有 `dfsc.theme.json` 的普通插件不进入主题检查。

静态检查不会校验图片全部压缩数据、原生色彩处理或完整星辰几何，
也不会证明可读性、无障碍、输入行为、生命周期或平台兼容。
图片头部检查通过不等于 native decoder 已经解码成功。
修正资源须回到上游、提交并重新固定 SHA、同步，不能改市场副本或锁定哈希绕过审核。

## 随 PR 提供的主题证据

在通用 [PR 模板](../.github/PULL_REQUEST_TEMPLATE.md) 的主题部分写明：

- 声明版本、UI 适配器、默认背景类型及 `accepts`，关闭时也明确写出。
- 已测宿主提交/构建、平台，图片和其他素材的可再分发授权。
- 发现 → 安装 → 外观中启用 → 重启保留 → 停用/卸载恢复的结果。
- 开放插槽时：默认 → 个人图片 → 跟随主题，UI 保留且只运行一个背景。
- 关闭插槽时：不支持替换的反馈，个人图片保留，默认背景不被覆盖。
- 窄屏、代码、长文本、输入框、菜单、审批和键盘焦点的真实可读性；
  动态主题另测关闭动态、减少动态、隐藏暂停及替换后的资源释放。

没有测过写“未验证”，不把静态绿灯当作原生安装、macOS 或真实交互验收。
市场维护者仍需审阅授权、源代码与实际组合，不仅检查 PR 是否勾选。

## 欢迎新范式

当前清单只选择宿主已有引擎。新互动背景、视频或完全不同的 UI 可以先做独立原型，
再在宿主引入经评审、版本化的新 renderer，明确资源、输入和生命周期边界。
协议不要求所有主题永远拆成图片，但未知引擎必须拒绝，而不是部分生效或执行自报脚本。
