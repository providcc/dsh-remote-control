/**
 * host-wiring.test — `apply()` 里"内核事件口到底接上没有"这条接线。
 *
 * 守的是 2026-10-06 真机上抓到的那条时序 bug（status.json 的
 * `probe.injectThrew:sessions = cannot get property "off" without inject`）：
 *
 * 1. `accept()` 原来把 `on`/`off` 的绑定写在**只处理 sessions** 的那一小段里，
 *    而 `ctx.get('sessions', true)` **同步可得**时 `tryStart()` 会在任何 `ctx.inject`
 *    回调之前把内核启起来 —— `subscribe()` 那一刻 `services.on` 还是 undefined，
 *    于是它记一句 `kernel has no on(); streaming disabled` 并**永久**返回空退订；
 *    `HostRuntime.start()` 有 started 闸门不会重试，该进程内**流式全黑**。
 *    而 `describe()` 的 `hasOn` 每次现读（那时 on 早绑上了）会显示 true，掩盖真相。
 * 2. `off` 的读取在真 cordis 的 Proxy ctx 上会**抛错**（读不存在的属性名不是 undefined），
 *    它把整个 inject 回调打断 —— 连 `probe[name]` 记账与 `tryStart()` 都没跑到。
 *
 * 为什么夹具要**落一条配对通道再恢复**：`runtime.start()` 只有两条触发路
 * （`peer-joined` 与"启动时从盘上恢复了会话"，见 index.ts 那两段注释）。真机上
 * 撞到这条 bug 的正是恢复那一条 —— 没有恢复会话的夹具根本走不到 `subscribe()`，
 * "订阅没接上"也就演不出来。
 *
 * 判据落在**接线**上而不是"apply 没抛"：要求 `on('session/event'|…)` 真的被调到，
 * 并通过真实事件派发看到**出站帧计数**涨上来。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'
import { defaultPairStoreFile } from '../src/shell/pair-store.js'

const FAKE_TOKEN = 'fake-host-token-not-a-real-secret-0123456789abcdef'
const HOST_A = 'wiring_host_a'
const HOST_B = 'wiring_host_b'
/** 16 字节全零的标准 base64：夹具用的假 PSK（仓库里不许出现真凭据）。 */
const FAKE_PSK = 'AAAAAAAAAAAAAAAAAAAAAA=='

/** 一个够用的 sessions 服务：`list()` 是 `accept()` 的先验成员。 */
const sessionsService = { list: () => [] }

interface Wiring {
  /** `on(name, listener)` 收到的全部事件名（按注册顺序）。 */
  readonly subscribed: string[]
  /** 往某条已注册的事件上派发一次。 */
  emit(name: string, ...args: unknown[]): void
  state(): Record<string, unknown>
  dispose(): void
}

const outboundOf = (state: Record<string, unknown>): Record<string, number> =>
  (state.outbound as Record<string, number> | undefined) ?? {}

interface BootOptions {
  hostId: string
  /** true = 根 ctx 上就挂着 on/off；false = 根 ctx 读 on/off 会抛（真机的 Proxy 形状）。 */
  rootHasEvents: boolean
}

interface WiringFixture extends Wiring {
  /** 只有"on 晚到"那种夹具才有：把宿主欠我们的注入回调补上。 */
  flushInject(): void
}

/**
 * 夹具：sessions 同步可得 + 盘上有一条可恢复的配对通道（于是 `apply` 内就会
 * `runtime.start()`），而 `ctx.inject` 的回调**一次都不触发**——
 * 这正是"任何 inject 回调之前就启动内核"的形状。
 */
