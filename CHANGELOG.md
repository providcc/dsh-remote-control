# 更新日志

本项目所有值得注意的改动都记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

## [未发布]

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
