/**
 * presentation-isolation.test — 折成一个包之后，"缺 webServer 不许连累配对链路"这条隔离
 * **必须由代码自己提供**（原来是靠"拆成两个 cordis 条目"这个结构提供的）。
 *
 * 判据的形式是**对照**而不是"没报错就行"：同一个假上下文跑两遍 `apply()`，唯一的差别是
 * 有没有 `webServer`，然后要求主链路上每一项可观察状态**逐字段相等**、`/drc` 命令的返回
 * **逐字节相等**。
 *
 * 为什么必须做到这个强度：本插件真实发生过的最坏故障是 fiber 被标 FAILED → 宿主把它那几个
 * `ctx.inject` 子 fiber 一起 dispose → carrier=none、配对链路整条没（取证见 `src/index.ts`
 * apply() 里那条纪律）。"没抛异常"抓不到这种形状，而对照能——`relay`/`carrier`/快照字段
 * 里任何一项被连带都会当场显形。
 *
 * 三种 webServer 形态都要覆盖，它们对应真机上会遇到的样子：
 * ① 没有这个服务（某一代宿主 / headless）；② 有，正常挂上；③ 有但 `register()` 抛错
 * （路由名被别的插件占了）——③ 最阴，因为它是我们这一半失败在宿主的对象上。
 *
 * 中继一律指 `ws://127.0.0.1:1`（必然拒绝），这样"连不上"是确定的而不是竞态；
 * `carrierGraceMs` 压到 50ms，否则载具要等默认 5s 宽限期才决定，测试会变成等时间。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../src/index.js'
import { PAIR_VIA_PILL_TEXT } from '../src/shell/pairing-text.js'
import { PAIR_IMAGE_ROUTE, PAIR_NEW_ROUTE, PAIR_STATUS_ROUTE } from '../src/presentation/pair-actions.js'

/** 一眼假的 token：仓库里不许出现真凭据，这条只验形状（同 status.test.ts）。 */
const FAKE_TOKEN = 'fake-host-token-not-a-real-secret-0123456789abcdef'

/**
 * 那颗 pill 真发出来的请求头（环回 Host + 自定义头）。`origin` 不在这里：桌面宿主转发时
 * 会把它删掉，真机 2026-10-03 量过。
 */
const LOOPBACK_HEADERS = { host: '127.0.0.1:5173', 'x-drc-pair': '1' }

/** 主链路上可比对的稳定字段。`sidebar` 单独断言，`relay`/`probe` 有时序所以另做形状断言。 */
const MAIN_LINK_KEYS = [
  'carrier',
  'conversations',
  'pendingPairs',
  'mockBridgeForced',
  'hostTokenShape',
  'serverUrl',
  'hostLabel',
  'unarchiveOnPrompt',
  'problems',
] as const

interface RegisterCall {
  path: string
  kind: string
  /** 挂上去的真实 handler——下面的接线测试就是打它，不是再自己拼一遍 deps。 */
  handler?: (request: unknown, response: unknown) => unknown
}

/** `/drc` 注册出来的对外形状，只取"用户看得见的那几项"。 */
interface CommandShape {
  name: string
  description?: string
  input?: { hint?: string }
}

/** hint 是 `pair | status | unpair` 这种串：按竖线切开再判，`unpair` 里含着 `pair` 这个子串。 */
function hintWords(hint: string | undefined): string[] {
  return String(hint ?? '')
    .split('|')
    .map((word) => word.trim())
    .filter(Boolean)
}

/**
 * 假 ctx 的 `get`。cordis 那侧的签名是泛型的（`get<T>(name, optional?) => T | undefined`），
 * 写成 `(name: string) => 具体对象 | undefined` 会在 `apply(ctx)` 的边界上红——
 * 所以这里保持泛型，值在内部断言一次。
 */
