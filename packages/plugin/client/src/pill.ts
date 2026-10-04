/**
 * pill — 状态栏那颗 pill（浏览器那一半）。抬头那句话的现行口径见 `pillLabel`：
 * 没配上是 `远程未连接`、配上了是 `已连接`（2026-10-05 用户定的，早年的"未配对 / 已配对"已废）。
 *
 * 它做三件事：往宿主的 `conversation.composer.dock` 槽位注册一颗 pill，按节拍问
 * `GET /plugins/dsh-remote-control/status` 把连接状态写在上面，点击时弹面板。
 *
 * **面板的形状**（2026-10-03 重设计、2026-10-04 删掉中间那一屏）：**未配对点开直接就是二维码页**
 * （`POST /pairing/new` + `GET /pairing.png` 画进面板），**已配对点开是状态**——抬头一行状态 +
 * 右上角那**一颗**动作按钮，下面三行**中继 / 状态 / 版本**（各自拿不到值时那一行不占地方）。
 * 那颗按钮只按"配没配上"分两种身份：没配上是 `刷新`（幂等发码：码还在就还是它、过期了才换新的），
 * 配上了是 `退出配对`（`POST /unpair`）。原来"未配对 → 先按一颗「生成配对码」才出码"那一屏
 * 与那颗按钮一起删掉了：没配上时这一屏没有任何别的内容可看，多点一次没有换到任何东西。
 * 更早那版是四行"本机 / 中继 / 状态 / 已配对"，随后收成"只剩中继"、用户嫌单薄又补两条凑三行：
 * 留下的是"连的哪一台 / 连没连上 / 跑的是哪一版"，本机名与台数不上屏——抬头那句已经是状态，
 * 台数只可能是 0 或 1。`再配一台`、`换一张` 与"倒计时走完自动补一张"也在这一轮删掉了：
 * 一张码过期后该重发还是让用户自己按。
 *
 * 颜色就是状态：灰（未启动 / 远程未连接）、黄（连接中）、绿（已连接）、**红（已断开连接）**。
 *
 * 三条形状上的决定都有据可查，不是随手挑的：
 *
 * 1. **`slots` 按宿主模板声明进 `inject`，并且留软探测当退路**。宿主自带的
 *    `templates/decoration/client.js` 就是 `inject: ['slots']` + `ctx.slots.inject(...)`；
 *    不声明的话 `apply()` 跑在槽位服务之前，那颗 pill 整颗不出现（见 `mountPill` 的注释，
 *    2026-10-03 真机踩过）。声明成闸门换来的正是"激活时机在服务之后"，而软探测与注入回调
 *    留着，是为了在"这一代宿主没把 slots 当服务给"时还能挂上、并且留下一行 warn 说清原因。
 * 2. **react 只用来 `createElement`，而且是运行期向 loader 要**（`__drcRequire`，见
 *    `scripts/bundle-plugin.mjs` 的外壳）。静态 import 的解析失败发生在 factory 顶层，
 *    那是"整页 web boot 失败"的形状（真机踩过：`web boot: N entry/entries did not activate`）；
 *    运行期拿不到就只是没有 pill。**不用 hooks**：组件只返回一个带 `ref` 的空 `<span>`，
 *    UI 全由下面那段 DOM 管——`ref` 回调身份稳定，宿主重渲染 dock 不会把我们这块拆掉重建。
 * 3. **图走同域 HTTP，不走 `dsh-resource://`**。pill 里一个 `<img>` 能不能吃那个自定义
 *    scheme 没有证据，而 `/plugins/**` 是必然可行的那条路。
 *
 * 纪律与主文件同一条：**任何一步抛出都只留一行日志，绝不把异常抛进 loader**。
 */

/** pill 用到的四条路由（宿主侧定义在 `src/pill/routes.ts`，字符串必须一致）。 */
export const STATUS_ROUTE = '/plugins/dsh-remote-control/status'
export const NEW_ROUTE = '/plugins/dsh-remote-control/pairing/new'
export const IMAGE_ROUTE = '/plugins/dsh-remote-control/pairing.png'
export const UNPAIR_ROUTE = '/plugins/dsh-remote-control/unpair'

/** 槽位与条目 id：抄 `conversation.composer.dock` 那个已验证的用法。 */
export const SLOT_NAME = 'conversation.composer.dock'
const PILL_ID = 'dsh-remote-control'
/** 排在宿主自带的 stats(0) 与 provider-usage(10) 之后——加进去的东西不该挤掉原有的。 */
const PILL_ORDER = 20

const STYLE_ID = 'dsh-remote-control/pill.css'
const POLL_MS = 2000

interface SlotRegistry {
  inject(slotName: string, callback: () => void): unknown
  register(definition: Record<string, unknown>, component: unknown): unknown
}

interface Gettable {
  get?<T>(name: string, optional?: true): T | undefined
}

interface PillHost extends Gettable {
  /** 声明在模块的 `inject` 里之后才可读（宿主模板就是这么写的）；没声明时读它会抛。 */
  slots?: unknown
  inject?(names: string[], callback: (scoped: unknown) => void): unknown
  effect?(execute: () => (() => unknown) | void): unknown
}

/** 只用到 createElement——不需要 hooks，见文件头第 2 条。 */
export type CreateElement = (type: unknown, props: Record<string, unknown>) => unknown

interface StatusAnswer {
  relay?: unknown
  paired?: unknown
  pairings?: unknown
  serverUrl?: unknown
  version?: unknown
  waiting?: unknown
  waitingOldestSec?: unknown
}

