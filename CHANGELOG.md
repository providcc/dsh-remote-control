# 更新日志

本项目所有值得注意的改动都记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

## [未发布]

## [1.2.0] - 2026-10-03

### 新增

- **状态栏那颗 pill：点一下配对**。宿主侧多三条同域路由——`POST /plugins/dsh-remote-control/pairing/new`
  （幂等发码）、`GET /plugins/dsh-remote-control/pairing.png`（弹窗里那张二维码，按需现渲染，
  `no-store` + `ETag` 用同一口径的 epoch）、`GET /plugins/dsh-remote-control/status`（pill 抬头那句
  连接状态：`relay` / `paired` / `hasCode`）。浏览器面把一颗 pill 注册进宿主的
  `conversation.composer.dock` 槽位：平时显示连接状态，点一下当场发码并把二维码弹在同一颗按钮上方，
  6 位数字与 QR 同时在屏上（扫不出来时的唯一退路），寿命走完自动再要一张。
- 三条回答里**都不含 `psk`，也不含完整配对 URI**。发码那条是**会改状态**的路由，所以额外要求
  一个只有同源脚本发得出的自定义头 `x-drc-pair: 1`（跨站要带它必然触发 CORS 预检，而这条服务
  不答应预检）；`Origin` 存在时仍要判（环回 http(s) 或宿主自己的 `dsh-app:` 这类自定义 scheme），
  但**它缺席不是拒的理由**——桌面宿主转发 web 请求时会在更外层把 `origin` 头删掉，
  这一条是 2026-10-03 在真屏幕上点出来才发现的（当时判据写成"Origin 必须存在"，
  于是那颗 pill 渲染得好好的、点下去永远 403）。
- `status.json` 的 `sidebar` 多一个 `actions` 字段：pill 那三条路由的注册结果。

### 变更

- **`/drc pair` 降级成兜底**：pill 三条路由都挂上时，命令的 `hint` 去掉 `pair`，命令行也只把人
  指回那颗按钮（不顺手再发一张，否则绕过"屏幕上永远只有一张有效码"那条幂等语义）；宿主没有
  `webServer`、或那三条挂不上时，`pair` 自动回到命令行。开关判据是 `sidebar.available`。
  `pair force` 始终可用——那是"路由挂上了、那颗 pill 却因为宿主给不出 `react` / 没有 `slots`
  服务而没出现"时唯一不能堵死的退路；它走的是幂等入口，不会在 pill 之外多挂一张。
- 一次启动现在挂 **4 条**路由（右栏只读那条 + pill 那三条），停机一起注销。

### 兼容性

- 浏览器面拿 `react` 走**运行期**（模块名用变量，不经打包器静态解析）：拿不到只是少一颗 pill，
  不会变成"整页 web boot 失败"。`inject` 仍只声明 `sidebarRight`——把 `slots` 写进注入闸门等于
  给右栏那半加了一道会随宿主版本关死的门。
- 新增测试：`presentation-pair-actions.test.ts`（守卫、幂等、凭据缺席红线）、
  `presentation-client-bundle.test.ts` 里那颗 pill 的一段（在 vm 里真跑打出来的 `client.cjs`，
  含"拿不到 react / 探不到 slots 只许降级、右栏照旧"三条）。

## [1.1.0] - 2026-10-03

### 新增

- **右栏自动弹码进主插件**：一次构建产出两半——宿主侧 `dist/bundle/index.js` 与浏览器面
  `dist/bundle/client.cjs`。`/drc pair` 之后当前配对码落成 PNG、经一条同域只读路由交给浏览器面，
  右栏自动弹出那张图：不需要用户手动打开侧边栏，也不静默切换工作区。
- 配置项 `sidebarQr`（`enabled` / `imageFile` / `refreshMs`）；环境变量 `DRC_SIDEBAR_QR=0` 可整体关掉。
- `status.json` 多一块 `sidebar`：右栏那一半的软探测结果（`route=registered` / `webServer=none` /
  `disabled` / `register threw: …`）。"二维码没弹"从此有第一现场，而不是只能猜。
- `tests/presentation-isolation.test.ts`：同一个假上下文跑两遍 `apply()`，只差有没有 `webServer`，
  要求主链路可观察字段**逐个相等**、`/drc` 返回**逐字节相等**。

### 变更

- **删除 `packages/presentation`**，包名 `dsh-remote-control-presentation` 退役，本仓只剩一个包。
  原来拆两包只是为了在宿主没有 `webServer` 服务时"只有那一行不激活"；折成一个包之后这个隔离
  由代码提供（`src/presentation/sidebar.ts` 只软探测 `webServer`，拿不到就整半不起）。
- 只读路由随 bundle id 改名：`/plugins/dsh-remote-control-presentation/pairing` →
  `/plugins/dsh-remote-control/pairing`。同域、只读、环回+来源守卫三条不变。
  profile 里若还留着旧条目，`scripts/install-to-profile.sh` 会把它从 `dsh.profile.bundles`
  与 `node_modules` 一起摘掉——留着只会多一条"bundle 在列表里但目录已删"的加载失败记录。
- 发布产物收窄为 `dist/bundle` + `cordis.patch.yml`。`exports` 只指向自包含单文件，
  之前 tarball 里的 `dist/src`、`dist/tests`（约 90 个文件、449 KB）全是消费方拿不到的东西。

[未发布]: https://github.com/providcc/dsh-remote-control/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/providcc/dsh-remote-control/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/providcc/dsh-remote-control/releases/tag/v1.0.0

## [1.0.0] - 2026-10-03

### 新增

- DSH Remote Control 宿主侧插件的首次公开发布（npm 包 `dsh-remote-control`，本仓 monorepo 产出）。
- 与零知识中继的配对与长连接；主机认证与自动重连。
- 会话发现、指令下发、流式输出回传；审批（提问）转发到手机并可回答。
- 防休眠策略：有会话时保持唤醒，空闲后自动释放（`caffeinate` / `systemd-inhibit`）。
- 配对二维码渲染：默认出 **PNG**（文本码在 DSH 命令卡的行高下扫不出来），可落到会话工作区 `.dsh`。
- 本仓第二个 bundle `dsh-remote-control-presentation`（`private`，不发 npm）：把当前配对码落盘并
  暴露一条同域只读路由，浏览器面轮询它并**自动推开右栏**——不需要用户手动打开侧边栏，也不静默切换工作区。
- 状态快照 `status.json`（0600）作为 GUI 宿主的排错入口，密钥字段一律脱敏。
- 对宿主内核面的软探测：不写 inject 闸门，缺服务时受影响面最小。
- 自包含单文件产物（esbuild），安装只需拷文件 + 注册 bundle，profile 里不需要 `node_modules`。

[未发布]: https://github.com/providcc/dsh-remote-control/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/providcc/dsh-remote-control/releases/tag/v1.0.0