function boot(options: BootOptions): WiringFixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-wiring-'))
  const statusFile = path.join(dir, 'status.json')
  const storeFile = defaultPairStoreFile(statusFile, options.hostId)
  writeFileSync(
    storeFile,
    JSON.stringify({
      version: 1,
      hostId: options.hostId,
      savedAt: Date.now(),
      conversations: [
        { id: 'c_wired0000001', psk: FAKE_PSK, seqHost: 0, createdAt: Date.now(), lastActivityAt: Date.now() },
      ],
    }),
  )

  const subscribed: string[] = []
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  const provided: Record<string, unknown> = {}
  const pending: Array<() => void> = []
  let dispose: (() => void) | undefined

  /** 宿主"晚到"的那个作用域上下文：on/off 只在这里有。 */
  const scoped = {
    get: <T>(name: string): T | undefined => (name === 'sessions' ? (sessionsService as T) : undefined),
    on: (name: string, listener: (...args: unknown[]) => void) => {
      subscribed.push(name)
      listeners[name] = listener
      return () => {}
    },
    off: () => undefined,
  }

  const context: Record<string, unknown> = {
    get: <T>(name: string): T | undefined => (name === 'sessions' ? (sessionsService as T) : undefined),
    inject: (names: string[], callback: (scopedArg: never) => void) => {
      if (names.includes('sessions')) pending.push(() => callback(scoped as never))
      return () => undefined
    },
    provide: (name: string, value: unknown) => {
      provided[name] = value
    },
    onDispose: (fn: () => void) => {
      dispose = fn
    },
  }
  if (options.rootHasEvents) {
    context.on = scoped.on
    context.off = scoped.off
  } else {
    // 真 cordis 的 Proxy：读这个作用域里没有的属性名是**抛错**，不是 undefined。
    Object.defineProperty(context, 'on', {
      get() {
        throw new Error('cannot get property "on" without inject')
      },
    })
    Object.defineProperty(context, 'off', {
      get() {
        throw new Error('cannot get property "off" without inject')
      },
    })
  }

  apply(context as never, {
    enabled: true,
    serverUrl: 'ws://127.0.0.1:1',
    hostToken: FAKE_TOKEN,
    hostId: options.hostId,
    statusFile,
  })

  const service = provided.dshRemoteControl as { state?: Record<string, unknown> } | undefined
  return {
    subscribed,
    emit: (name, ...args) => listeners[name]?.(...args),
    state: () => service?.state ?? {},
    flushInject: () => {
      for (const fire of pending.splice(0)) fire()
    },
    dispose: () => {
      dispose?.()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const EVENT_NAMES = ['session/event', 'session/created', 'agent/status', 'agent/error'] as const

test('sessions 同步可得、inject 一次都不回调：四类内核事件也必须在 apply 内就订阅上', () => {
  const wiring = boot({ hostId: HOST_A, rootHasEvents: true })
  try {
    for (const name of EVENT_NAMES) {
      assert.equal(
        wiring.subscribed.includes(name),
        true,
        `${name} 没有被订阅（已订阅：${JSON.stringify(wiring.subscribed)}）→ 该进程内事件流全黑，只有重启宿主才能恢复`,
      )
    }
  } finally {
    wiring.dispose()
  }
})

test('订阅真的接在 core 上：派发一条 agent/status 必须看到出站帧计数涨上来', () => {
  const wiring = boot({ hostId: HOST_A, rootHasEvents: true })
  try {
    const before = outboundOf(wiring.state()).run_state ?? 0
    wiring.emit('agent/status', { sessionId: 'ses_wired', status: 'running' })
    const after = outboundOf(wiring.state()).run_state ?? 0
    assert.ok(after > before, `事件派发没有走到 runtime（run_state ${before} → ${after}）：订阅挂上了但没接到 core`)
  } finally {
    wiring.dispose()
  }
})

test('根 ctx 读 on 会抛、on 只在晚到的作用域上下文上：补绑之后必须能订阅并出帧', async () => {
  const wiring = boot({ hostId: HOST_B, rootHasEvents: false })
  try {
    // 注入回调在 apply 返回之后才到（真机的形状）。
    wiring.flushInject()
    // 补绑窗口第一档是 0ms；等两档的时间，不依赖具体档位。
    await new Promise((resolve) => setTimeout(resolve, 80))
    for (const name of EVENT_NAMES) {
      assert.equal(
        wiring.subscribed.includes(name),
        true,
        `${name} 在 on 晚到之后仍然没有补订阅（已订阅：${JSON.stringify(wiring.subscribed)}）`,
      )
    }
    const before = outboundOf(wiring.state()).run_state ?? 0
    wiring.emit('agent/status', { sessionId: 'ses_late', status: 'running' })
    assert.ok((outboundOf(wiring.state()).run_state ?? 0) > before, '补绑后的订阅没有接到 core')
  } finally {
    wiring.dispose()
  }
})

/* ── onPairFail 的接线：中继说"这张码没配上"，主机必须换一张 ─────────────── */

/**
 * 起一只**假中继**（只实现"收帧 + 按需回一帧"这部分），把主机的中继客户端真的接上。
 *
 * 为什么要到这一层：`onPairFail` 原来在 `RelayClientOptions` 里有声明、`relay.ts` 里
 * 也有调用，而 `index.ts` **从不传它** —— 一个死选项。死选项没法用纯单元测试钉住
 * "接线到底接没接"，只能让真 socket 上来一帧 `pair-fail`，再看主机有没有换码。
 */
async function bootWithFakeRelay(hostId: string): Promise<{
  frames: Array<Record<string, unknown>>
  send(frame: Record<string, unknown>): void
  waitForFrame(match: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | undefined>
  close(): void
}> {
  const { WebSocketServer } = await import('ws')
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-fake-relay-'))
  const statusFile = path.join(dir, 'status.json')
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const frames: Array<Record<string, unknown>> = []
  let peer: { send(text: string): void } | undefined
  server.on('connection', (socket) => {
    peer = socket as unknown as { send(text: string): void }
    socket.on('message', (raw) => {
      try {
        frames.push(JSON.parse(String(raw)) as Record<string, unknown>)
      } catch {
        /* 坏帧在别的测试里管，这里只关心 pair-fail 那条路 */
      }
    })
  })

  const provided: Record<string, unknown> = {}
  let dispose: (() => void) | undefined
  const context: Record<string, unknown> = {
    get: <T>(name: string): T | undefined => (name === 'sessions' ? (sessionsService as T) : undefined),
    inject: () => () => undefined,
    on: () => () => undefined,
    off: () => undefined,
    provide: (name: string, value: unknown) => {
      provided[name] = value
    },
    onDispose: (fn: () => void) => {
      dispose = fn
    },
  }
  apply(context as never, {
    enabled: true,
    serverUrl: `ws://127.0.0.1:${port}`,
    hostToken: FAKE_TOKEN,
    hostId,
    statusFile,
  })

  const waitForFrame = async (
    match: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown> | undefined> => {
    const deadline = Date.now() + 3_000
    for (;;) {
      const hit = frames.find(match)
      if (hit) return hit
      if (Date.now() > deadline) return undefined
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  return {
    frames,
    send: (frame) => peer?.send(JSON.stringify(frame)),
    waitForFrame,
    close: () => {
      dispose?.()
      server.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('中继回 pair-fail 时主机必须换一张码：onPairFail 不许再是"有调用没接线"的死选项', async () => {
  const relay = await bootWithFakeRelay('wiring_host_c')
  try {
    const hello = await relay.waitForFrame((frame) => frame.t === 'hello')
    assert.ok(hello, '夹具自检：主机应当先发 hello')

    relay.send({ t: 'pair-fail', reason: 'already_used' })
    const published = await relay.waitForFrame((frame) => frame.t === 'pair-begin')
    assert.ok(
      published?.pairingToken,
      '中继说这张码已经用过，主机却一张新的都没发：屏幕上那张死码会一直挂着，用户只能干等 TTL',
    )
  } finally {
    relay.close()
  }
})
