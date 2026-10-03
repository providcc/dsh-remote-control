/**
 * pair-actions — 状态栏那颗 pill 用到的三条路由：
 *
 *   `POST /plugins/dsh-remote-control/pairing/new`  点一下要一张能用的码（幂等）
 *   `GET  /plugins/dsh-remote-control/pairing.png`  弹窗里那张二维码图
 *   `GET  /plugins/dsh-remote-control/status`       pill 上那句"连接状态"
 *
 * 为什么单独一个文件、不并进 `route.ts`：**两条路的安全姿态不一样**。
 * `route.ts` 是只读的，Origin 缺席可以放过（同源 GET 常常不带它，而读一张马上过期的码
 * 本身不构成权限）；这里这条**会改状态**，所以额外要求一个只有同源脚本发得出的自定义头。
 * 两种判据写在同一个文件里，迟早有人"顺手复用"成较松的那一个——分文件 + 各自一份断言就是防这个。
 *
 * ⚠️ 那条"额外要求"**不能写成"Origin 必须存在"**：2026-10-03 在真宿主上点那颗 pill 直接 403，
 * 弹窗里印的就是 `origin-missing`——桌面宿主转发 web 请求时会在更外层把 `origin` 头删掉
 * （只读那条能活，正是因为它的判据允许缺席）。所以这里的主判据换成 `x-drc-pair` 那个头：
 * 跨站页面要带自定义头必然先过 CORS 预检，而这条服务既不响应 OPTIONS 也不发 `Access-Control-*`，
 * 浏览器会拦下；HTML 表单更没有设头的口子。Origin 存在时仍要判（环回 http(s) 或宿主自己的
 * 自定义 scheme），但它缺席不再是拒的理由。
 *
 * 为什么状态也要一条路由：pill 要在**没点开**的时候就说清"中继在不在"，而浏览器拿不到
 * `status.json`（那是宿主磁盘上的文件）。这里只出三个非凭据字段，`status.json` 里那些
 * 带身份/带凭据形状的东西一个字都不出去。
 *
 * 为什么弹窗的图要我们自己出（而不是复用右栏那套 `dsh-resource://file/...`）：
 * 右栏能渲染那张图是因为宿主的文档预览页型认领了 `dsh-resource://file/**`；
 * 我们的 pill 是自己 DOM 里的一个 `<img>`，能不能吃 `dsh-resource://` 这个自定义 scheme
 * **没有证据**，而 `<img src="/plugins/…/pairing.png">` 是同域 HTTP，必然可行。
 * 代价是多一条路由，换来的是"弹窗不依赖右栏"——右栏被用户关掉、或那个页型换了，
 * 点一下还是能配对。
 *
 * 幂等是刻意的：`ensureFresh()` 只在"当前没有仍然有效的码"时才向中继申请新的。
 * 连点三下若挂出三张有效码，中继的 pending 表就会同时认三个 PSK，
 * 而屏幕上显示的是哪一张由时序决定——那正是当初"多码事故"的形状。
 *
 * 响应里**绝不含 `psk`，也绝不含完整 `qr` URI**（那两条是配对凭据本身）。
 * 给的是 `token`（6 位码，与卡片上"或手输这 6 位数字"同一条信息，本机页面上本来就印着）
 * 与剩余寿命；图走图片路由，码的 URI 只有渲染成像素之后才离开宿主。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pairingEpoch } from './presenter.js'
import { hostIsLoopback, json, LOOPBACK_HOSTS, type WebServerLike } from './route.js'

export const PAIR_NEW_ROUTE = '/plugins/dsh-remote-control/pairing/new'
export const PAIR_IMAGE_ROUTE = '/plugins/dsh-remote-control/pairing.png'
export const PAIR_STATUS_ROUTE = '/plugins/dsh-remote-control/status'

/** 一版仍然有效的码（`expiresAt` 是毫秒时刻）。 */
export interface LivePairing {
  qr: string
  token: string
  expiresAt: number
}

/** pill 上要显示的那句"连接状态"——三个非凭据字段，别的一律不出。 */
export interface PillStatus {
  /** 与 `status.json` 的 `relay` 同一个取值集合：`idle` 是"runtime 还没起来"，不是"断了"。 */
  relay: 'online' | 'connecting' | 'offline' | 'idle'
  /** 当前配对着的手机数量。 */
  paired: number
  /** 现在有没有一张仍然有效的码（决定 pill 显示"点一下配对"还是"已连接"）。 */
  hasCode: boolean
}

export interface PairActionDeps {
  /**
   * 幂等地保证"有一张能用的码"：已有就直接给现有的，没有才向中继申请。
   * 中继不在线 / runtime 没起来时返回 null（这**不是**错误，是"现在发不出码"）。
   */
  ensureFresh(): LivePairing | null
  /** 只读地看当前有没有仍然有效的码（图片路由用，绝不顺手发码）。 */
  current(): LivePairing | null
  /** 把码渲染成 PNG 字节。 */
  renderPng(qr: string): Promise<Buffer>
  /** 连接状态（pill 抬头那句）。 */
  status(): PillStatus
  log(message: string, fields?: Record<string, string | number | boolean | undefined>): void
}

/**
 * 写路由的 CSRF 判据。**不能靠 Origin 存在**：桌面宿主会在更外层转发并删掉 `origin` 头，
 * 真机 2026-10-03 实测那条点击进来的请求就是 `origin-missing`（403 印在弹窗上看到的）。
 * 所以这道改用**只有同源脚本才发得出的自定义头**当主判据：跨站页面要带它就必然触发 CORS
 * 预检，而这条服务不响应 OPTIONS、也不发 `Access-Control-*`，浏览器会直接拦下；
 * 普通 HTML 表单更是根本没有设头的口子。
 */
