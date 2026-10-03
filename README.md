# dsh-remote-control

[![CI](https://github.com/providcc/dsh-remote-control/actions/workflows/ci.yml/badge.svg)](https://github.com/providcc/dsh-remote-control/actions/workflows/ci.yml)
[![npm: dsh-remote-control](https://img.shields.io/npm/v/dsh-remote-control.svg)](https://www.npmjs.com/package/dsh-remote-control)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**DSH Remote Control** 的宿主侧——跑在 DeepSeek Harness 里的 cordis 插件。它把本机的 DSH 与
零知识中继配对，让微信小程序可以**发指令、看流式输出、回答审批**，全程载荷级端到端加密。

本仓**只有一个包**：`dsh-remote-control`（发 npm）。它一次构建产出**两半产物**——宿主侧
`dist/bundle/index.js` 与浏览器面 `dist/bundle/client.cjs`，都由
[`scripts/install-to-profile.sh`](./scripts/install-to-profile.sh) 装进 profile：

| 路径                                   | 包名                 | 分发方式         | 作用                                                                                                                                                |
| -------------------------------------- | -------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/plugin`](./packages/plugin) | `dsh-remote-control` | **npm** + bundle | 主插件：配对、中继连接、会话与命令、审批转发、防休眠，**外加**界面上的那一半：状态栏那颗"点一下配对"的 pill（三条同域路由 + 浏览器面 `client.cjs`） |

> 界面上那一半原来是独立的 `packages/presentation`（`dsh-remote-control-presentation`，不发 npm）。
> 拆包只是为了"某一代宿主没有 `webServer` 服务时，只有那一行不激活、配对/中继一行都不受影响"；
> 折成一个包之后同样的隔离由代码提供——`src/presentation/pill.ts` 只软探测 `webServer`，
> 拿不到就整半不起，`tests/presentation-isolation.test.ts` 用逐字段对照把这条钉住。
> 那一半原来还带着"右栏自动弹码"（宿主按节拍渲染 PNG 落到会话工作区、浏览器面轮询后顶开右栏）；
> 2026-10-03 连终端文本码一起删了，**配对入口只剩这颗 pill**。

其余两半在各自仓库：[`dsh-remote-server`](https://github.com/providcc/dsh-remote-server)（零知识中继）、
`dsh-remote-mp`（微信小程序客户端）。三者共用
[`dsh-remote-protocol`](https://github.com/providcc/dsh-remote-protocol)（线协议；npm 包名 `dsh-remote-wire`，本插件以 npm 依赖消费）。

```
┌──────────────────┐  wss + host token   ┌────────────────┐  wss + 配对码   ┌────────────────┐
│  DSH 桌面主机      │ ─────────────────▶ │  relay server  │ ◀────────────── │ 微信小程序客户端  │
│  (本仓：插件)      │   只见密文与 6 位码   │                │                 │                │
└──────────────────┘                     └────────────────┘                 └────────────────┘
```

## 加密模型

中继看到的每个载荷都是 `base64(nonce ‖ secretbox)`，它**没有密钥**。载荷密钥（PSK）在本机生成，
只经配对二维码交给手机，从不上网。密钥派生、密封记录与配对 URI 的字节级契约由
`dsh-remote-wire` 冻结，本仓只消费它。

插件侧的关键约束：**host token 只从环境变量读**（`hostTokenEnv`，默认 `DRC_HOST_TOKEN`）。
它不写进 patch 文件——配置文件比环境变量更容易被顺手提交或贴进工单。

## 安装到 DSH profile

### 前置条件

`dsh-remote-wire` 是 npm 依赖，本仓以 `^1.0.0` 消费它，`pnpm-lock.yaml` 已提交、CI 用
`pnpm install --frozen-lockfile`。协议升版时走这三步：改 `packages/plugin/package.json` 里的版本
→ 跑一次 `pnpm install` → 把更新后的 `pnpm-lock.yaml` 一起提交。

插件不进 `node_modules`，而是打成**自包含单文件**装进 profile：

```sh
pnpm install          # 装依赖（含 npm 上的 dsh-remote-wire，按 lockfile 冻结）
sh scripts/install-to-profile.sh
# DSH_PROFILE=~/.dsh/profiles/tui sh scripts/install-to-profile.sh   # 指定其它 profile
```

脚本做三件事：用 esbuild 把两个包各打成一个文件 → 拷进 `$DSH_PROFILE/node_modules/<包名>/` →
把包名注册进 profile `package.json` 的 `dsh.profile.bundles`（幂等），并删除遗留的 `file:` 依赖
（那个会让 profile 里同时跑起**两个插件实例**）。

> **改代码后必须重启 Harness。** HMR 只热更 `cordis.patch.yml` 的配置，不会重新 import 产物；
> 浏览器面要**重新加载页面**才会重新拉 `client.cjs`。

配对：**点状态栏那颗 `dsh-remote-control`**（输入框那一排）。它当场生成一张一次性码，
二维码弹在同一颗按钮上方，6 位数字与图同时在场（扫不出来时手输是唯一退路），寿命走完自动换一张。
那颗 pill 平时显示的是连接状态：`远程未启动` / `远程未连接` / `连接中` / `配对中` / `已连 N 台`。

**命令行没有配对入口了**（2026-10-03 拍板）：`/drc` 只剩 `status` 与 `unpair`。删掉 `/drc pair`
不是嫌它多余——它走的是"每次发一张新码"，会在 pill 那张之外再多挂一个仍然有效的 PSK，
而手机扫的是屏幕上那张，取错密钥就全线解不开（当初"多码事故"的原样）。
终端文本码同日删除：DSH 命令卡按 `line-height:1.6` 渲染等宽输出，行间留白会把半块码横切成条，
实测 zxing 在 ≥1.15 行距就解不出来，也就是它在这个唯一宿主上从来扫不出。

配对入口不可用时**必须查得到为什么**：宿主没有 `webServer`、或那三条路由挂不上、
或 `pill.enabled:false`，都会在 `status.json` 里留下 `problems: ["warn:pill"]`
与 `pill` 那块探针（`webServer:"none"` / `routes:"register threw: …"` / `pill:"disabled"`）。
这条 warn 是**每次写快照时现判**的：`webServer` 可能经 `ctx.inject` 晚到，一次性判断会留下
"路由已 `registered` 却仍报配对入口不可用"的假警报（2026-10-03 真机抓到）。
浏览器面那一半（拿 `react`、拿 `slots`）失败只在 DevTools 里留一行 `[dsh-remote-control pill]` 的 warn；
`slots` 按宿主模板声明在 client 模块的 `inject` 里（**空列表 = apply 跑在槽位服务之前 = 屏幕上没有
那颗 pill**），软探测与晚到回调只是退路。

## 配置

插件读 `~/.dsh/profiles/<name>/cordis.patch.yml` 里的那一行，优先级为
**环境变量 > patch 里的 `config` > 内置默认值**。分发包自带的默认行见
[`packages/plugin/cordis.patch.yml`](./packages/plugin/cordis.patch.yml)。

| 键                         | 默认                  | 说明                                                                                     |
| -------------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `enabled`                  | `true`                | 关掉即整行不干活                                                                         |
| `serverUrl`                | `ws://127.0.0.1:8787` | 中继地址。生产必须 `wss://`（写非回环的 `ws://` 只 warn 不拦，但明文链路上配对码可见）   |
| `hostTokenEnv`             | `DRC_HOST_TOKEN`      | **token 所在的环境变量名**。token 本身不进 patch                                         |
| `hostLabel`                | `dsh-host`            | 手机上显示的主机名                                                                       |
| `keepAwake.enabled`        | `true`                | 有会话时阻止系统休眠                                                                     |
| `keepAwake.idleReleaseSec` | `300`                 | 空闲多久后释放防休眠                                                                     |
| `unarchiveOnPrompt`        | `true`                | 收到指令时自动取消会话归档                                                               |
| `takeOverQuestions`        | `false`               | 提问接管（会**取代桌面 UI 的提问能力**，默认关）                                         |
| `approvalTimeoutSec`       | `180`                 | 审批等待上限                                                                             |
| `pairTtlMs`                | `120000`              | 向中继申请 PSK 的有效期；**服务端权威值会覆盖它**                                        |
| `pill.enabled`             | `true`                | 状态栏那颗 pill = **配对的唯一入口**。关掉它这台主机就没有配对入口，会留一条 `warn:pill` |
| `conversationIdleTtlSec`   | `86400`               | 空闲多久剪掉一条配对通道（不接受"永不剪枝"）                                             |

对应的环境变量覆盖见
[`packages/plugin/src/shell/config.ts`](./packages/plugin/src/shell/config.ts)（`DRC_SERVER_URL`、
`DRC_HOST_LABEL`、`DRC_PILL`、`DRC_MOCK_BRIDGE` 等）。**留下的那些键名刻意继承旧名**：它们写在
用户的 profile 里，改名等于让线上配置静默失效。已经删掉的键（`qrImage`/`qrOpen`/`qrAnsi`/
`qrStyle`/`sidebarQr`）**不会静默失效**——留在 patch 里会在 `problems` 里各报一条 warn 并说清
现在叫什么或为什么没了。

排错入口是状态快照 `~/.dsh/dsh-remote-control/status.json`（0600）；关键字段 `carrier`
（`services` = 真内核 / `mock` = 内存替身 / `none`）、`relay`、`relayProblem`。

## 开发

```sh
pnpm install
pnpm typecheck        # tsc --noEmit（宿主侧 + 浏览器面两套 tsconfig）
pnpm test             # 先 build 再对 dist/tests 跑 node --test
pnpm build            # tsc + esbuild → packages/plugin/dist/bundle/{index.js,client.cjs}
pnpm format:check     # prettier --check
```

测试就是普通的 `node --test` 文件，没有测试框架，运行期不做转译。动到界面那一半时盯住三组：

- `presentation-pill-routes.test.ts` — 三条路由的判据：发码幂等、写路由的跨站判据是那个
  **同源才发得出的 `x-drc-pair` 头而不是 `Origin`**（桌面宿主会删 `origin`，真机量过）、
  回答里不许出现 `psk`/完整 URI、图片路由真的渲染出 PNG 字节、半途挂不上要回滚已挂的那几条。
- `presentation-isolation.test.ts` — 对照：同一份假上下文跑两遍 `apply()`，只差有没有
  `webServer`，主链路可观察字段**逐个相等**、`/drc unpair` 返回**逐字节相等**，
  差别只许出现在 `pill` 探针与那一条 `warn:pill` 上；`hint` 在两种宿主上都不许再有 `pair`。
  含一条 `lateWeb`：`webServer` 由注入回调**晚到**时，挂上之后 `warn:pill` 必须自己消失。
- `presentation-client-bundle.test.ts` — 在 vm 里真跑**打出来的** `client.cjs`：pill 注册进
  `conversation.composer.dock`、点击发码、图与 6 位码进面板、倒计时走完自动换码，
  以及拿不到 react / 探不到 slots 时**只许降级成"没有 pill"、绝不抛出 apply**。
  假上下文的 `slots` 既能同步给、也能演"晚到"（`lateSlots` + `flushInject`）——
  只给同步那条的 fixture 演不出"屏幕上没有那颗 pill"，2026-10-03 真机就是这么漏的。

二维码编码器本身的防回归在伞仓：`node scripts/validate-qr.mjs`（zxing-cpp 真解码，
PNG 与裸矩阵两条路径）。

## 安全

报告漏洞的流程见仓库根的 [`SECURITY.md`](./SECURITY.md)。**请不要为安全报告开公开 issue。**

可验证的安全边界就写在上面「加密模型」一节里：载荷密钥只经配对二维码交给手机、
从不上网，`hostToken` 只从环境变量读。重写期的设计推导不随本仓发布。

## 许可

[MIT](./LICENSE) © providcc