interface NewAnswer {
  state?: unknown
  token?: unknown
  expiresInMs?: unknown
  epoch?: unknown
  reason?: unknown
  error?: unknown
  guard?: unknown
}

/**
 * 面板该显示什么：`POST /pairing/new` 的几种回答收成一个可判别的形状。
 *
 * 单独成函数是因为这里有一条**不许靠 HTTP 状态码判成败**的判据：中继不在时那条路由回的是
 * 200 + `state:"unavailable"`，按 `response.ok` 分支会把它当成功，然后弹一张没有图的白框。
 */
export function panelViewFor(answer: NewAnswer | undefined, httpStatus: number): PanelView {
  if (!answer || typeof answer !== 'object') return { kind: 'failed', detail: `HTTP ${httpStatus}` }
  if (answer.state === 'ready') {
    const token = typeof answer.token === 'string' ? answer.token : ''
    const epoch = typeof answer.epoch === 'string' ? answer.epoch : ''
    const expiresInMs = typeof answer.expiresInMs === 'number' ? answer.expiresInMs : 0
    if (token === '' || expiresInMs <= 0) return { kind: 'failed', detail: '发码回答里的码不完整' }
    // epoch 进 URL：一张码会被就地换掉，缓存任何一版都是让弹窗停在废码上。
    return { kind: 'qr', token, expiresInMs, imageSrc: `${IMAGE_ROUTE}?e=${encodeURIComponent(epoch)}` }
  }
  if (answer.state === 'unavailable') {
    return {
      kind: 'unavailable',
      reason: answer.reason === 'relay-offline' ? '中继还没连上，暂时无法配对。' : '现在发不出配对码。',
    }
  }
  return {
    kind: 'failed',
    // 把宿主说的那道守卫一起印出来：这条路由在浏览器里点，屏幕上的这句话就是唯一的现场。
    detail:
      typeof answer.error === 'string'
        ? typeof answer.guard === 'string'
          ? `${answer.error}（${answer.guard}）`
          : answer.error
        : `HTTP ${httpStatus}`,
  }
}

export type PanelView =
  | { kind: 'info' }
  | { kind: 'loading' }
  | { kind: 'qr'; token: string; expiresInMs: number; imageSrc: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; detail: string }

/**
 * 状态 → pill 上那一句。顺序就是优先级：先说连不上，再说配没配上。
 *
 * 抬头那句只说**结论**，不说数量也不说进度：`已连 N 台` 在那一排被压窄时会竖着断行（真屏幕
 * 踩过，见 CSS），而"配对中"这种中间态写在抬头上没人看得懂——码是不是还在、还剩几秒，
 * 点进去的弹窗里都有（面板抬头读的就是这一句，同一份来源）。所以"没配上"的两种情形
 * （没有效码 / 有码还没人扫）合成一句 `未配对`，灯跟着走灰色：灰色才是"还没配上"的颜色。
 * 2026-10-04 添了第三种：**手机离线**（簿里还有会话、一台都没连着）——配对按 D3 长存，
 * 那不是"没配上"（见下面那一支）。
 *
 * 四种 tone 就是四种颜色：`off` 灰（未启动 / 远程未连接）、`wait` 黄（连接中）、`on` 绿（已连接）、
 * `error` 红（已断开连接）。2026-10-03 用户按真屏幕要的：断链必须红，不能和"没配上"同一个灰。
 */
export function pillLabel(status: StatusAnswer | undefined): { text: string; tone: 'off' | 'wait' | 'on' | 'error' } {
  const relay = status?.relay
  if (relay === 'idle') return { text: '远程未启动', tone: 'off' }
  // 断链是**故障**不是"还没配"，所以它单独一档、单独一个红：灰色会被读成"还没轮到配"。
  if (relay === 'offline') return { text: '已断开连接', tone: 'error' }
  if (relay === 'connecting') return { text: '连接中', tone: 'wait' }
  if (relay !== 'online') return { text: '远程控制', tone: 'off' }
  const paired = typeof status?.paired === 'number' ? status.paired : 0
  // 2026-10-05 用户定的口径：抬头只说"连没连上"，不说"配没配"——"已配对"对
  // 第一次用的人不解释任何事，"已连接"才直接回答"现在能用了没有"。
  if (paired > 0) {
    // 有东西挂在手机上等回答时，`已配对` 这句话等于没说——那条回合正停在这台机器上，
    // 而这颗 pill 是它在桌面上唯一可能被看见的地方（判据见伞仓 docs/PRODUCT.md §3）。
    // 只在**确实配着**的时候抢这一格：手机中途掉线、挂起还没超时时，
    // 用户能做的第一件事是重新配对，那才是该说的那句。
    const waiting = waitingCount(status)
    if (waiting > 0) return { text: `等 ${waiting} 件事`, tone: 'wait' }
    return { text: '已连接', tone: 'on' }
  }
  // 一台都没连着、但密钥簿里还有会话 = **配过对，手机只是不在线**（小程序退后台、手机关屏）。
  // 配对按 D3 长存且 pair-store 落盘，手机回前台自动重连——这不是「没配上」：
  // 那一态说「未配对」是让用户去扫一个不需要扫的码（2026-10-04 用户报的误解）。
  // 灯走黄（wait）：不是故障，也不是「可以用了」，是「等它自己回来」。
  if (pairingCount(status) > 0) return { text: '手机离线', tone: 'wait' }
  // 2026-10-05 用户定的口径："远程未连接"而不是"未配对"。"配对"是内部动作，
  // 第一次装好插件的人不知道自己要"配对"；"远程未连接"直接说清了现在
  // "这台机器还没接上手机"——也顺手回答了那颗 pill 点开能看到什么。
  return { text: '远程未连接', tone: 'off' }
}

