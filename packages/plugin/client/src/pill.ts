/**
 * pill — 状态栏那颗写"未配对 / 已配对"的 pill（浏览器那一半）。
 *
 * 它做三件事：往宿主的 `conversation.composer.dock` 槽位注册一颗 pill，按节拍问
 * `GET /plugins/dsh-remote-control/status` 把连接状态写在上面，点击时弹面板。
 *
 * **面板的形状**（2026-10-03 重设计，以"精炼"为准）：抬头一行是状态 + 右上角那**一颗**动作按钮，
 * 下面只在拿得到时补一行中继地址。那颗按钮跟着当前视图走：出图时是 `刷新`
 * （同一条幂等发码路由 `POST /pairing/new`，`GET /pairing.png` 画进面板），其余情形
 * **未配对**时是 `生成配对码`、**已配对**时是 `退出配对`（`POST /unpair`）。原来那三行
 * "本机 / 状态 / 已配对"、`再配一台`、`换一张` 与"倒计时走完自动补一张"都在这一轮删掉了：
 * 抬头那句已经是状态，台数只可能是 0 或 1，而一张码过期后该重发还是让用户自己按。
 *
 * 颜色就是状态：灰（未启动 / 未配对）、黄（连接中）、绿（已配对）、**红（已断开连接）**。
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
  serverUrl?: unknown
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
 * 点进去的弹窗里都有（面板抬头读的就是这一句，同一份来源）。所以未配上的两种情形
 * （没有效码 / 有码还没人扫）合成一句 `未配对`，灯跟着走灰色：灰色才是"还没配上"的颜色。
 *
 * 四种 tone 就是四种颜色：`off` 灰（未启动 / 未配对）、`wait` 黄（连接中）、`on` 绿（已配对）、
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
  return paired > 0 ? { text: '已配对', tone: 'on' } : { text: '未配对', tone: 'off' }
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
 * 面板正文那一行：只剩中继地址——排错时唯一要认的就是"连的哪一台"。
 *
 * 2026-10-03 重设计前这里是四行（本机 / 中继 / 状态 / 已配对）。那三行删掉的理由各自成立：
 * 本机名配对时手机上已经看到、台数只可能是 0 或 1、而"连没连上"抬头那句已经说了。
 * 地址拿不到（第一次轮询还没回来）时返回空串，调用方据此不占那一行。
 */
export function relayRow(status: StatusAnswer | undefined): string {
  return relayAddress(status?.serverUrl)
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
/* 正文那一行中继地址：键左值右（space-between），值被截断时省略号——和那颗 pill 同一套
   "挤不下就截文字不撑容器"。 */
.drc-info { display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  white-space: nowrap; margin-top: 8px; padding-top: 6px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08)); }
.drc-key { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); }
.drc-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.drc-qr { display: block; width: 200px; height: 200px; margin: 8px auto 0; image-rendering: pixelated; }
.drc-code { margin: 8px 0 0; text-align: center; font-weight: 600; font-size: 14px; letter-spacing: 2px; }
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
  const pairedNow = (): number => (typeof lastStatus?.paired === 'number' ? lastStatus.paired : 0)

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
  const qrNote = (): string =>
    expiresInMs > 0 ? `扫码配对 · ${secondsText(expiresInMs)}后过期` : '配对码已过期，点右上角「刷新」重新生成'

  /**
   * 抬头一行：左边状态、右边动作。**面板唯一那颗动作按钮就收在这里**（面板的右上角）。
   *
   * 它跟着当前视图走：正在出图时是 `刷新`（同一条幂等发码路由，码还在就还是它、过期了才换新的），
   * 其余情形按配没配上给 `生成配对码` / `退出配对`。原来二维码那一版仍印着 `生成配对码`，
   * 同一件事两个说法，2026-10-03 用户按真屏幕改掉了。
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
    const action =
      view.kind === 'qr' || view.kind === 'loading'
        ? { label: '刷新', run: requestPairing }
        : pairedNow() > 0
          ? { label: '退出配对', run: requestUnpair }
          : { label: '生成配对码', run: requestPairing }
    actions.appendChild(buttonOf(action.label, () => void action.run()))
    head.appendChild(actions)
    return head
  }

  /** 正文那一行中继地址；没探到状态（第一次轮询还没回来）或地址为空时不占地方。 */
  const relayBlock = (): HTMLElement | undefined => {
    if (!lastStatus) return undefined
    const address = relayRow(lastStatus)
    if (address === '') return undefined
    const row = doc.createElement('div')
    row.className = 'drc-info'
    row.appendChild(text('span', 'drc-key', '中继'))
    row.appendChild(text('span', 'drc-value', address))
    return row
  }

  const paint = (): void => {
    if (!panel) return
    panel.replaceChildren()
    panel.appendChild(header())
    if (view.kind === 'loading') {
      panel.appendChild(text('p', 'drc-note', '正在生成配对码…'))
      return
    }
    if (view.kind === 'qr') {
      const image = doc.createElement('img')
      image.className = 'drc-qr'
      image.setAttribute('alt', '配对二维码')
      image.src = view.imageSrc
      panel.appendChild(image)
      // 6 位码仍然单独印一行（QR 扫不出来时那是唯一退路）。
      panel.appendChild(text('p', 'drc-code', view.token))
      panel.appendChild(text('p', 'drc-note', qrNote()))
      return
    }
    if (view.kind === 'unavailable' || view.kind === 'failed') {
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
    const relay = relayBlock()
    if (relay) panel.appendChild(relay)
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
    if (lastStatus) lastStatus = { ...lastStatus, paired: 0 }
    view = { kind: 'info' }
    write()
    paint()
    void pollStatus()
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
     * 点开**只给状态与那颗按钮**，发码要人再按一下右上角那颗。
     *
     * 原来这里是"点 pill = 发码"，因为那颗 pill 唯一的用途就是配对。现在抬头那句已经是
     * 状态（`未配对` / `已配对`），点它的第一预期变成"看一眼连得怎么样"，于是发码不再是
     * 点开的副产品：一张码是有寿命的资源，`ensureFresh` 虽然幂等，把"看一眼"接到它上面
     * 就等于每次点开都可能向中继申请一张新的挂在 pending 表里。
     */
    view = { kind: 'info' }
    paint()
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
      if (view.kind === 'qr' && pairedNow() > 0) {
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
