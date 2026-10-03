# 更新日志

本项目所有值得注意的改动都记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

## [未发布]

## [1.2.0] - 2026-10-03

这一版把"界面上那一半"收敛成**一条路**：状态栏那颗 pill。右栏自动弹码与终端文本码同时删除，
`/drc pair` 也不再是配对入口（**破坏性变更**，见下）。

### 新增

- **状态栏那颗 pill：点一下配对**。宿主侧三条同域路由——`POST /plugins/dsh-remote-control/pairing/new`
  （幂等发码）、`GET /plugins/dsh-remote-control/pairing.png`（弹窗里那张二维码，按需现渲染，
  `no-store` + `ETag` 用同一口径的 epoch）、`GET /plugins/dsh-remote-control/status`（pill 抬头那句
  连接状态：`relay` / `paired` / `hasCode`）。浏览器面把一颗 pill 注册进宿主的
  `conversation.composer.dock` 槽位：平时显示连接状态（`远程未启动` / `远程未连接` / `连接中` /
  `配对中` / `已连 N 台`），点一下当场发码并把二维码弹在同一颗按钮上方，6 位数字与 QR 同时在屏上
  （扫不出来时的唯一退路），寿命走完自动再要一张。
- 三条回答里**都不含 `psk`，也不含完整配对 URI**。发码那条是**会改状态**的路由，跨站判据是一个
  只有同源脚本发得出的自定义头 `x-drc-pair: 1`（跨站要带它必然触发 CORS 预检，而这条服务不答应
  预检）；`Origin` 存在时仍要判（环回 http(s) 或宿主自己的 `dsh-app:` 这类自定义 scheme），
  但**它缺席不是拒的理由**——桌面宿主转发 web 请求时会在更外层把 `origin` 头删掉，这一条是
  2026-10-03 在真屏幕上点出来才发现的（当时判据写成"Origin 必须存在"，于是 pill 渲染得好好的、
  点下去永远 403）。403 回答里因此带上**是哪一道守卫**（`guard:"pair-marker-missing"` 等），
  并由 pill 印在弹窗上：宿主 stdout 不落盘，屏幕上那句话是浏览器面唯一的现场。
- `status.json` 的 `pill` 探针（`webServer` / `routes` / `pill`）与一条 `warn:pill`：
  配对入口不可用时必须查得到原因——命令行兜底删了以后，"配不了对"不该是静默失败。
  那条 warn 是**每次写快照时现判**的，不是 `apply()` 里一次性 push：`webServer` 可能由
  `ctx.inject` 的回调晚到，一次性判断会留下 `routes:"registered"` 与 `problems:["warn:pill"]`
  并存的假警报（2026-10-03 真机重装重启后实测抓到，`presentation-isolation.test.ts` 里
  "webServer 晚到"那条用例钉住它）。
- 半途失败要回滚：三条路由依次挂，第二条挂不上时第一条**必须被注销掉**，否则它永久留在宿主上、
  `stop()` 再也拿不到注销函数，表现是"重载一次之后那颗 pill 再也不出现"。

### 删除（破坏性）

- **右栏自动弹码那一半整个删除**：宿主侧按节拍渲染 PNG 落到会话工作区、那条只读路由
  `GET /plugins/dsh-remote-control/pairing`、以及浏览器面 `sidebarRight.openResource` 的轮询。
  连带删掉的模块：`src/presentation/{address,presenter,route,sidebar}.ts`（守卫与 `pairingEpoch`
  搬进 `pill-routes.ts`，只留一份）。
- **终端文本码删除**：`platform/qr.ts` 的 `renderTerminalQr` 与 `ascii`/`block`/`half` 三种样式、
  ANSI 反色。理由是它在这个唯一宿主上从来扫不出——DSH 命令卡按 `line-height:1.6` 渲染等宽输出，
  行间留白把半块码横切成条，实测 zxing 在 ≥1.15 行距即失败（取证仍留在 `qr.ts` 文件头）。
- **`/drc pair` 不再是子命令**：`/drc` 只剩 `status` 与 `unpair`。它走的是"每次发一张新码"，
  会在 pill 那张之外再多挂一个仍然有效的 PSK，而手机扫的是屏幕上那张——正是当初"多码事故"的形状。
  打字习惯还留在 `/drc pair` 上的人拿到的是状态快照，不是错误。
- 配置键删除：`qrImage`、`qrOpen`、`qrAnsi`、`qrStyle`、`sidebarQr`（含 `imageFile`/`refreshMs`）。
  留在 patch 里**不产生任何效果**，也不会有 warn（当天先做过一张"退役键各报一条 warn"的表，
  随后按"删了就不会回来，用到再重写"撤掉——见下面"清理"那节）。环境变量
  `DRC_QR_IMAGE`/`DRC_QR_OPEN`/`DRC_QR_ANSI`/`DRC_QR_STYLE`/`DRC_SIDEBAR_QR` 同样删除，
  新增 `DRC_PILL=0/1`。