/** 挂在手机上等回答的件数。老版路由没给这个字段时算 0（那一行自己不占地方）。 */
export function waitingCount(status: StatusAnswer | undefined): number {
  const count = status?.waiting
  return typeof count === 'number' && count > 0 ? Math.min(Math.floor(count), 99) : 0
}

/**
 * 密钥簿里还有几条会话 = 「配对还在不在」。
 *
 * 与 `paired`（此刻有几台手机连着）是两件事：手机关了小程序只是 socket 断，
 * 簿还在、回前台自动重连（pair-store，D3）。老版路由没这个字段时算 0——
 * 那一态退回「未配对」：宁可把「没配上」说轻，也不把「没配上」说成「配上了」。
 */
export function pairingCount(status: StatusAnswer | undefined): number {
  const count = status?.pairings
  return typeof count === 'number' ? count : 0
}

/** `37 秒` / `4 分 12 秒` / `12 分`。十分钟以上不再报秒——这行是扫一眼的，不是秒表。 */
/**
 * 二维码那一屏顶上那句引导。规则只有三条：**一条、短、不带符号**。
 *
 * 一条：这一屏只教一件事——码是给小程序扫的、扫完能远程控制这台电脑；
 * 短：扫一眼就要读完，长句会被当成服务条款直接跳过；
 * 不带符号：顿号冒号书名号全不用，空格就是分隔（2026-10-05 用户定的口径，
 * 括号等符号会让一行"系统提示"更像错误而不是引导）。
 */
const GUIDE_LINE = '打开小程序扫这个码 远程控制这台电脑'

export function humanDuration(sec: unknown): string {
  const total = typeof sec === 'number' && sec > 0 ? Math.floor(sec) : 0
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  return minutes >= 10 ? `${minutes} 分` : `${minutes} 分 ${total % 60} 秒`
}

/**
 * 正文那一行"待处理"的值：`2 件 · 最久 4 分 12 秒`。没有事在等时返回空串（那一行不建）。
 *
 * 手机上看的是"还剩多久"（那颗倒计时），这里看的是"已经等了多久"——
 * 同一段时间，两端要回答的是两个不同的问题。
 */
export function waitingRow(status: StatusAnswer | undefined): string {
  const count = waitingCount(status)
  if (count === 0) return ''
  const oldest = typeof status?.waitingOldestSec === 'number' ? status.waitingOldestSec : 0
  return `${count} 件${oldest > 0 ? ` 最久 ${humanDuration(oldest)}` : ''}`.slice(0, 40)
}

/**
 * 中继地址只留 `host:port`：弹窗宽 240px，那条 URL 带着 scheme 和 path 会挤掉别的行，
 * 而用户排错要认的就是"连的哪一台"。这里**不用 `new URL`**——这段 DOM 也跑在单测那个 vm 里，
 * 少一个全局依赖就少一类"在 vm 里退化成整条字符串"的假象。
 */
export function relayAddress(url: unknown): string {
  if (typeof url !== 'string' || url.trim() === '') return ''
  const withoutScheme = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  // authority 就是 scheme 之后、第一个 `/` 或 `?` 之前那一段。
  const authority = /^[^/?]*/.exec(withoutScheme)?.[0] ?? ''
  return authority.slice(0, 40)
}

/**
 * 面板正文那三行（中继 / 状态 / 版本）。每条都**拿不到就返回空串**，调用方据此不占那一行——
 * 第一次轮询还没回来时面板不该出现三个空壳。
 *
 * 2026-10-03 的历史：重设计前这里是四行（本机 / 中继 / 状态 / 已配对），随后收成"只剩中继"、
 * 用户又说太单薄、补回两条凑三行。留下的这三条各有理由，且**都不与抬头那句重复**：
 * 中继＝连的哪一台（排错第一眼）、状态＝中继这条链的细态（抬头在线时只说配没配上）、
 * 版本＝跑的是哪一版（profile 里可能就是没发布的字节）。本机名与台数仍不上屏。
 */
export function relayRow(status: StatusAnswer | undefined): string {
  return relayAddress(status?.serverUrl)
}

/** 中继那条链的细态：抬头在线时只讲"配没配上"，这条才讲"连没连上"。 */
export function relayStateRow(status: StatusAnswer | undefined): string {
  const relay = status?.relay
  // 2026-10-05 用户定的口径：弹窗这一行说"已就绪"不说"已连接"——"已连接"
  // 留给抬头那句结论（配没配上），这里讲的是中继这条链本身通了，两句话不打架。
  if (relay === 'online') return '已就绪'
  if (relay === 'connecting') return '连接中'
  if (relay === 'offline') return '已断开'
  if (relay === 'idle') return '未启动'
  return ''
}

/** 本机装的这一版号；宿主没给（老版路由）时这一行不占地方。 */
export function versionRow(status: StatusAnswer | undefined): string {
  const version = status?.version
  return typeof version === 'string' && version.trim() !== '' ? version.trim().slice(0, 24) : ''
}

/** 秒数说成人话：62 秒说"1 分 2 秒"——用户扫一张码不该数秒。 */
export function secondsText(ms: number): string {
  const whole = Math.max(0, Math.round(ms / 1000))
  if (whole < 60) return `${whole} 秒`
  return `${Math.floor(whole / 60)} 分 ${whole % 60} 秒`
}