function fakeGet(byName: Record<string, unknown>): <T>(name: string, optional?: true) => T | undefined {
  return <T>(name: string): T | undefined => byName[name] as T | undefined
}

interface Booted {
  state(): Record<string, unknown>
  commandRegistered: boolean
  /** 注册出来的 `/drc` 对外形状（说明文字与提示行）——pill 可用时这里要少掉 `pair`。 */
  commandShape(): CommandShape | undefined
  providedKeys: string[]
  registerCalls: RegisterCall[]
  unregistered: () => number
  /** 真注册出来的 `/drc` handler；跑它才算验到"命令这一路没被连累"。 */
  runDrc(rawInput: string): Promise<unknown>
  waitForCarrier(): Promise<Record<string, unknown>>
  dispose(): void
}

function boot(
  options: {
    webServer?: unknown
    registerThrows?: boolean
    /** 只有 pill 那三条挂不上（右栏那条照旧成功）——新特性不许把既有特性一起拖死。 */
    actionsThrows?: boolean
    sidebarEnabled?: boolean
  } = {},
): Booted {
  /** 注册形状照 `LooseContext.commands.register` 的入参（handler 是可选的，这里不替它收紧）。 */
  interface Definition {
    name: string
    description?: string
    input?: { hint?: string }
    handler?: (invocation: { commandId: string; rawInput: string; agent?: unknown }) => unknown
  }
  const registered: Record<string, Definition> = {}
  const disposers: Array<() => void> = []
  const provided: Record<string, unknown> = {}
  const registerCalls: RegisterCall[] = []
  let unregistered = 0
  let disposed = false
  const statusDir = mkdtempSync(path.join(tmpdir(), 'drc-isolation-'))

  const wantsWeb = options.webServer !== undefined || options.registerThrows !== undefined || options.actionsThrows
  const web = wantsWeb
    ? {
        register: (route: RegisterCall) => {
          registerCalls.push(route)
          if (options.registerThrows) throw new Error('这个路由名已经被占了')
          if (options.actionsThrows && route.path !== '/plugins/dsh-remote-control/pairing')
            throw new Error('这两条路径宿主不给挂')
          return () => {
            unregistered += 1
          }
        },
      }
    : undefined

  const context = {
    // 假的/非 cordis 上下文：命令直接挂 ctx.commands（真 cordis 上这一读会抛，走 get/inject）。
    get: fakeGet(web === undefined ? {} : { webServer: web }),
    inject: () => undefined,
    provide: (name: string, value: unknown) => {
      provided[name] = value
    },
    commands: {
      register: (definition: Definition) => void (registered[definition.name] = definition),
    },
    on: () => () => undefined,
    off: () => undefined,
    onDispose: (fn: () => void) => void disposers.push(fn),
  }

  apply(context, {
    enabled: true,
    // 故意不可达：这条要的是"中继连不上"这个确定分支，不许它真连上任何东西。
    serverUrl: 'ws://127.0.0.1:1',
    hostToken: FAKE_TOKEN,
    hostId: 'isolation_host',
    statusFile: path.join(statusDir, 'status.json'),
    mockBridge: true,
    pairOnStartSec: 0,
    qrImage: false,
    qrOpen: false,
    // 默认 5000ms：那是"等强 carrier"的宽限期，测试里等它就等于把单测变成计时器。
    carrierGraceMs: 50,
    sidebarQr: {
      enabled: options.sidebarEnabled ?? true,
      imageFile: path.join(statusDir, 'sidebar-qr.png'),
      refreshMs: 200,
    },
  })

  const service = provided.dshRemoteControl as
    | {
        state?: Record<string, unknown>
        createPairing?: () => unknown
      }
    | undefined
  const definition = registered.drc

  return {
    state: () => service?.state ?? { relay: 'not-provided' },
    commandRegistered: definition !== undefined,
    commandShape: () => definition,
    providedKeys: Object.keys(provided),
    registerCalls,
    unregistered: () => unregistered,
    async runDrc(rawInput: string) {
      if (!definition?.handler) throw new Error('drc 命令没注册或没有 handler')
      return await definition.handler({ commandId: 'isolation-cmd', rawInput })
    },
    /**
     * 等到"载具已决定 + 中继真的走完一次连接尝试"，并**返回那一刻的快照**。
     *
     * 为什么必须返回快照而不是让断言各自再读一次：中继的保活重连在跑，
     * `relay` 会在 `offline ⇄ connecting` 之间跳。CI（Node 20 作业）上实测抓到过
     * "等载具时读到 offline，回头再读变成 connecting"导致的假红。
     * 对照测试要比的是**同一时刻的两份状态**，所以等待条件与取样必须是同一次动作。
     */
    async waitForCarrier() {
      const deadline = Date.now() + 8000
      for (;;) {
        const state = service?.state ?? {}
        if (state.carrier === 'mock' && state.relay === 'offline') return state
        if (Date.now() > deadline) {
          throw new Error(
            `等不到"载具决定 + 中继走完一次连接尝试"：${JSON.stringify(service?.state ?? {}).slice(0, 220)}`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
    dispose(): void {
      // 有守卫：主插件的 stop() 不做幂等保护（relay.stop() 被调两次会重复 removeAllListeners），
      // 而这条测试故意会在断言中途 dispose 一次、finally 再 dispose 一次。
      if (disposed) return
      disposed = true
      for (const fn of disposers.splice(0)) {
        try {
          fn()
        } catch {
          /* 关停失败不该污染断言结果 */
        }
      }
      rmSync(statusDir, { recursive: true, force: true })
    },
  }
}

test('缺 webServer：provide 与 drc 注册都在，路由一次都没去挂', async () => {
  const without = boot({})
  try {
    const state = await without.waitForCarrier()
    assert.equal(without.commandRegistered, true, '缺 webServer 时 drc 命令必须照样注册')
    assert.deepEqual(without.providedKeys, ['dshRemoteControl'], 'provide 必须照常发生')
    assert.equal(without.registerCalls.length, 0, '没有 webServer 就不该有人去挂路由')
    // 这条是"二维码不弹"的排查入口：probe 必须说清是没探到，而不是沉默。
    assert.equal((state.sidebar as Record<string, string>).webServer, 'none')
    assert.equal(state.relay, 'offline', `中继应当明确连不上（收到 ${String(state.relay)}）`)
  } finally {
    without.dispose()
  }
})

test('对照：主链路字段逐个相等、`/drc` 返回逐字节相等，差别只允许出现在 sidebar 那一块', async () => {
  const without = boot({})
  const withWeb = boot({ webServer: true })
  try {
    const a = await without.waitForCarrier()
    const b = await withWeb.waitForCarrier()
    for (const key of MAIN_LINK_KEYS) {
      assert.deepEqual(
        b[key],
        a[key],
        `主链路字段 ${key} 因为多了个 webServer 就变了：${JSON.stringify(a[key])} → ${JSON.stringify(b[key])}`,
      )
    }
    // 反证：上面那个循环不是"两边都空所以相等"。主链路必须真的有内容。
    assert.equal(a.carrier, 'mock', `载具应当是 mock（收到 ${String(a.carrier)}）`)
    assert.equal(a.relay, 'offline', `中继状态应当已经落到 offline（收到 ${String(a.relay)}）——否则这轮对照没有牙`)
    assert.equal(
      JSON.stringify(
        Object.keys(a)
          .filter((key) => key !== 'sidebar')
          .sort(),
      ),
      JSON.stringify(
        Object.keys(b)
          .filter((key) => key !== 'sidebar')
          .sort(),
      ),
      '两边快照的字段集合必须一致：少一个字段就是主链路被连带了',
    )

    // 命令这一路才是用户真正走得通的那条：返回必须逐字节相同。
    // 用 `unpair`（以及不带参数时的错误分支）而不是 `pair`——`pair` 的返回**有意**随 pill
    // 能不能点而变，那是 2026-10-03 那条"点一下配对"的拍板，下面单独钉。
    const textA = await without.runDrc('unpair')
    const textB = await withWeb.runDrc('unpair')
    assert.deepEqual(textB, textA, '/drc unpair 的返回因为 webServer 有无而不同，说明右栏那一半连累了命令分支')
    assert.equal((textA as { kind?: string }).kind, 'success', `宿主契约只认 success/error：${JSON.stringify(textA)}`)

    // 唯一允许的差别。
    assert.equal((a.sidebar as Record<string, string>).webServer, 'none')
    assert.equal((b.sidebar as Record<string, string>).route, 'registered')
    assert.equal((b.sidebar as Record<string, string>).actions, 'registered', 'pill 那三条路由也要挂上')
    assert.equal((b.sidebar as Record<string, string>).webServer, 'via get')
    assert.deepEqual(
      withWeb.registerCalls.map((call) => call.path),
      ['/plugins/dsh-remote-control/pairing', PAIR_NEW_ROUTE, PAIR_IMAGE_ROUTE, PAIR_STATUS_ROUTE],
      '四条路由一起挂：只读状态 + pill 发码 + pill 的图 + pill 抬头状态',
    )
    assert.equal(without.unregistered(), 0)
    // 停机要连着把路由注销掉：漏了的话换一代宿主会撞上"路由名已占用"，
    // 而表现是"重载一次之后右栏再也不弹"。这里在断言之后 dispose，两个 finally 里的
    // dispose 是同一次（helper 内部有 once 守卫）。
    withWeb.dispose()
    assert.equal(withWeb.unregistered(), 4, '四条路由都要注销')
  } finally {
    without.dispose()
    withWeb.dispose()
  }
})

test('配对入口的兵分：pill 点得开时 /drc pair 只指路，点不开时命令行仍发得出码', async () => {
  const noWeb = boot({})
  const withWeb = boot({ webServer: true })
  try {
    await noWeb.waitForCarrier()
    await withWeb.waitForCarrier()

    // 说明文字：pill 在的时候不能再把 pair 当主入口宣传，否则用户按提示打一遍、
    // 拿到的却是一句"去点状态栏"。
    assert.ok(
      hintWords(noWeb.commandShape()?.input?.hint).includes('pair'),
      `pill 不可用时 hint 必须还带 pair：${String(noWeb.commandShape()?.input?.hint)}`,
    )
    assert.ok(
      !hintWords(withWeb.commandShape()?.input?.hint).includes('pair'),
      `pill 可用时 hint 里的 pair 要去掉：${String(withWeb.commandShape()?.input?.hint)}`,
    )
    assert.match(String(withWeb.commandShape()?.description), /状态栏/)

    const viaPill = await withWeb.runDrc('pair')
    assert.deepEqual(
      viaPill,
      { kind: 'success', text: PAIR_VIA_PILL_TEXT },
      'pill 点得开时命令行不许顺手发码——那会绕开 pill 的幂等语义',
    )
    // 反证：上面那条不是"两边都返回同一句所以相等"。
    const viaCli = await noWeb.runDrc('pair')
    assert.notDeepEqual(viaCli, viaPill, 'pill 不可用时命令行必须走真正发码那一条分支')
    assert.equal((viaCli as { kind?: string }).kind, 'success')

    // `force` 是那颗 pill 没出现时唯一不能堵死的退路（宿主给不出 react / 没有 slots 服务
    // 时就是这种形状：路由挂上了，pill 却没挂上）。
    const forced = await withWeb.runDrc('pair force')
    assert.notDeepEqual(forced, viaPill, 'pill 可用时 `/drc pair force` 也必须走出发码那条分支')
    assert.equal((forced as { kind?: string }).kind, 'success')
  } finally {
    noWeb.dispose()
    withWeb.dispose()
  }
})

test('register() 抛错（路由名被占）：只废掉右栏那一半，注册与中继不受影响', async () => {
  const hostile = boot({ registerThrows: true })
  const control = boot({})
  try {
    const state = await hostile.waitForCarrier()
    const baseline = await control.waitForCarrier()
    assert.equal(hostile.commandRegistered, true, '我们这一半失败，drc 命令必须还在')
    assert.equal(state.relay, baseline.relay, '中继状态不许因为路由失败而变')
    assert.equal(state.carrier, baseline.carrier, '载具状态不许因为路由失败而变')
    assert.ok(
      String((state.sidebar as Record<string, string>).route ?? '').startsWith('register threw'),
      '路由注册抛错必须在 probe 里留痕，不然排查时会以为是"没有码"：' + JSON.stringify(state.sidebar),
    )
    // 第一条注册就抛 → 整个 sidebar 不起，`available` 是 false，命令行必须把 pair 留回来。
    // 这条是"兵分"的另一半：pill 挂不上不等于配对没了。
    assert.ok(
      hintWords(hostile.commandShape()?.input?.hint).includes('pair'),
      `路由挂不上时 pair 必须留在 hint 里：${String(hostile.commandShape()?.input?.hint)}`,
    )
    assert.equal(hostile.registerCalls.length, 1, '第一条注册就抛了，后三条不该再试')
    assert.equal(
      (state.sidebar as Record<string, string>).actions,
      undefined,
      '第一条就抛时不该有 actions 的痕迹（早退要真的早退）：' + JSON.stringify(state.sidebar),
    )
    assert.deepEqual(await hostile.runDrc('unpair'), await control.runDrc('unpair'), '/drc unpair 必须不受影响')
  } finally {
    hostile.dispose()
    control.dispose()
  }
})

test('只挂上右栏那条、pill 那三条挂不上：右栏照旧活，命令行把 pair 留回 hint', async () => {
  const partial = boot({ actionsThrows: true })
  try {
    const state = await partial.waitForCarrier()
    const sidebarState = state.sidebar as Record<string, string>
    // 新特性失败不能把 1.1.0 已在跑的右栏一起拖死——那是这条 try 分开的唯一理由。
    assert.equal(sidebarState.route, 'registered', '右栏那条要挂上：' + JSON.stringify(sidebarState))
    assert.ok(
      String(sidebarState.actions).startsWith('register threw'),
      'actions 留痕：' + JSON.stringify(sidebarState),
    )
    assert.equal(partial.registerCalls.length, 2, '第一条成功、pill 第一条就抛了该停在第二次尝试')
    assert.ok(
      hintWords(partial.commandShape()?.input?.hint).includes('pair'),
      `pill 点不开时 pair 必须回来：${String(partial.commandShape()?.input?.hint)}`,
    )
    assert.notDeepEqual(
      await partial.runDrc('pair'),
      { kind: 'success', text: PAIR_VIA_PILL_TEXT },
      '命令行必须真的走发码分支，而不是指路给一颗点不开的 pill',
    )
    partial.dispose()
    assert.equal(partial.unregistered(), 1, '挂上的那条收回；没挂上的不该留下半个注销')
  } finally {
    partial.dispose()
  }
})

test('pill 那三条挂上去的就是带守卫的那三条（接线，不是又拼一遍 deps）', async () => {
  const withWeb = boot({ webServer: true })
  try {
    const state = await withWeb.waitForCarrier()
    assert.equal(state.relay, 'offline', '这条 fixture 的中继是故意不可达的')

    const handlerFor = (p: string) => {
      const found = withWeb.registerCalls.find((call) => call.path === p)
      assert.ok(found?.handler, `${p} 没挂上或没带 handler：${JSON.stringify(withWeb.registerCalls)}`)
      return found!.handler as (request: unknown, response: unknown) => unknown
    }
    const run = async (p: string, method: string, headers: Record<string, string>) => {
      let status = 0
      let body = ''
      const res = {
        writeHead: (code: number) => {
          status = code
        },
        end: (chunk?: unknown) => {
          body = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''
        },
      }
      await handlerFor(p)({ method, url: '/', headers }, res)
      return { status, body }
    }

    // 发码：真机那个形状（环回 Host + 自定义头，**没有 Origin**）必须走通——
    // 桌面宿主转发时会删掉 origin，这一条在 2026-10-03 之前是点一下就 403 的。
    const ok = await run(PAIR_NEW_ROUTE, 'POST', LOOPBACK_HEADERS)
    assert.equal(ok.status, 200, ok.body)
    assert.deepEqual(JSON.parse(ok.body), { state: 'unavailable', reason: 'relay-offline' })

    // 三种被拒的形状都要在**挂上去的那条**上生效，而不是只在我的单元测试里生效。
    const noMarker = await run(PAIR_NEW_ROUTE, 'POST', { host: '127.0.0.1:5173' })
    assert.equal(noMarker.status, 403, '少了那个自定义头就该拒')
    assert.equal(JSON.parse(noMarker.body).guard, 'pair-marker-missing')
    assert.equal(
      (await run(PAIR_NEW_ROUTE, 'POST', { ...LOOPBACK_HEADERS, origin: 'https://evil.example.com' })).status,
      403,
      '跨站 Origin',
    )
    assert.equal((await run(PAIR_NEW_ROUTE, 'GET', LOOPBACK_HEADERS)).status, 405, '发码那条只接受 POST')

    // 图片：没有效码 → 204；非环回 Host → 403。
    assert.equal((await run(PAIR_IMAGE_ROUTE, 'GET', { host: '127.0.0.1:5173' })).status, 204)
    assert.equal((await run(PAIR_IMAGE_ROUTE, 'GET', { host: 'evil.example.com' })).status, 403)

    // 抬头那句状态：只读（Origin 缺席放过），字段集合就那三个。
    // `relay` 允许 offline / connecting 两种——保活重连在跑，这里钉死一种就是计时器测试。
    const status = await run(PAIR_STATUS_ROUTE, 'GET', { host: '127.0.0.1:5173' })
    assert.equal(status.status, 200, status.body)
    const shown = JSON.parse(status.body) as Record<string, unknown>
    assert.deepEqual(Object.keys(shown).sort(), ['hasCode', 'paired', 'relay'], '状态路由多出字段就是要重新审一遍')
    assert.ok(shown.relay === 'offline' || shown.relay === 'connecting', `relay 取值：${String(shown.relay)}`)
    assert.equal(shown.paired, 0)
    assert.equal(shown.hasCode, false, '中继不可达时发不出码，hasCode 必须跟着说实话')
    assert.equal((await run(PAIR_STATUS_ROUTE, 'POST', LOOPBACK_HEADERS)).status, 405)

    // 凭据红线：发码那条的回答里不许出现 PSK / 配对 URI。
    assert.ok(!ok.body.includes('psk'), `回答里出现了 psk：${ok.body}`)
    assert.ok(!ok.body.includes('dshr:'), `回答里出现了配对 URI：${ok.body}`)
  } finally {
    withWeb.dispose()
  }
})

test('config.sidebarQr.enabled=false：整半不起（webServer 在场也不挂路由），主链路照旧', async () => {
  const off = boot({ webServer: true, sidebarEnabled: false })
  try {
    const state = await off.waitForCarrier()
    assert.equal(off.registerCalls.length, 0, '关掉了就不该去挂路由')
    assert.equal((state.sidebar as Record<string, string>).sidebar, 'disabled')
    assert.equal(off.commandRegistered, true, '关掉右栏不影响命令注册')
    assert.equal(state.relay, 'offline')
  } finally {
    off.dispose()
  }
})
