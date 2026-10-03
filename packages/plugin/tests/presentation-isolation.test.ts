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

/** 一眼假的 token：仓库里不许出现真凭据，这条只验形状（同 status.test.ts）。 */
const FAKE_TOKEN = 'fake-host-token-not-a-real-secret-0123456789abcdef'

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
  providedKeys: string[]
  registerCalls: RegisterCall[]
  unregistered: () => number
  /** 真注册出来的 `/drc` handler；跑它才算验到"命令这一路没被连累"。 */
  runDrc(rawInput: string): Promise<unknown>
  waitForCarrier(): Promise<Record<string, unknown>>
  dispose(): void
}

function boot(options: { webServer?: unknown; registerThrows?: boolean; sidebarEnabled?: boolean } = {}): Booted {
  /** 注册形状照 `LooseContext.commands.register` 的入参（handler 是可选的，这里不替它收紧）。 */
  interface Definition {
    name: string
    handler?: (invocation: { commandId: string; rawInput: string; agent?: unknown }) => unknown
  }
  const registered: Record<string, Definition> = {}
  const disposers: Array<() => void> = []
  const provided: Record<string, unknown> = {}
  const registerCalls: RegisterCall[] = []
  let unregistered = 0
  let disposed = false
  const statusDir = mkdtempSync(path.join(tmpdir(), 'drc-isolation-'))

  const web =
    options.webServer === undefined && options.registerThrows === undefined
      ? undefined
      : options.registerThrows
        ? {
            register: (route: RegisterCall) => {
              registerCalls.push(route)
              throw new Error('这个路由名已经被占了')
            },
          }
        : {
            register: (route: RegisterCall) => {
              registerCalls.push(route)
              return () => {
                unregistered += 1
              }
            },
          }

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
    const textA = await without.runDrc('pair')
    const textB = await withWeb.runDrc('pair')
    assert.deepEqual(textB, textA, '/drc pair 的返回因为 webServer 有无而不同，说明右栏那一半连累了命令分支')
    assert.equal((textA as { kind?: string }).kind, 'success', `宿主契约只认 success/error：${JSON.stringify(textA)}`)

    // 唯一允许的差别。
    assert.equal((a.sidebar as Record<string, string>).webServer, 'none')
    assert.equal((b.sidebar as Record<string, string>).route, 'registered')
    assert.equal((b.sidebar as Record<string, string>).webServer, 'via get')
    assert.equal(withWeb.registerCalls[0]?.path, '/plugins/dsh-remote-control/pairing')
    assert.equal(without.unregistered(), 0)
    // 停机要连着把路由注销掉：漏了的话换一代宿主会撞上"路由名已占用"，
    // 而表现是"重载一次之后右栏再也不弹"。这里在断言之后 dispose，两个 finally 里的
    // dispose 是同一次（helper 内部有 once 守卫）。
    withWeb.dispose()
    assert.equal(withWeb.unregistered(), 1, '停机要把路由一起注销')
  } finally {
    without.dispose()
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
    assert.equal(hostile.registerCalls.length, 1, '确实走到过注册那一步')
    assert.deepEqual(await hostile.runDrc('pair'), await control.runDrc('pair'), '/drc pair 必须不受影响')
  } finally {
    hostile.dispose()
    control.dispose()
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