const CSS = `
.drc-pill { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 2px 8px;
  border: 0; border-radius: 999px; background: transparent; color: inherit; font: inherit;
  font-size: 12px; line-height: 18px; cursor: pointer;
  /* 宿主那一排挤不下时会自己截断（「6 轮 …」那种），我们也跟这个形状走：
     一行写完，写不下就省略号。**没有这两条**的话，flex 项会被压到「中文最小内容宽度
     = 一个字」，于是「已连 1 台」竖着排成四行（2026-10-03 真屏幕截图）。 */
  flex: 0 1 auto; white-space: nowrap; }
.drc-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.drc-pill:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04)); }
.drc-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--dsw-alias-label-dimmed, #9aa0a6); }
.drc-dot[data-tone="wait"] { background: var(--dsw-alias-state-warn-primary, #faad14); }
.drc-dot[data-tone="on"] { background: var(--dsw-alias-state-success-primary, #52c41a); }
.drc-dot[data-tone="error"] { background: var(--dsw-alias-state-error-primary, #ff4d4f); }
.drc-panel { position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 30; width: 240px;
  padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1)); border-radius: 12px;
  background: var(--dsw-specific-tip, var(--dsw-alias-bg-layer-1, #ffffff));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06);
  color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; }
/* 抬头一行：左侧状态，右侧动作。两颗按钮都收在这个右上角（2026-10-03 重设计的要求）。 */
.drc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.drc-head-label { font-weight: 600; }
.drc-head-label[data-tone="off"] { color: var(--dsw-alias-label-secondary, #6b7280); }
.drc-head-label[data-tone="wait"] { color: var(--dsw-alias-state-warn-primary, #faad14); }
.drc-head-label[data-tone="on"] { color: var(--dsw-alias-state-success-primary, #52c41a); }
.drc-head-label[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #ff4d4f); }
.drc-actions { display: flex; gap: 6px; flex: 0 0 auto; }
.drc-btn { padding: 2px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer;
  white-space: nowrap; }
.drc-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04)); }
/* 正文那三行（中继 / 状态 / 版本）：键左值右（space-between），值被截断时省略号——
   和那颗 pill 同一套"挤不下就截文字不撑容器"。第一行带那条分隔线，后两行只留行距。 */
.drc-info { display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  white-space: nowrap; margin-top: 8px; padding-top: 6px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08)); }
.drc-info + .drc-info { margin-top: 2px; padding-top: 0; border-top: 0; }
.drc-key { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); }
.drc-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.drc-qr { display: block; width: 200px; height: 200px; margin: 8px auto 0; image-rendering: pixelated; }
.drc-code { margin: 8px 0 0; text-align: center; font-weight: 600; font-size: 14px; letter-spacing: 2px; }
  /* 引导行：比 note 重一档（第一次用的人要看清），但不加图标不加底色——
     这一屏的主角是二维码，多一个色块就成了推销而不是引导。 */
  .drc-guide { margin: 8px 0 0; text-align: center; color: var(--dsw-alias-label-secondary, #5f6368); font-size: 12px; }
  .drc-note { margin: 4px 0 0; text-align: center; color: var(--dsw-alias-label-tertiary); }
.drc-note[data-kind="failed"] { color: var(--dsw-alias-state-error-primary, #ff4d4f); }
`

/** 认得出 slots 服务吗：`inject`（认领槽位）与 `register`（往里放组件）两个函数都得在。 */
function isSlots(value: unknown): value is SlotRegistry {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.inject === 'function' && typeof record.register === 'function'
}

/**
 * 从一个候选里认出 slots：候选本身就是服务，或者它是个能 `get('slots')` 的上下文。
 * 真 cordis 两种都会出现——`ctx.get` 给的是服务本身，而 `ctx.inject` 的回调参数是
 * **作用域化上下文**，要在它上面再 get 一次。读没声明的属性是**抛错**而不是返回
 * undefined，所以这里整段包 try（调用方还要为"抛了"留一条 warn）。
 */
function pickSlots(source: unknown): SlotRegistry | undefined {
  if (isSlots(source)) return source
  const asGettable = source as Gettable | null | undefined
  if (asGettable && typeof asGettable.get === 'function') {
    try {
      const got = asGettable.get('slots', true)
      if (isSlots(got)) return got
    } catch {
      /* 这个候选没有该服务 */
    }
  }
  return undefined
}

/**
 * 装载这份 bundle 的 `__ModuleLoader__` 传进 factory 的那个 require（见
 * `scripts/bundle-plugin.mjs` 的外壳）。这里**不用 `import`**，理由写在下面。
 */
declare const require: ((id: string) => unknown) | undefined

/**
 * 向装载器要 react 的 `createElement`；拿不到就是没有 pill，而不是整页起不来。
 *
 * 模块名走**变量**而不是字面量，这条不是风格问题：字面量 `require('react')` 会被打包器在
 * 构建期解析成 factory 顶层那一句，一旦宿主给不出这个模块，抛出发生在 factory 第一行——
 * 那是"web boot: N entry/entries did not activate"，整页都起不来。
 * 走变量则留在运行期，被这里的 try 接住。（`scripts/bundle-plugin.mjs` 里有一条断言
 * 盯着产物中不得出现 `require("react")` 那种静态形式。）
 */
export function findCreateElement(): CreateElement | undefined {
  try {
    if (typeof require !== 'function') return undefined
    const moduleId = 'react'
    const react = require(moduleId) as
      { createElement?: CreateElement; default?: { createElement?: CreateElement } } | undefined
    const create = react?.createElement ?? react?.default?.createElement
    return typeof create === 'function' ? create : undefined
  } catch {
    return undefined
  }
}