export const PAIR_MARKER_HEADER = 'x-drc-pair'
export const PAIR_MARKER_VALUE = '1'

/** Origin 存在时它必须像"这台宿主自己"：环回的 http(s)，或宿主自己注册的自定义 scheme。 */
function originLooksLikeTheHostItself(origin: string): boolean {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      // `dsh-app://app` 这类自定义 scheme 只有宿主自己能产生；`null`（file:// 文档）不算。
      return origin.trim() !== 'null'
    }
    return LOOPBACK_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

/**
 * 这条写路由到底被哪一道拦下的：**必须分开报**，因为桌面宿主会改写转发请求的头，
 * "哪个头没了"在真机上是量出来的而不是猜的（见上面那段）。返回 undefined 表示放行。
 */
export function rejectedBy(request: IncomingMessage): string | undefined {
  if (!hostIsLoopback(request.headers.host)) return 'host-not-loopback'
  if (request.headers[PAIR_MARKER_HEADER] !== PAIR_MARKER_VALUE) return 'pair-marker-missing'
  const origin = request.headers.origin
  if (origin !== undefined && origin.trim() !== '' && !originLooksLikeTheHostItself(origin)) return 'origin-not-trusted'
  return undefined
}

/** `POST /pairing/new`：点一下配对。 */
export function pairNewHandler(deps: PairActionDeps): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (request.method !== 'POST') {
      // 只接受 POST：这条会改状态。GET 走 `route.ts` 那条只读路由，别在这里混用。
      json(response, 405, { error: 'method not allowed' })
      return
    }
    const guard = rejectedBy(request)
    if (guard) {
      // 把**是哪一道**回出去：这条路由在浏览器里点，谁也没法 curl 调试，
      // 而"403 但不知道为什么 403"正是那颗 pill 在生产上最难查的形状。
      // 这里只出守卫名，不出请求内容。
      deps.log('发码请求被守卫拒', { guard })
      json(response, 403, { error: 'request-not-trusted', guard })
      return
    }
    try {
      const pairing = deps.ensureFresh()
      if (!pairing) {
        // 中继没在线就发不出码。回 200 + 一个明确状态，让 pill 能显示"未连接"，
        // 而不是让前端把 5xx 当成插件坏了。
        json(response, 200, { state: 'unavailable', reason: 'relay-offline' })
        return
      }
      deps.log('配对码经状态栏发出', { token: pairing.token })
      json(response, 200, {
        state: 'ready',
        epoch: pairingEpoch(pairing.qr),
        token: pairing.token,
        expiresInMs: Math.max(0, pairing.expiresAt - Date.now()),
      })
    } catch (error) {
      json(response, 500, { error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

/** `GET /pairing.png`：弹窗里那张图，按需现渲染（不依赖磁盘上那份，也不依赖右栏）。 */
export function pairImageHandler(deps: PairActionDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(response, 405, { error: 'method not allowed' })
      return
    }
    // 图片是只读的，守卫跟只读路由同一档（Origin 缺席允许）。
    if (!hostIsLoopback(request.headers.host)) {
      json(response, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      const pairing = deps.current()
      if (!pairing) {
        // 204 而不是 404：路由在、只是现在没有码。pill 据此显示"点一下生成"。
        response.writeHead(204)
        response.end()
        return
      }
      const png = await deps.renderPng(pairing.qr)
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': png.length,
        // 一张码会被就地换掉（半程刷新、被手机用掉），所以绝不许缓存。
        // ETag 给的是这一版的哈希，pill 拿它判断要不要重画，省掉撕票式的刷新。
        'Cache-Control': 'no-store',
        ETag: `"${pairingEpoch(pairing.qr)}"`,
      })
      response.end(request.method === 'HEAD' ? undefined : png)
    } catch (error) {
      json(response, 500, { error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

/** `GET /status`：pill 抬头那句连接状态（只读，守卫与只读路由同一档）。 */
export function pillStatusHandler(deps: PairActionDeps): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(response, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(request.headers.host)) {
      json(response, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      const status = deps.status()
      json(response, 200, {
        relay: status.relay,
        paired: status.paired,
        hasCode: status.hasCode,
      })
    } catch (error) {
      json(response, 500, { error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

/** 挂上这三条路由；返回一个注销函数（与 `registerPairingRoute` 同一套生命周期）。 */
export function registerPairActionRoutes(webServer: WebServerLike, deps: PairActionDeps): () => void {
  const unregisterNew = webServer.register({
    kind: 'exact',
    path: PAIR_NEW_ROUTE,
    handler: pairNewHandler(deps),
  })
  const unregisterImage = webServer.register({
    kind: 'exact',
    path: PAIR_IMAGE_ROUTE,
    handler: pairImageHandler(deps),
  })
  const unregisterStatus = webServer.register({
    kind: 'exact',
    path: PAIR_STATUS_ROUTE,
    handler: pillStatusHandler(deps),
  })
  return () => {
    // 三条都要试着注销：一条抛了也不能把其余的留在宿主上。
    for (const off of [unregisterNew, unregisterImage, unregisterStatus]) {
      try {
        off()
      } catch {
        /* 宿主可能已经先一步拆了 webServer */
      }
    }
  }
}