- **为右栏而开的内核口一起删除**：`provide('dshRemoteControl').sessionWorkspace`（"会话 → 工作区目录"
  那个口原来是给右栏那张图算落点的）、内核侧实现 `kernel.sessionWorkspace`，以及只为它存在的诊断字段
  `kernel.workspaceFace`。pill 的二维码是路由**当场渲染、当场回字节**的，不再往磁盘写，所以这条路上
  已经没有任何调用方。

### 变更

- 一次启动现在挂 **3 条**路由（1.1.0 是 1 条，pill 第一版是 4 条），停机一起注销。
- 浏览器面的服务声明从 `inject: ['sidebarRight']` 改为 **`inject: ['slots']`**（右栏那半删掉了，
  `slots` 才是这一半真正要的那个服务），写法照宿主自带的 `templates/decoration/client.js`：
  `ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(...))`。
- **删除过程中抓到并修掉一个真缺陷：那颗 pill 整颗不出现**。把声明改成空 `inject: []`（当时想
  让 `slots` 走软探测）之后，`apply()` 跑在槽位服务之前，而 `mountPill` 只软探一次就返回——
  屏幕上再也没有那颗按钮，而**当时 262 项单测全绿**（假上下文只给同步的 `ctx.get`，演不出"服务
  还没到"）。旧的 `['sidebarRight']` 无意中把激活时机推到了服务齐之后，所以第一版看起来是好的。
  现在三样一起有：`slots` 声明进 `inject`（正路）、软探测与 `ctx.inject(['slots'], …)` 的晚到回调
  两条退路（回调里只 mount 一次），以及一条能演"晚到"的测试（`presentation-client-bundle.test.ts`
  的 `lateSlots`/`flushInject`）。`apply` 时没探到的那句 warn 改成"已挂回调等晚到"，不再断言
  "这代宿主没这个服务"。
- **那颗 pill 在挤不动的那一排里不再逐字断行**。宿主 dock 空间不够时会把每一项自己截断
  （`6 轮 …`、`1.6M to…`），而按钮本身是 flex 项、默认可以缩到"中文的最小内容宽度 = 一个字"，
  于是 `已连 1 台` 竖着排成四行（2026-10-03 用户截图）。现在 `.drc-pill` 写死
  `flex: 0 1 auto; white-space: nowrap`，`.drc-label` 给 `min-width: 0` + `text-overflow: ellipsis`，
  与邻居同一个形状；全文仍然在 `title` 与 `aria-label` 上，悬浮和读屏都不丢。
- 配对二维码的编码/解码防回归（伞仓 `scripts/validate-qr.mjs`）从"三条产物"降到两条：
  PNG 与裸矩阵。

### 清理（同一轮，按"没用的就删，用到再重写"）

- **`apiProxy` 那条载体探都不探了**：这一版从一开始就不接它（桌面态没注册过这个服务，旧实现的
  调用信封整个是错的），却仍然 `ctx.get` + `ctx.inject` 各探一次、把结果收进 `collected` 里等一个
  永远不会来的调用方。现在这两块连同 `apiProxyOf()` 一起删掉，注释里写清"真要用再写"。
- **没人读的口与写盘遗物**：`writePrivateFile`（右栏那张 PNG 落盘时代的工具，现在只有测试调它）、
  `StatusFile.refreshing` 与 `StatusFile.path` 两个 getter（注释声称"测试读它"，实际零调用方）。
- **零消费者的导出**：`HISTORY_LIMIT_DEFAULT`（与 `runtime.ts` 里那份是同一个常量的两份）、
  `ports` 的 `PeerSink`/`PendingQuestion`/`TransportPort`/`AnswerItem`、`guard` 的
  `SubscribableEvent`/`WaterfallParticipant`、`qr.ts` 的 `qrModuleCount`，以及 `redactSecret` 与
  `redact` 这个双名导出（合成一个名字）。
- **退役配置键的 warn 表删除**（见上面"删除"那节），连带 5 条断言。
- 顺带清掉 `tsc --noUnusedLocals --noUnusedParameters` 报出的全部未用导入与未用局部。

### 测试

262 项（1.1.0 是 280 —— 那 280 里含 72 项属于这次删掉的两条路，另 3 项属于现在没人调的
`sessionWorkspace`）。删掉 5 个只属于那两条已删路径的测试文件；
`presentation-pill-routes.test.ts`（22 条）、`presentation-isolation.test.ts`（8 条，含
"配对入口只有 pill：两种宿主上 hint 都不许再宣传 pair"与"webServer 晚到时 warn:pill 必须自己消失"）、
`presentation-client-bundle.test.ts`（18 条，在 vm 里真跑打出来的 `client.cjs`，含"`slots` 晚到时那颗 pill 必须补挂"）。
伞仓 `e2e/run.mjs` 新增一步：**真中继在线**时点那三条路由——发码、幂等复点同一张、
出的 PNG 与主机维护的那张码同一个 epoch（单测里发码分支永远是"中继不可达"，那条路此前从没走过）。

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