function warn(message: string, error?: unknown): void {
  try {
    const detail = error instanceof Error ? error.message : error === undefined ? '' : String(error)
    console.warn(`[dsh-remote-control pill] ${message} ${detail}`)
  } catch {
    /* 控制台也可能不可用 */
  }
}

function ensureStyle(doc: Document): void {
  try {
    const existing = doc.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
    if (existing) {
      /**
       * 已经插过就**按内容对齐**，不能只看"有没有插过"就返回。
       *
       * 宿主换新版这一半时文档未必重载（HMR 只替换模块、`<head>` 里的 `<style>` 原样留着），
       * 于是新代码按新结构建 DOM、旧样式却还在生效——真屏幕上表现为整块面板错位
       * （2026-10-03 用户截图：抬头那颗按钮掉到第二行居中，那是上一版 `.drc-actions` 的
       * `justify-content: center` 在管事）。这一条就是那次事故的修法。
       */
      if (existing.textContent !== CSS) existing.textContent = CSS
      return
    }
    const element = doc.createElement('style')
    element.setAttribute('data-plugin-css', STYLE_ID)
    element.textContent = CSS
    doc.head.appendChild(element)
  } catch (error) {
    warn('样式注入失败（pill 仍可用，只是没配色）', error)
  }
}

export interface PillDeps {
  fetchImpl(input: string, init?: Record<string, unknown>): Promise<unknown>
  /** 降级留痕的出口；单测用它钉住"这条路坏了但页面还能用"。 */
  warn?(message: string): void
}

/**
 * 在 `root` 里建出那颗 pill，返回卸载函数。
 *
 * DOM 是命令式的（React 只负责给个挂载点），所以这里能把"面板开着时倒计时走完要自动换码"
 * 这种时序写成可测的分支。`fetchImpl` 是注入口：真实故障形状（200+unavailable 当成功、
 * 过期后不再重试）只有喂假回答才复现得出来。
 */
