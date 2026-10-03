# dsh-remote-control

[![CI](https://github.com/providcc/dsh-remote-control/actions/workflows/ci.yml/badge.svg)](https://github.com/providcc/dsh-remote-control/actions/workflows/ci.yml)
[![npm: dsh-remote-control](https://img.shields.io/npm/v/dsh-remote-control.svg)](https://www.npmjs.com/package/dsh-remote-control)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**DSH Remote Control** 的宿主侧——跑在 DeepSeek Harness 里的 cordis 插件。它把本机的 DSH 与
零知识中继配对，让微信小程序可以**发指令、看流式输出、回答审批**，全程载荷级端到端加密。

本仓**只有一个包**：`dsh-remote-control`（发 npm）。它一次构建产出**两半产物**——宿主侧
`dist/bundle/index.js` 与浏览器面 `dist/bundle/client.cjs`，都由
[`scripts/install-to-profile.sh`](./scripts/install-to-profile.sh) 装进 profile：

| 路径                                   | 包名                 | 分发方式         | 作用                                                                                                                                                                                 |
| -------------------------------------- | -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`packages/plugin`](./packages/plugin) | `dsh-remote-control` | **npm** + bundle | 主插件：配对、中继连接、会话与命令、审批转发、防休眠，**外加**界面上的那一半：状态栏那颗"点一下配对"的 pill，以及右栏自动弹码（配对码落 PNG + 四条同域路由 + 浏览器面 `client.cjs`） |

> 界面上那一半原来是独立的 `packages/presentation`（`dsh-remote-control-presentation`，不发 npm）。
> 拆包只是为了"某一代宿主没有 `webServer` 服务时，只有那一行不激活、配对/中继一行都不受影响"；
> 折成一个包之后同样的隔离由代码提供——`src/presentation/sidebar.ts` 只软探测 `webServer`，
> 拿不到就整半不起，`tests/presentation-isolation.test.ts` 用逐字段对照把这条钉住。
> 2026-10-03 加那颗 pill 时同一条规矩又用了一次：新那三条路由单独一个 try，它们挂了不许把
> 已经在跑的右栏弹码一起拖死；浏览器面拿 `react` 走运行期，拿不到也只是少一颗 pill。

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

配对：**点状态栏那颗 `dsh-remote-control`**，它会当场生成一张一次性码并把二维码弹在弹出面板里；
手机扫码即完成配对。那颗 pill 平时显示的是连接状态（`远程未连接` / `连接中` / `已连 N 台`）。

`/drc pair` 没有删掉，但降级成兜底：pill 三条路由都挂上时，命令的 `hint` 里不再出现 `pair`，
打 `/drc pair` 也只把人指回那颗按钮（**不顺手再发一张**——"屏幕上永远只有一张有效码"是配对能成事
的前提）。这时 `pair` 仍然接受 `force`：宿主给不出 `react`、或这代宿主没有 `slots` 服务时，路由
挂上了而那颗 pill 没出现，`/drc pair force` 就是那条不能堵死的退路（它走幂等入口，仍然只有一张）。
宿主没有 `webServer`、或那三条路由挂不上时，`pair` 自动回到命令行主路径
（`status.json` 的 `sidebar.actions` 会写明是哪一步没挂上）。右栏那条自动弹码（1.1.0）照旧在。

## 配置

插件读 `~/.dsh/profiles/<name>/cordis.patch.yml` 里的那一行，优先级为
**环境变量 > patch 里的 `config` > 内置默认值**。分发包自带的默认行见
[`packages/plugin/cordis.patch.yml`](./packages/plugin/cordis.patch.yml)。

| 键                         | 默认                    | 说明                                                                                   |
| -------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `enabled`                  | `true`                  | 关掉即整行不干活                                                                       |
| `serverUrl`                | `ws://127.0.0.1:8787`   | 中继地址。生产必须 `wss://`（写非回环的 `ws://` 只 warn 不拦，但明文链路上配对码可见） |
| `hostTokenEnv`             | `DRC_HOST_TOKEN`        | **token 所在的环境变量名**。token 本身不进 patch                                       |
| `hostLabel`                | `dsh-host`              | 手机上显示的主机名                                                                     |
| `keepAwake.enabled`        | `true`                  | 有会话时阻止系统休眠                                                                   |
| `keepAwake.idleReleaseSec` | `300`                   | 空闲多久后释放防休眠                                                                   |
| `unarchiveOnPrompt`        | `true`                  | 收到指令时自动取消会话归档                                                             |
| `takeOverQuestions`        | `false`                 | 提问接管（会**取代桌面 UI 的提问能力**，默认关）                                       |
| `approvalTimeoutSec`       | `180`                   | 审批等待上限                                                                           |
| `pairTtlMs`                | `120000`                | 向中继申请 PSK 的有效期；**服务端权威值会覆盖它**                                      |
| `qrImage`                  | `true`                  | 配对码出 PNG（文本码在 DSH 命令卡的行高下扫不出来）                                    |
| `sidebarQr.enabled`        | `true`                  | 右栏自动弹码 + 状态栏那颗 pill（两条都由这一开关管）                                   |
| `sidebarQr.imageFile`      | `~/.dsh/sidebar-qr.png` | 右栏那张图的**兜底**落点；正常落在当前会话工作区的 `.dsh/sidebar-qr.png`               |
| `sidebarQr.refreshMs`      | `2000`                  | 宿主侧看一眼"码换没换"的节拍                                                           |
| `conversationIdleTtlSec`   | `86400`                 | 空闲多久剪掉一条配对通道（不接受"永不剪枝"）                                           |

对应的环境变量覆盖见
[`packages/plugin/src/shell/config.ts`](./packages/plugin/src/shell/config.ts)（`DRC_SERVER_URL`、
`DRC_HOST_LABEL`、`DRC_QR_IMAGE`、`DRC_MOCK_BRIDGE` 等）。**键名刻意继承旧名**：它们写在用户的
profile 里，改名等于让线上配置静默失效。

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

测试就是普通的 `node --test` 文件，没有测试框架，运行期不做转译。动到二维码形状时务必盯住
`packages/plugin/tests/pairing-text.test.ts`（文本/半块码）与
`packages/plugin/tests/presentation-presenter.test.ts`（真渲染出 PNG magic bytes、落盘 0600）这两组；
动到右栏那条路由时盯住 `presentation-route.test.ts`（环回/来源守卫）与
`presentation-isolation.test.ts`（**缺 `webServer` 时配对链路必须逐字段不变**）；
动到状态栏那颗 pill 时盯住 `presentation-pair-actions.test.ts`（发码幂等、Origin 缺席也拒、
回答里不许出现凭据）与 `presentation-client-bundle.test.ts`（在 vm 里真跑**打出来的** `client.cjs`：
拿不到 react / 探不到 slots 时只许降级成"没有 pill"，右栏那半必须照常）。

## 安全

报告漏洞的流程见仓库根的 [`SECURITY.md`](./SECURITY.md)。**请不要为安全报告开公开 issue。**

可验证的安全边界就写在上面「加密模型」一节里：载荷密钥只经配对二维码交给手机、
从不上网，`hostToken` 只从环境变量读。重写期的设计推导不随本仓发布。

## 许可

[MIT](./LICENSE) © providcc