export function buildPill(root: Element, deps: PillDeps): () => void {
  const doc = root.ownerDocument
  ensureStyle(doc)

  const button = doc.createElement('button')
  button.type = 'button'
  button.className = 'drc-pill'
  button.setAttribute('aria-haspopup', 'dialog')
  button.setAttribute('aria-expanded', 'false')
  const dot = doc.createElement('span')
  dot.className = 'drc-dot'
  dot.setAttribute('aria-hidden', 'true')
  const label = doc.createElement('span')
  label.className = 'drc-label'
  button.appendChild(dot)
  button.appendChild(label)
  root.appendChild(button)

  let panel: HTMLElement | undefined
  let statusTimer: ReturnType<typeof setInterval> | undefined
  let countTimer: ReturnType<typeof setInterval> | undefined
  let view: PanelView = { kind: 'info' }
  let expiresInMs = 0
  let lastStatus: StatusAnswer | undefined
  let disposed = false

  /** 面板上那颗按钮的文案要跟着抬头那句走，所以这里读的是同一份轮询结果。 */
  /**
   * 「配没配上」读的是**密钥簿**（pairings），不是此刻有几台手机连着（paired）。
   * 2026-10-04 改的：pair-store 之后配对按 D3 长存，手机退后台只是 socket 断——
   * 用 paired 判断「配没配上」，用户把小程序放进后台的每一分钟，这四处
   * （抬头、按钮身份、点开发不发码、配好后翻不翻面）全都会说「未配对」。
   */
  const pairingNow = (): number => pairingCount(lastStatus)

  const write = (): void => {
    const next = pillLabel(lastStatus)
    label.textContent = next.text
    dot.setAttribute('data-tone', next.tone)
    button.setAttribute('title', `dsh-remote-control：${next.text}`)
    button.setAttribute('aria-label', next.text)
  }

  const text = (tag: string, className: string, content: string): HTMLElement => {
    const node = doc.createElement(tag)
    node.className = className
    node.textContent = content
    return node
  }

  const buttonOf = (content: string, onClick: () => void): HTMLElement => {
    const node = doc.createElement('button')
    node.type = 'button'
    node.className = 'drc-btn'
    node.textContent = content
    node.addEventListener('click', onClick)
    return node
  }

  /** 二维码那一行的说明：没过期报剩余时间，过期了就明说要自己再按一次（不再自动补一张）。 */
  // 2026-10-05 用户定的口径：不加间隔号、不用书名号——扫一眼的行，一个多余符号
  // 就多一分"像系统消息不像人话"的感觉。"微信扫码配对"直接点名用哪个 App 扫。
  const qrNote = (): string =>
    expiresInMs > 0 ? `微信扫码配对 ${secondsText(expiresInMs)}后过期` : '配对码已过期 点右上角刷新重新生成'

  /**
   * 抬头一行：左边状态、右边动作。**面板唯一那颗动作按钮就收在这里**（面板的右上角）。
   *
   * 2026-10-04 这一轮把"未配对 → 先生成配对码"那一屏删掉了：**未配对时点开就是二维码页**，
   * 所以那颗按钮只剩两种身份——配上了是 `退出配对`，没配上是 `刷新`（重要一张码，
   * 走同一条幂等发码路由：码还在就还是它、过期了才换新的）。原来"生成配对码 / 刷新"
   * 是同一件事的两个说法，而删掉那一屏之后连这个歧义都不存在了。
   *
   * 状态那句话跟那颗 pill 读同一份 `pillLabel(lastStatus)`，所以面板开着时轮询一回来
   * （比如手机上刚扫完码）这句话就跟着变。
   */
  const header = (): HTMLElement => {
    const head = doc.createElement('div')
    head.className = 'drc-head'
    const state = pillLabel(lastStatus)
    const stateText = text('span', 'drc-head-label', state.text)
    stateText.setAttribute('data-tone', state.tone)
    head.appendChild(stateText)
    const actions = doc.createElement('div')
    actions.className = 'drc-actions'
    const action = pairingNow() > 0 ? { label: '退出配对', run: requestUnpair } : { label: '刷新', run: requestPairing }
    actions.appendChild(buttonOf(action.label, () => void action.run()))
    head.appendChild(actions)
    return head
  }

  /** 「手机离线」那一屏的解释行；不是那个状态时返回 null（不占地方）。 */
  const offlineNote = (): HTMLElement | null => {
    if (!lastStatus) return null
    if (pillLabel(lastStatus).text !== '手机离线') return null
    return text('p', 'drc-note', '配对还在 小程序回前台会自动重连 不用重新扫码')
  }

  /** 正文那几行（待处理 / 中继 / 状态 / 版本）；某一行拿不到值时它自己不占地方。 */
  const infoRows = (): HTMLElement[] => {
    if (!lastStatus) return []
    const rows: Array<[string, string]> = [
      // 排第一：它是唯一一条"看完要做点什么"的，其余三条都是"知道就行"。
      ['待处理', waitingRow(lastStatus)],
      ['中继', relayRow(lastStatus)],
      ['状态', relayStateRow(lastStatus)],
      ['版本', versionRow(lastStatus)],
    ]
    return rows
      .filter(([, value]) => value !== '')
      .map(([key, value]) => {
        const row = doc.createElement('div')
        row.className = 'drc-info'
        row.appendChild(text('span', 'drc-key', key))
        row.appendChild(text('span', 'drc-value', value))
        return row
      })
  }

  /**
   * 画当前这一屏：**抬头 + 视图主体 + 那几行正文**，三种视图都带正文那几行。
   *
   * 原来二维码那一屏是 `return` 掉的（正文只在状态屏出现），但"未配对点开就是二维码页"之后
   * 那一屏成了未配对时唯一的一屏——把正文藏起来就等于把"连的哪一台 / 连没连上 / 跑的是哪一版"
   * 和"这台机器上有没有回合被卡住"四条事实一起删了（伞仓 docs/PRODUCT.md §3 第 2 条要它们在场）。
   * `loading` 也照带：它只有几百毫秒，不带会让面板先窄后宽地跳一次。
   */
  const paint = (): void => {
    if (!panel) return
    panel.replaceChildren()
    panel.appendChild(header())
    if (view.kind === 'loading') {
      panel.appendChild(text('p', 'drc-note', '正在生成配对码'))
    } else if (view.kind === 'qr') {
      const image = doc.createElement('img')
      image.className = 'drc-qr'
      image.setAttribute('alt', '配对二维码')
      image.src = view.imageSrc
      panel.appendChild(image)
      // 第一次用的人唯一需要的那句话：这码是给谁扫的、扫完得到什么。
      // 一条、短、不带符号——侵入性比弹一次模态框小，但同样把人领进门
      // （2026-10-05 用户定的口径：引导但不侵入，文案要短）。
      panel.appendChild(text('p', 'drc-guide', GUIDE_LINE))
      // 6 位码仍然单独印一行（QR 扫不出来时那是唯一退路）。
      panel.appendChild(text('p', 'drc-code', view.token))
      panel.appendChild(text('p', 'drc-note', qrNote()))
    } else if (view.kind === 'unavailable' || view.kind === 'failed') {
      const note =
        view.kind === 'unavailable'
          ? text('p', 'drc-note', view.reason)
          : (() => {
              const node = text('p', 'drc-note', `配对请求没成功：${view.detail}`)
              node.setAttribute('data-kind', 'failed')
              return node
            })()
      panel.appendChild(note)
    }
    for (const row of infoRows()) panel.appendChild(row)
    // 手机离线那一屏要说清「不用重新扫码」：配对簿还在，小程序回前台自动重连。
    // 不说这句，用户看到「手机离线」会去扫一个不需要扫的码（2026-10-04 用户提的误解）。
    const note = offlineNote()
    if (note) panel.appendChild(note)
  }

  const closePanel = (): void => {
    if (countTimer !== undefined) {
      clearInterval(countTimer)
      countTimer = undefined
    }
    if (panel) {
      panel.remove()
      panel = undefined
    }
    button.setAttribute('aria-expanded', 'false')
  }

  async function requestPairing(): Promise<void> {
    if (disposed || !panel) return
    view = { kind: 'loading' }
    paint()
    let answer: NewAnswer | undefined
    let httpStatus = 0
    try {
      // 那个 `x-drc-pair` 头是**这条请求的 CSRF 判据**，不是装饰：桌面宿主会删掉转发请求的
      // `origin`，所以"Origin 必须存在"在真机上永远不成立（2026-10-03 那颗 pill 就是这么撞 403 的）。
      // 自定义头则只有同源脚本发得出——跨站要带它必然触发 CORS 预检，而这条服务不答应预检。
      const response = (await deps.fetchImpl(NEW_ROUTE, {
        method: 'POST',
        headers: { 'x-drc-pair': '1' },
        credentials: 'same-origin',
      })) as { status?: number; json?(): Promise<unknown> } | undefined
      httpStatus = typeof response?.status === 'number' ? response.status : 0
      answer = (await response?.json?.()) as NewAnswer | undefined
    } catch (error) {
      view = { kind: 'failed', detail: error instanceof Error ? error.message : String(error) }
      paint()
      return
    }
    if (disposed || !panel) return
    view = panelViewFor(answer, httpStatus)
    if (view.kind === 'qr') {
      expiresInMs = view.expiresInMs
      if (countTimer === undefined) {
        countTimer = setInterval(() => {
          expiresInMs -= 1000
          // 到点**换一张的能力没有了**（2026-10-03 拍板）：不自动补、也没有「换一张」按钮。
          // 停表并就地把它说成"已过期"，重发与否由人再按一次那颗按钮决定。
          if (expiresInMs <= 0) {
            clearInterval(countTimer)
            countTimer = undefined
          }
          paint()
        }, 1000)
      }
    }
    paint()
  }

  /**
   * 退出配对：面板右上角那颗按钮（只在已配对时出现）。
   *
   * 乐观地把 `paired` 清零再重画，这样那句话与那颗按钮**当场**就翻过去，不用等下一次轮询
   * （轮询是 2 秒节拍，等它会让"按下没反应"成为错觉）。随后立刻补一次真轮询对账，
   * 万一宿主那边没作废掉（比如守卫拒了），下一次轮询会把真相带回来。
   */
  async function requestUnpair(): Promise<void> {
    if (disposed || !panel) return
    try {
      // 与发码同一条守卫：这是写路由，桌面宿主会删 `origin`，所以判据是那个自定义头。
      await deps.fetchImpl(UNPAIR_ROUTE, {
        method: 'POST',
        headers: { 'x-drc-pair': '1' },
        credentials: 'same-origin',
      })
    } catch (error) {
      warn('退出配对请求失败（面板会靠下一次轮询对账）', error)
    }
    if (disposed || !panel) return
    // 配对簿同时清零：`POST /unpair` 作废的就是全部通道（会话簿里一条不剩），
    // 只把 paired 归零会让抬头掉进"手机离线"——那是 2026-10-04 新加的第三态，
    // 此刻真正的事实是"没配上了"。
    if (lastStatus) lastStatus = { ...lastStatus, paired: 0, pairings: 0 }
    // 退完配对这一刻就"没配上"了，而没配上时这一屏唯一的内容就是下一张码（见 `openPanel` 那条分支）：
    // 直接进二维码页，不让用户退完之后再去别处找发码的入口——那个入口已经删掉了。
    //
    // 这里**故意不立刻补一次 `/status` 轮询**：乐观翻面与"对账"撞在同一个 tick 里，
    // 翻面就等于没翻（宿主那条路由是异步作废的，秒回的多半还是 `paired:1`）。
    // 对账交给下一次 2 秒节拍——那才是这句注释原来说的"真相会带回来"。
    write()
    view = { kind: 'loading' }
    paint()
    void requestPairing()
  }

  const openPanel = (): void => {
    if (panel || disposed) return
    panel = doc.createElement('div')
    panel.className = 'drc-panel'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'dsh-remote-control 配对')
    panel.tabIndex = -1
    root.appendChild(panel)
    button.setAttribute('aria-expanded', 'true')
    /**
     * **未配对 → 点开就是二维码页；已配对 → 点开只给状态**（发码这一步在 2026-10-04 删掉了：
     * 没配上的时候那颗按钮存在的唯一意义就是把人往二维码页推一步，而"未配对还点开看别的"
     * 不存在——面板上没有任何别的东西可看）。
     *
     * 这一条把 2026-10-03 那次"点开不发码"的取舍**反转了一半**：当时守的是
     * "看一眼不该消耗一张有寿命的 pending 码"，现在守的是同一件事，但只守**配上了**的那一侧——
     * 已配对时点开仍然一次码都不发（`pairingNow() > 0` 那条分支：读的是密钥簿，
     * 手机退后台离线时也算「配上了」——不放码，那一屏只有正文）。没配上时那张码就是这一屏
     * 唯一的内容，发它不算消耗，不发才是让人多点一次那颗注定要点一次的按钮。
     *
     * `POST /pairing/new` 是幂等的：码还活着就还是那一张，所以下面这句在"重复点开"时
     * 不会把 pending 表堆成一串码。
     */
    if (pairingNow() > 0) {
      view = { kind: 'info' }
      paint()
    } else {
      void requestPairing()
    }
    try {
      panel.focus()
    } catch {
      /* 焦点进不去不是故障 */
    }
  }

  /**
   * 命中判定用鸭子类型而不是 `instanceof Node`：真浏览器里两者等价，但 vm 里没有 `Node`
   * 这个全局，`instanceof` 会抛 ReferenceError——那会被吞掉并误判成"没命中"，
   * 于是"点外面才关"变成"点哪里都关"。这条坑踩过就不留第二次。
   */
  const inside = (candidate: unknown): boolean => {
    if (!candidate || typeof candidate !== 'object') return false
    try {
      return root.contains(candidate as Node) || (panel?.contains(candidate as Node) ?? false)
    } catch {
      return false
    }
  }

  const onPointerDown = (event: Event): void => {
    if (!panel) return
    if (inside(event?.target)) return
    closePanel()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closePanel()
  }

  async function pollStatus(): Promise<void> {
    if (disposed) return
    try {
      if (doc.visibilityState === 'hidden') return
    } catch {
      /* 拿不到可见性就照常轮询 */
    }
    try {
      const response = (await deps.fetchImpl(`${STATUS_ROUTE}?t=${Date.now()}`, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })) as { status?: number; json?(): Promise<unknown> } | undefined
      if (!response || response.status !== 200) return
      const body = (await response.json?.()) as StatusAnswer | undefined
      if (!body || typeof body !== 'object') return
      lastStatus = body
      /**
       * 手机上刚扫完码：面板若还停在二维码上，当场翻回状态视图。
       *
       * 那一张码配上之后就没用了，继续占着面板会让人以为"还没成功、再扫一次"，而且抬头那句
       * 已经翻成 `已配对`、右上角那颗也该换成 `退出配对` 了（2026-10-03 用户按真屏幕要的）。
       */
      if (view.kind === 'qr' && pairingNow() > 0) {
        view = { kind: 'info' }
        if (countTimer !== undefined) {
          clearInterval(countTimer)
          countTimer = undefined
        }
        if (panel) paint()
      }
      write()
    } catch (error) {
      // 路由没挂上时是持续的 404/失败：这是一条降级说明，不是故障。
      deps.warn?.('status poll failed')
      warn('status poll failed（pill 会停在默认文案上）', error)
    }
  }

  button.addEventListener('click', () => {
    if (panel) closePanel()
    else openPanel()
  })
  doc.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('keydown', onKeyDown)
  write()
  void pollStatus()
  statusTimer = setInterval(() => void pollStatus(), POLL_MS)

  return () => {
    if (disposed) return
    disposed = true
    if (statusTimer !== undefined) clearInterval(statusTimer)
    closePanel()
    doc.removeEventListener('pointerdown', onPointerDown, true)
    doc.removeEventListener('keydown', onKeyDown)
    button.remove()
  }
}

/**
 * 注册进宿主的槽位。返回 false 表示"**到这一刻**这颗 pill 还没挂上"（没 react / 没 slots /
 * 槽位 API 不对），调用方只关心它不外抛。
 *
 * **`slots` 什么时候到位，决定这颗 pill 存不存在**。模块的 `inject` 声明是空的时，
 * `apply()` 跑在 `slots` 服务之前，只软探一次就返回的表现是"屏幕上永远没有这颗按钮"——
 * 2026-10-03 删掉右栏那半之后在真机上就是这么打的（当时 262 项单测全绿，屏幕是空的；
 * 旧的 `inject: ['sidebarRight']` 无意中把激活时机推到了服务齐之后）。
 * 现在按宿主自带模板（`templates/decoration/client.js`：`inject: ['slots']` +
 * `ctx.slots.inject(...)`）把 `slots` 声明进闸门，同时保留两条退路：软探测，以及
 * `ctx.inject(['slots'], …)` 的晚到回调（回调里只 mount 一次）。
 */
export function mountPill(ctx: PillHost, createElement: CreateElement | undefined): boolean {
  if (!createElement) {
    warn('装载器给不出 react：配对那颗 pill 不会出现')
    return false
  }
  let mounted = false
  const mount = (slots: SlotRegistry): void => {
    if (mounted) return
    /**
     * `ref` 回调必须是**稳定身份**（模块里这一份闭包，每次渲染都同一个函数），
     * 否则 React 每次重渲染都会先 `ref(null)` 再 `ref(node)`——那颗 pill 会一闪一闪地重建。
     */
    let cleanup: (() => void) | undefined
    const attach = (node: unknown): void => {
      const element = node as Element | null
      if (element && typeof element.appendChild === 'function' && element.ownerDocument) {
        if (cleanup) return
        ;(element as HTMLElement).style.position = 'relative'
        cleanup = buildPill(element, {
          fetchImpl: (input, init) => globalThis.fetch(input, init as RequestInit | undefined),
        })
      } else if (cleanup) {
        cleanup()
        cleanup = undefined
      }
    }
    const component = (): unknown => createElement('span', { ref: attach })
    mounted = true
    try {
      slots.inject(SLOT_NAME, () => {
        try {
          slots.register({ name: SLOT_NAME, id: PILL_ID, order: PILL_ORDER, inject: () => ({}) }, component)
        } catch (error) {
          warn('槽位注册失败（那颗 pill 不出现）', error)
        }
      })
    } catch (error) {
      mounted = false
      warn('槽位注入失败（那颗 pill 不出现）', error)
      return
    }
    try {
      ctx.effect?.(() => () => {
        if (cleanup) {
          cleanup()
          cleanup = undefined
        }
      })
    } catch {
      /* 没有 effect 口就不登记卸载：宿主整页卸载会带走这颗 pill */
    }
  }

  let early: SlotRegistry | undefined
  try {
    // 模块 `inject: ['slots']` 声明之后，`ctx.slots` 直接可读——宿主自带的
    // `templates/decoration/client.js` 就是这个写法。后面两条是给"这一代宿主没把它
    // 当服务给"留的退路。
    early = pickSlots(ctx.slots) ?? pickSlots(ctx.get?.('slots', true))
  } catch {
    /* 这一代宿主没这个服务名，或读它就是抛 */
  }
  if (early) mount(early)

  try {
    ctx.inject?.(['slots'], ((...args: unknown[]) => {
      for (const candidate of [...args, ctx]) {
        const found = pickSlots(candidate)
        if (found) {
          mount(found)
          return
        }
      }
    }) as never)
  } catch (error) {
    warn('ctx.inject 口不可用：slots 再晚到也没人补挂', error)
  }
  if (!mounted) {
    warn('apply 时没探到 slots（已挂注入回调等它晚到）；pill 一直不出现就是这代宿主没这个服务')
  }
  return mounted
}
