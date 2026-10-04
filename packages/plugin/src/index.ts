/**
 * index — cordis bundle 入口（host 侧）。
 *
 * 职责边界（取证 docs/legacy-spec/host-plugin-cordis.md §1）：这个文件只做三件事
 * —— 读配置并校验、探测内核载体、把内核端口/中继客户端/运行时/防休眠接起来并持续写状态快照。
 * 配对入口只有状态栏那颗 pill（`pill/start.ts` 那四条路由）。业务逻辑都在 `core/`，
 * 平台知识都在 `platform/`。
 *
 * 三条不可违反的纪律：
 *
 * 1. **`apply()` 绝不向外抛异常**。宿主加载 bundle 时若这里抛出，整个 profile 起不来。
 *    所有失败路径都收敛成"写一次 status.json + 记一条日志"。
 * 2. **不写 `inject:` 闸门**（见同目录 cordis.patch.yml 注释）：本文件对每个内核面
 *    都软探测，写闸门只会让某一代宿主缺服务时整行不激活、插件静默不加载。
 * 3. **`provide()` 无条件执行**：外部（测试、其它插件）拿到的永远是同一个句柄，
 *    runtime 还没起来时 `createPairing()` 返回 null，而不是"这个插件不存在"。
 */
import path from 'node:path'
import { type CmdPayload, type EvPayload, buildPairingUri } from 'dsh-remote-wire'
import { HostRuntime, type RuntimeTransport } from './core/runtime.js'
import { KeepAwake } from './core/sleep-policy.js'
import { PairingSlots } from './core/keys.js'
import { PairingWindow } from './core/pairing-window.js'
import { RelayClient } from './transport/relay.js'
import { SystemSleepBackend } from './platform/sleep-posix.js'
import { createServicesKernel } from './platform/carrier-services.js'
import { createOneShotTimers, DEFAULT_SYSTEM_CLOCK } from './core/clock.js'
import { StatusFile } from './shell/status.js'
import { resolveHostId } from './shell/host-id.js'
import { PairStore } from './shell/pair-store.js'
import {
  DEFAULT_CONFIG,
  readConfig,
  redact,
  resolvePairStoreFile,
  resolveUploadDir,
  validateConfig,
  type PluginConfig,
} from './shell/config.js'
import { startPill, type PillHandle } from './pill/start.js'
import { type LivePairing, type PillStatus } from './pill/routes.js'
import { PLUGIN_VERSION } from './version.js'
import type { KernelPort, Clock } from './ports/index.js'

/** 我们只用到 ctx 的几个成员，所以不硬依赖 @deepseek-ai/cordis 的类型。 */
interface LooseContext {
  get?<T>(name: string, optional: true): T | undefined
  /**
   * `inject(names, cb)` 的回调参数**不是服务实例，而是已作用域化的上下文**（`c.get(name, true)`
   * 才拿到服务），并且这条回调 fiber 挂在我们这条 fiber 下面——我们的 fiber 一旦失败，
   * 它会连带被 dispose，回调就永远不会触发了（真机取证见 `apply()` 末尾那条纪律）。
   */
  inject?(names: string[], callback: (scoped: LooseContext) => void): unknown
  /** 事件注册口；作用域化上下文上才有，对 waterfall 是参与式监听（见 platform/guard.ts）。 */
  on?(name: string, listener: (...args: unknown[]) => void): unknown
  off?(name: string, listener: (...args: unknown[]) => void): unknown
  provide?(name: string, value: unknown): unknown
  /**
   * cordis 唯一的卸载钩子：`ctx.effect(() => disposer)`。
   * **没有 `onDispose` 这个东西**——ctx 是 Proxy，读不存在的属性名是"抛错"而不是
   * 返回 undefined，`?.` 挡不住（真机取证：`cannot get property "onDispose" without inject`
   * 让 apply 整体失败 → fiber FAILED → 六个 inject 子 fiber 全被 dispose → carrier=none）。
   */
  effect?(execute: () => (() => unknown) | void): unknown
}

export interface RuntimeHandle {
  readonly config: PluginConfig
  state(): Record<string, unknown>
  createPairing(): { qr: string; token: string; psk: string; expiresAt: number } | null
  stop(): void
}

const SERVICE_NAMES = [
  'sessions',
  'sessionQuery',
  'agents',
  'agentDefaultModel',
  'workspaceRegistry',
  'userQuestions',
  'sessionController',
]

/**
 * 同时保持的配对通道硬上界：超出就从最不活跃的开始剪（空闲 TTL 之外的第二道闸）。
 *
 * 配对策略是**只允许一台**（`onPeerJoined` 里新设备一来就作废旧的），所以正常情况下
 * 这里永远只有 0 或 1 条；留着这个上界是为了在"作废链路本身出问题"时不至于无界增长。
 */
const MAX_CONVERSATIONS = 64

/** 取证：同一个进程里宿主调用了几次 `apply`（bundle 被重复挂载时能看到）。 */
const APPLY_COUNT = { n: 0 }

/** 默认时钟：真实定时器。测试注入假时钟（见 core/clock.ts）。 */
export const systemClock: Clock = DEFAULT_SYSTEM_CLOCK

export function apply(ctx: LooseContext, injected: Partial<PluginConfig> = {}): void {
  let handle: RuntimeHandle | undefined
  try {
    handle = applyInner(ctx, injected)
  } catch (error) {
    // 兜底：任何一步抛出都不许穿出去。
    try {
      process.stderr.write(`[dsh-remote-control] apply failed: ${String((error as Error)?.stack ?? error)}\n`)
    } catch {
      /* stderr 也可能不可用 */
    }
  }
  // applyInner 之后碰 ctx 的每一句都必须各自包 try。
  // 真机取证（status.json 的 probe.fiberStates）：原来这里写的是
  //   ctx.onDispose?.(() => handle?.stop())
  // 而 cordis 的 ctx 是 Proxy——读一个**它没有的**属性名不是返回 undefined，是抛错
  // （reflect.ts 的 get trap：`cannot get property "onDispose" without inject`），
  // 可选链 `?.` 只挡 null/undefined、挡不住抛错。这一句抛出被 Fiber._reload 捕获，
  // 我们的 fiber 进 FAILED → _unload 把 applyInner 里登记的六个 ctx.inject 子 fiber
  // 一起 dispose（probe.injectChildren 全在 @DISPOSED/uid=null）→ 回调永远不触发 →
  // carrier=none，哪怕 `ctx.get('sessions', true)` 两秒后一直拿得到服务。
  // 卸载钩子只能用 cordis 真存在的 `ctx.effect`（reflect.ts:220 mixin 了它）。
  try {
    ctx.provide?.('dshRemoteControl', {
      get state(): Record<string, unknown> {
        return handle?.state() ?? { relay: 'offline', carrier: 'none', reason: 'not-started' }
      },
      createPairing: (): { qr: string; token: string; psk: string; expiresAt: number } | null =>
        handle?.createPairing() ?? null,
    })
  } catch {
    /* 这一代宿主可能不支持 provide */
  }
  let disposeHooked = false
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => void handle?.stop())
      disposeHooked = true
    }
  } catch {
    /* 没有 effect 口的代际 */
  }
  if (!disposeHooked && 'onDispose' in ctx) {
    // `'x' in ctx` 走的是 Proxy 的 has trap，不抛错——这是在这个宿主上"探测一个属性
    // 到底有没有"的唯一安全姿势；直接点属性就等着抛。测试替身/别的代际才提供 onDispose。
    try {
      ;(ctx as { onDispose?: (fn: () => void) => void }).onDispose?.(() => void handle?.stop())
    } catch {
      /* 同上 */
    }
  }
}

function applyInner(ctx: LooseContext, injected: Partial<PluginConfig>): RuntimeHandle | undefined {
  const config = readConfig(injected)
  const clock = systemClock
  // 载具探测的复查（8s/25s/60s）与载具宽限都是"宿主还活着就顺手看一眼"的一次性动作。
  // 它们必须 unref 且在停机时撤掉，否则 60s 那一发会把事件循环钉住——`node e2e/run.mjs`
  // 1.2s 跑完却 60s 才退出、任何 headless/CLI 跑法白等一分钟，都出自这里（见 core/clock.ts）。
  const oneShot = createOneShotTimers(clock)
  const status = new StatusFile(config.statusFile, clock)
  /**
   * 这一台主机的身份。配置给了就用配置的，否则读/写 status.json 旁边那个 `host-id` 文件
   * ——**不能每次加载现造**，那会让中继顶不了旧号、往换过身份的对端推帧（取证 §3.4 与
   * `shell/host-id.ts`）。`statusFile` 被清空（关掉快照）时不猜目录，退回一次性身份。
   */
  const hostId = resolveHostId(config.statusFile ? path.dirname(config.statusFile) : '', config.hostId)
  const log = (message: string, fields: Record<string, string | number | boolean | undefined> = {}): void => {
    try {
      process.stdout.write(
        `${JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: `dsh-remote-control ${message}`, ...fields })}\n`,
      )
    } catch {
      /* GUI 宿主里 stdout 可能不可用 */
    }
  }
  /**
   * 配对通道的密钥簿落盘（免扫码重连，见 `shell/pair-store.ts`）。
   *
   * 在 `start()` 之前建好：主机重启后要在**第一帧 resync 之前**就把会话恢复进密钥簿，
   * 否则 resync 声明的是空列表，中继会把这些通道当成"主机已放弃"删掉，
   * 手机下次发帧就撞 `unknown_session` —— 症状与落盘没生效一模一样。
   */
  const pairStoreFile = resolvePairStoreFile(config, hostId)
  const pairStore = new PairStore({ file: pairStoreFile, hostId, log })
  const restoredAtBoot = pairStoreFile ? pairStore.load() : []
  const problems = validateConfig(config)
  for (const problem of problems) {
    log(`config ${problem.level}`, { field: problem.field, message: problem.message })
  }

  if (!config.enabled) {
    status.write({ carrier: 'none', relay: 'idle', reason: 'disabled' })
    return undefined
  }
  if (problems.some((problem) => problem.level === 'error')) {
    // 有 error 级问题就不启动，但一定留下面包屑：否则"为什么什么都没发生"没有答案。
    status.write({
      carrier: 'none',
      relay: 'idle',
      reason: 'invalid-config',
      serverUrl: config.serverUrl,
      hostToken: undefined,
      problems: problems.map((problem) => `${problem.level}:${problem.field}:${problem.message}`),
    })
    return undefined
  }

  const slots = new PairingSlots(() => clock.now())
  const sleep = new KeepAwake(new SystemSleepBackend(), clock, {
    idleReleaseMs: config.keepAwake.idleReleaseSec * 1000,
    keepDisplay: config.keepAwake.keepDisplay,
  })
  if (config.keepAwake.enabled) sleep.setEnabled(true)

  let kernel: KernelPort | undefined
  let runtime: HostRuntime | undefined
  let relay: RelayClient | undefined
  let startedCarrier = ''
  /**
   * 状态栏那颗 pill 的四条路由（配对的唯一入口）。`undefined` = 还没起 / 起不动。
   * 它**不在主链路上**：没有 `webServer` 时它就是 undefined，配对、中继、命令一行都不受影响
   * ——这正是原来"拆成两个包"所提供的隔离，现在由 `startPill` 的软探测提供。
   */
  let pillRoutes: PillHandle | undefined
  // RelayClient 是唯一知道连接此刻怎么样的一方；状态快照读这两个值。
  let lastRelayState: 'online' | 'connecting' | 'offline' = 'connecting'
  let lastRelayProblem: string | undefined
  let lastRelayGeneration = 0

  const transport: RuntimeTransport = {
    reply(conversationId: string, payload: EvPayload): boolean {
      return relay ? relay.send(conversationId, payload) : false
    },
    broadcast(payload: EvPayload): number {
      return relay ? relay.broadcast(payload) : 0
    },
    hasClient(conversationId: string): boolean {
      return relay?.hasClient(conversationId) ?? false
    },
    conversationIds(): string[] {
      return relay?.conversationIds() ?? []
    },
    voidConversation(conversationId: string): void {
      relay?.voidConversation(conversationId)
    },
  }

  const start = (port: KernelPort): void => {
    if (runtime) return
    kernel = port
    startedCarrier = port.carrier
    relay = new RelayClient({
      url: config.serverUrl,
      hostId,
      label: config.hostLabel,
      token: config.hostToken,
      clock,
      log,
      lookupPairingSlot: (token) => slots.resolveFor(token),
      onPairReady: (token, ttlMs) => {
        // 服务端权威 TTL：不改写就会提前清掉 PSK，造成"配对成功但全解不开"。
        if (!slots.applyServerTtl(token, ttlMs)) log('pair-ready for an unknown token', { token })
        pairingWindow.applyServerTtl(token, ttlMs)
      },
      onPeerJoined: (conversationId, pairingToken) => {
        /**
         * **只允许一台**（2026-10-03 拍板）。中继在通知我们之前已经把这条新通道开好了
         * （`relay.ts` 的 peer-joined 先 `conversations.open` 再回调），所以这里要作废的是
         * **除它以外**的所有通道——新设备一进来，旧设备当场被踢下去。
         *
         * 走 `voidConversation` 而不是只删本地：只删本地的话，中继仍会把旧手机的密文转过来，
         * 而那台手机面对的是一个听不见的对端（R1 那个静默黑洞）。`session-leave` 发出去，
         * 旧手机端才会显示"主机已断开，请重新配对"。
         */
        for (const id of relay?.conversationIds() ?? []) {
          if (id !== conversationId) relay?.voidConversation(id)
        }
        runtime?.start()
        void runtime?.pushSessions('peer-joined')
        // 一次性码用掉了就当场换一张新的（而不是等半程刷新）：第二部手机要的是一张新码，
        // 多轮真链路取证也靠这条才不用重启宿主。
        if (pairingToken) {
          pairingWindow.markConsumed(pairingToken)
          // status.json 里也不能再挂着这张已经用掉的码：外部脚本只看年龄，不看是否被消费。
          if (active.pairing?.token === pairingToken) active.pairing = null
        }
        log('client paired', { conversationId })
      },
      onClientLeft: () => {
        void runtime?.pushSessions('client-left')
      },
      onConversationGone: (conversationId) => log('conversation gone', { conversationId }),
      onCommand: (conversationId, cmd: CmdPayload) => void runtime?.handleCommand(cmd, conversationId),
      onState: (info) => {
        lastRelayState = info.relay
        lastRelayProblem = info.problem
        lastRelayGeneration = info.generation
      },
      // 配对通道长存（D3）之后必须自己剪枝：中继那边的空闲 TTL 是 7 天，
      // 不剪就是无界的 PSK 簿 + 每次广播对废弃通道逐个密封。
      // 两条 TTL 分开：新配对的按 24 小时剪，从盘上恢复的按 `restoredIdleTtlSec`
      // （默认 7 天，与中继对齐）—— 理由见 config.ts 与 keys.ts 的 `Conversation.restored`。
      prunePolicy: {
        idleTtlMs: config.conversationIdleTtlSec * 1000,
        restoredIdleTtlMs: config.restoredIdleTtlSec * 1000,
        maxConversations: MAX_CONVERSATIONS,
      },
      // 结构性变化（新配对 / 作废）立刻落盘。只改了 seqHost 与 lastActivityAt 的场合
      // 由 status 的 3 秒 tick 批量落（见下面 `pairStore.markDirty()` 那一段）——
      // 挂在这里等于每广播一次写一次盘。
      onStructuralChange: () => {
        if (!pairStoreFile || !relay) return
        pairStore.save(relay.conversations.snapshot(), clock.now())
      },
      onBookActivity: () => {
        // 只标脏：真正的写盘在 status 的 3 秒 tick 上批量做。
        pairStore.markDirty()
      },
    })
    runtime = new HostRuntime(port, transport, sleep, clock, {
      listingRefreshMs: config.listingRefreshSec * 1000,
      unarchiveOnPrompt: config.unarchiveOnPrompt,
      uploadDir: resolveUploadDir(config),
      maxImageBytes: config.maxImageBytes,
      approvalTimeoutMs: config.approvalTimeoutSec * 1000,
      log: (message, fields) => log(message, fields),
    })
    /**
     * **恢复必须发生在 `connect()` 之前**：`hello-ok` 一到就发 `resync`，
     * 而 resync 声明的列表就是密钥簿当前的内容。晚一步恢复，中继已经按空列表把
     * 这些通道删掉了 —— 表现是"落盘明明有数据，手机还是被要求重新扫码"。
     */
    const restoredIds = relay.restoreConversations(restoredAtBoot)
    if (restoredIds.length > 0) {
      /**
       * 有恢复出来的会话就**立刻启动 runtime**，不等 `onPeerJoined`。
       *
       * 原来 `runtime.start()` 只写在 `onPeerJoined` 里（下面那段），那假设了
       * "每一次有会话可用的时刻都必然伴随一次新配对"。落盘把这个假设打破了：
       * 主机重启后手机是**恢复**而不是重配，它不会发 `pair-begin-client`，
       * 于是 `onPeerJoined` 永远不来 —— 主机不订阅内核事件、不挂交互 sink、
       * 不起刷新节拍，手机却已经连上并显示"在线"。那与配对丢失在用户眼里完全一样，
       * 而且更难查（status.json 里 conversations=1、carrier 也正常）。
       */
      runtime.start()
      log('runtime started from restored conversations', { conversations: restoredIds.length })
    }
    relay.connect()
    // 自动发码走 pairingWindow，而不是启动时发一张就完事：
    // 一张码是一次性的，用完/中继重启/过半程都得换一张（判据见 core/pairing-window.ts）。
    // tick 挂在 status 的 3 秒节拍上（旧实现就是挂在这里），并且**先 tick 一次**，
    // 让 `pairOnStartSec>0` 的实例一起来就能看到 status.json 里有码。
    pairingWindow.tick()
    status.start(() => {
      pairingWindow.tick()
      relay?.pruneConversations()
      // `seqHost` 与 `lastActivityAt` 每次广播都变，挂在 `onStructuralChange` 上等于
      // 每 15 秒写一次盘；所以那些变动只标脏，这里按 3 秒节拍批量落一次。
      // 判据是 `hasPendingChanges`：**没脏就不写**，否则 status.json 的 3 秒节拍
      // 会变成一个无条件写盘的心跳（而这个插件在 GUI 宿主里可能连开好几天）。
      if (pairStoreFile && pairStore.hasPendingChanges && relay) {
        pairStore.save(relay.conversations.snapshot(), clock.now())
      }
      // 配对码簿也要剪枝，理由与上面那句完全一样：一张码是一次性的，
      // 用掉/过期之后那行 slot 只是留在 Map 里，害得 `status.json` 的
      // `pendingPairs` 只增不减（实测能涨到 5 以上），而那个数字是排障时
      // 判断「中继那边攒了多少待配对条目」的唯一依据 —— 涨着就说明不了任何事。
      // `prune()` 早就写好了，只是**一直没有调用方**（`grep -rn 'prune()'` 只命中定义）。
      slots.prune()
      return state()
    })
  }

  const publishPairing = (
    ttlMs = config.pairTtlMs,
  ): { qr: string; token: string; psk: string; expiresAt: number } | null => {
    if (!relay) return null
    const slot = slots.create(ttlMs)
    // 发不出去就不算一张码：`raw()` 对非 OPEN 的 socket 是静默丢弃，
    // 只记本地会留下"status.json 显示有效、中继那边根本没收到"的死码（取证 §6.2）。
    if (!relay.publishPairing(slot)) {
      log('pairing published to a socket that is not open', { token: slot.token })
      return null
    }
    const qr = buildPairingUri({
      server: config.serverUrl,
      psk: slot.psk,
      hostLabel: config.hostLabel,
      token: slot.token,
    })
    return { qr, token: slot.token, psk: slot.psk, expiresAt: slot.expiresAt }
  }

  const state = (): Record<string, unknown> => {
    const snapshot = sleep.snapshot()
    return {
      carrier: startedCarrier || (config.mockBridge ? 'mock' : 'probing'),
      serverUrl: config.serverUrl,
      hostLabel: config.hostLabel,
      // 主机身份。中继日志里认的就是它，所以"手机连不上/丢帧涨"第一件事是看这个值
      // 在两次重启之间有没有变（变了就是身份没稳住，见 shell/host-id.ts）。
      hostId,
      relay: relay ? relayState() : 'idle',
      relayProblem: relayProblem(),
      conversations: relay?.conversationCount ?? 0,
      /**
       * 当前连着的手机台数（去重的 clientId）。
       *
       * 为什么必须与 `conversations` 分开报：「解除配对 → 重新配对」会开一条**新会话**，
       * 而手机还是那一台。所以拿会话数回答"几台手机连着"，用户解完配对看到数字反而变大 ——
       * 那个现象与"我的解配没生效"完全一致，最容易让人把解配按钮当坏的。
       * `pendingPairs` 是另一个东西：那是**还挂着、还没被用掉的配对码**。
       */
      pairedClients: relay?.clientCount ?? 0,
      pendingPairs: slots.size,
      /**
       * 密钥簿落盘的排障面。
       *
       * `restored` 是"本次启动从盘上恢复了几条会话"——它与 `conversations` 的差值
       * 就是"落盘没生效"的判据：`conversations > 0 && restored === 0 && pairStore.enabled`
       * 意味着这些会话是本次运行新配出来的（正常），反过来
       * `restored > 0` 而 `conversations === 0` 才是异常。
       *
       * **`lastSavedAt` 与路径都不含 PSK**：这份快照会被外部脚本读，
       * 文件路径本身也不是凭据（里面的内容才是）。
       */
      pairStore: {
        enabled: pairStoreFile !== '',
        file: pairStoreFile || undefined,
        restored: restoredAtBoot.length,
        lastSavedAt:
          pairStoreFile && pairStore.lastSavedAt > 0 ? new Date(pairStore.lastSavedAt).toISOString() : undefined,
      },
      pairing: describeActivePairing(),
      keepAwake: snapshot,
      kernel: kernel?.describe() ?? null,
      // 出站计数：手机上"没收到 X"的第一现场对比点（插件没发 vs 发了但路上丢了）。
      outbound: runtime?.stats ?? null,
      probe,
      // 配对入口（那颗 pill 的四条路由）为什么没起，是"配不了对"唯一的排查入口：
      // 这里直接把软探测的结果带出来。
      pill: pillRoutes?.probe ?? { webServer: 'not-started' },
      // token 永远不出现真值；这条有测试锁住。
      hostToken: undefined,
      hostTokenShape: config.hostToken ? redact(config.hostToken) : undefined,
      mockBridgeForced: config.mockBridge,
      problems: [
        ...problems.map((problem) => `${problem.level}:${problem.field}`),
        // **每次快照现判，不在 apply 里 push 一次**。`webServer` 可能是 `ctx.inject` 的回调
        // 晚到才拿到的，apply 返回那一刻 `available` 还是 false——留在 apply 里就会写出
        // `routes:"registered"` 与 `problems:["warn:pill"]` 并存的假警报
        // （2026-10-03 真机重启后实测抓到）。为什么没挂上从同一个快照的 `pill` 探针读。
        ...(pillRoutes?.available ? [] : ['warn:pill']),
      ],
      ...(config.pairOnStartSec > 0 ? { pairOnStartWarn: 'status.json 里带着仍然有效的配对码与 PSK' } : {}),
    }
  }

  const active = { pairing: null as { qr: string; token: string; expiresAt: number } | null }
  /**
   * status.json 里的 `pairing` 必须是**窗口正在维护的那一张**（它的 QR 才在 active.pairing 里），
   * 不是 `slots.latest()`：手工 /drc pair 之后自动刷新会发新的一张，两者一旦分叉，
   * 外部脚本读到的是"一张没有二维码的码"。用 `resolveFor` 取密钥顺带把已过期的剔掉。
   */
  function describeActivePairing(): Record<string, unknown> | null {
    const shown = active.pairing
    if (!shown) return null
    const slot = slots.resolveFor(shown.token)
    if (!slot) return null
    return {
      token: slot.token,
      psk: slot.psk,
      expiresAt: new Date(slot.expiresAt).toISOString(),
      qr: shown.qr,
      ageSec: Math.max(0, Math.round((clock.now() - slot.createdAt) / 1000)),
    }
  }

  function relayState(): 'online' | 'connecting' | 'offline' {
    return lastRelayState
  }
  function relayProblem(): string | undefined {
    return lastRelayProblem
  }

  const wrappedPublish = (ttlMs = config.pairTtlMs): ReturnType<typeof publishPairing> => {
    const created = publishPairing(ttlMs)
    if (created) {
      active.pairing = { qr: created.qr, token: created.token, expiresAt: created.expiresAt }
      // 手工发的那张也要让窗口认领，否则窗口以为"没有活动码"又发一张。
      pairingWindow.adopt({ token: created.token, createdAt: clock.now(), expiresAt: created.expiresAt })
    }
    return created
  }

  const createPairing = (): ReturnType<typeof wrappedPublish> => wrappedPublish()

  /**
   * 当前**仍然有效**的那张码，只读——不发新的。
   *
   * 用 `active.pairing` 而不是 `describeActivePairing()`：后者带着 `psk`，而它的返回值会被
   * 状态栏那条图片路由间接消费；这里要的只是"屏幕上现在该显示哪张"。
   * `slots.resolveFor` 顺手把已过期的剔掉，所以 `pairing.png` 在没有效码时拿到 null → 204。
   */
  function currentPairing(): LivePairing | null {
    const shown = active.pairing
    if (!shown) return null
    if (!slots.resolveFor(shown.token)) return null
    return { qr: shown.qr, token: shown.token, expiresAt: shown.expiresAt }
  }

  /**
   * 幂等版发码：已经有一张能用的就给那张，没有才向中继申请新的。
   *
   * 为什么必须幂等：状态栏那颗 pill 是可以连点的，而每点一次发一张的话，
   * 中继的 pending 表里会同时挂着三个 PSK，屏幕上显示的却是其中一张——
   * 手机扫到没被显示的那张就全线解不开。那正是当初"多码事故"的形状。
   */
  function ensureFreshPairing(): LivePairing | null {
    const fresh = currentPairing() ?? createPairing()
    if (!fresh) return null
    // **在这里就把 psk 摘掉**，而不是靠"下游记得只读那三个字段"：这条返回值会被浏览器
    // 可达的那条发码路由间接消费，红线（PSK 从不上网）要靠形状成立，不靠调用方自律。
    return { qr: fresh.qr, token: fresh.token, expiresAt: fresh.expiresAt }
  }

  /**
   * pill 抬头那句"连接状态"与点开那三行（中继 / 状态 / 版本）：中继那一行取值口径与
   * `status.json` 完全一致（同一个 `relayState()`），免得两处说两种话。
   * 这里出去的四个字段都不是凭据——6 位码、PSK、配对 URI 一个都不带。
   *
   * ⚠️ `paired` 读的是 **clientCount（手机台数）而不是 conversationCount（会话数）**，
   * 这不是随手选的：会话按 D3 长存，手机解配也不删（手机回前台要用同一个 convId 回来），
   * 于是解配之后 `conversationCount` **恒为 1**，pill 会一直显示"已配对"——
   * 用户点了手机上的「解除配对」、主机这边毫无变化，正是这个字段顶错了。
   * 主机侧的 `peer-left` 已经把 clientId 从成员表摘掉（`relay.ts`），所以这里读
   * `clientCount` 才是"现在真有手机连着吗"。
   *
   * 为什么 `clientCount` 在配对瞬间不会是 0（那会误报"未配对"）：配对成功的
   * 那一刻成员表确实是空的，手机 clientId 要等它**下一帧**才带上来 ——
   * 所以它只能靠 `onEncrypted` 登记，不能只在 `open()` 记（见 relay.ts）。
   * 好在 mp 侧 `_onPaired` 里立刻发了一帧 `cmd.list_sessions`，
   * 那帧到达时成员表就补齐了，pill 最多差一个轮询周期（3 秒）不会一直空着。
   */
  function pillStatus(): PillStatus {
    // runtime 还没起来（没有对端时它根本不 start）时按"没有事在等"说，
    // 而不是让那颗 pill 因为读不到字段而退回 `已配对`。
    const waiting = runtime?.waiting ?? { count: 0, oldestSec: 0 }
    return {
      relay: relay ? relayState() : 'idle',
      paired: relay?.clientCount ?? 0,
      // 配对簿里几条会话 = 配对还在不在。为什么必须与 paired 分开：pair-store 之后
      // 配对按 D3 长存、落盘，手机退后台只是 socket 断——只用 clientCount 回答 配没配上，
      // 用户把小程序放进后台的每一分钟，桌面那颗 pill 都会说 未配对，点开还会烧一张
      // 不需要的新码（2026-10-04 用户报的误解）。
      pairings: relay?.conversationCount ?? 0,
      serverUrl: config.serverUrl,
      version: PLUGIN_VERSION,
      waiting: waiting.count,
      waitingOldestSec: waiting.oldestSec,
    }
  }

  /**
   * 退出配对（弹窗右上角那颗按钮走的就是这里）：作废当前所有配对通道，返回条数。
   *
   * 幂等——本来没配上时返回 0，面板把 0 当成功（轮询与点击之间状态可能已经变了，
   * 把这种正常竞态报成失败只会让面板显示一句看不懂的红字）。
   * 与每条通道走 `voidConversation`，中继那边才会收到 `session-leave`、
   * 手机端才会显示"主机已断开，请重新配对"。
   */
  function unpairAll(): number {
    const ids = relay?.conversationIds() ?? []
    for (const id of ids) relay?.voidConversation(id)
    return ids.length
  }

  /**
   * "让屏幕上永远有一张能用的码"这条策略（四条 stale 判据 + online 闸门，
   * 逐条动机见 `core/pairing-window.ts` 文件头）。tick 挂在 status 的 3 秒节拍上。
   */
  const pairingWindow = new PairingWindow(
    {
      clock,
      relayOnline: () => lastRelayState === 'online' && relay !== undefined,
      generation: () => lastRelayGeneration,
      publish: (ttlMs) => {
        const created = wrappedPublish(ttlMs)
        if (!created) return null
        return { token: created.token, createdAt: clock.now(), expiresAt: created.expiresAt }
      },
      log,
    },
    config.pairOnStartSec,
  )

  // ── 载体探测：services > (mock) ────────────────────────────────────
  const collected: Record<string, unknown> = {}
  const hasServices = (): boolean => typeof collected.sessions === 'object' && collected.sessions !== null

  const probe: Record<string, string> = {}
  const injectFired: string[] = []
  let hasGet = true
  let hasInject = true
  let decided = false
  /** 取证：`ctx.inject` 返回的子 fiber，用来区分"依赖没满足"和"子 fiber 已被拆掉"。 */
  const injectChildren: [string, unknown][] = []
  /** 取证：我们这条 fiber 的生命周期轨迹（含进入 UNLOADING/DISPOSED 时的调用栈）。 */
  const states: string[] = []
  const tryStart = (): void => {
    if (runtime) return
    if (hasServices()) {
      if (decided) {
        // 服务热补丁进同一个对象：runtime 已经持有它的引用，不需要重启。
        return
      }
      decided = true
      start(createServicesKernel(collected as never, { log, takeOverQuestions: config.takeOverQuestions, clock }))
      return
    }
    // 没有 services 载体就不启动，也不退回 apiProxy/typert：桌面态从未注册 apiProxy 服务，
    // 而它的调用信封在旧实现里整个是错的、无法验证；typert 只有 invoke()，既不能列会话
    // 也不能发指令，接上去只是一台"永远空列表"的机器。这两条**探都不探**：真要用再写，
    // 留着只是让"下一版会不会接上"变成读代码的人去猜。
    // （取证 docs/legacy-spec/host-plugin-cordis.md §2.4 表与 §3 表第 14-19 行）
  }

  /** 关键成员先验：收下不合法的对象比不收更糟（旧实现踩过的坑）。 */
  const requiredMember: Record<string, string> = { sessions: 'list', sessionQuery: 'listSessions', agents: 'get' }
  /** 把服务对象的前几个成员拼成可读指纹；这是取证，绝不许抛。 */
  const keysOf = (value: unknown): string => {
    try {
      return Object.keys(value as object)
        .slice(0, 6)
        .join('|')
    } catch (error) {
      return `keys threw: ${String((error as Error)?.message ?? error).slice(0, 60)}`
    }
  }
  /** 一个候选来源里取出 `name`：先按"作用域上下文"读，读不到再按"直接就是服务"读。 */
  const pickFrom = (source: unknown, name: string): unknown => {
    if (!source || typeof source !== 'object') return undefined
    const asContext = source as LooseContext
    if (typeof asContext.get === 'function') {
      try {
        const got = asContext.get(name, true)
        if (got) return got
      } catch {
        /* 这个候选没有该服务 */
      }
    }
    try {
      // 直接点属性在 cordis 上下文上只在"这个名字已注入本 fiber"时成立，否则 get trap
      // 抛错（不是返回 undefined）——所以这里必须包 try。
      return (source as Record<string, unknown>)[name]
    } catch {
      return undefined
    }
  }
  /**
   * 收下探到的服务并尝试启动；`via` 只用于把"从哪条路拿到的"记进 probe。
   * 晚到的服务热补丁进同一个对象：runtime 已经持有它的引用，不需要重启。
   */
  const accept = (name: string, value: unknown, source: unknown, via: string): boolean => {
    if (!value || typeof value !== 'object') return false
    const member = requiredMember[name]
    if (member && typeof (value as Record<string, unknown>)[member] !== 'function') {
      probe[name] = `object without ${member}()`
      return false
    }
    collected[name] = value
    const asContext = source as LooseContext | undefined
    if (name === 'sessions' && typeof collected.on !== 'function' && typeof asContext?.on === 'function') {
      collected.on = asContext.on.bind(asContext)
      if (typeof asContext.off === 'function') collected.off = asContext.off.bind(asContext)
    }
    probe[name] = `${via}(${keysOf(value)})`
    tryStart()
    return true
  }

  for (const name of SERVICE_NAMES) {
    try {
      if (typeof ctx.get !== 'function') hasGet = false
      const found = ctx.get?.(name, true)
      probe[name] = found
        ? typeof found === 'object'
          ? `object(${Object.keys(found as object)
              .slice(0, 6)
              .join('|')})`
          : typeof found
        : 'none'
      if (found) collected[name] = found
    } catch (error) {
      // 这一代宿主没这个服务
      probe[name] = `get threw: ${String((error as Error)?.message ?? error).slice(0, 60)}`
    }
    try {
      // 关键：`ctx.inject(names, cb)` 的回调参数**不是服务实例，而是已作用域化的上下文**，
      // 要在回调里 `c.get(name, true)` 才拿得到东西（第一版按"回调参数=服务"写，
      // 结果六个服务全 none、carrier=none —— 这个形状错了比抛错更难查）。
      const child = ctx.inject?.([name], ((...cbArgs: unknown[]) => {
        injectFired.push(`${name}(args=${cbArgs.length})`)
        probe.injectFiredLive = injectFired.join('|')
        // 回调整段包 try：这条子 fiber 的 apply 抛出会让 cordis 把它连同我们其它
        // 五条探测一起 dispose 掉，代价是"服务明明在、carrier 却起不来"。
        try {
          // 取证：不同代际这里拿到的可能是"作用域上下文"，也可能直接就是服务。逐个试。
          let value: unknown
          let from: unknown
          for (const candidate of [cbArgs[0], ...cbArgs, ctx]) {
            value = pickFrom(candidate, name)
            if (value) {
              from = candidate
              break
            }
          }
          if (accept(name, value, from, 'via inject')) return
          if (!value) probe[name] = `${probe[name] ?? 'none'} (inject fired, empty)`
        } catch (error) {
          probe[`injectThrew:${name}`] = String((error as Error)?.message ?? error).slice(0, 160)
        }
      }) as never)
      if (child !== undefined) injectChildren.push([name, child])
    } catch (error) {
      hasInject = false
      probe[name] = `${probe[name] ?? 'none'}; inject threw: ${String((error as Error)?.message ?? error).slice(0, 60)}`
    }
  }
  probe.hasGet = String(hasGet)
  probe.hasInject = String(hasInject)
  // 一次性取证：这一代宿主到底给了 ctx 什么。猜"名字对不对"之前先看形状。
  probe.ctxKeys = Object.keys(ctx).slice(0, 40).join('|')
  probe.ctxProtoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(ctx) ?? {})
    .slice(0, 40)
    .join('|')
  for (const candidate of ['sessions', 'agents']) {
    try {
      const strict = (ctx as { get?: (n: string) => unknown }).get?.(candidate)
      probe[`strictGet:${candidate}`] = strict ? 'object' : 'undefined'
    } catch (error) {
      probe[`strictGet:${candidate}`] = `threw: ${String((error as Error)?.message ?? error).slice(0, 70)}`
    }
  }
  // 有些代际要靠 effect/fiber 才看得到服务；有就登记一条"等一会再看"的复查。
  // 注意 `injectFiredLive`（而不是任何在 apply 同步段里取的快照）才是"回调到底有没有
  // 触发"的证据：inject 回调最快也要一个微任务之后才跑，同步取的那一笔永远是 never。
  probe.hasEffect = String(typeof (ctx as { effect?: unknown }).effect === 'function')
  probe.hasFiber = String(
    typeof (ctx as { fiber?: unknown }).fiber === 'function' || (ctx as { fiber?: unknown }).fiber !== undefined,
  )

  // ── 取证（只记录现场，不改变行为）────────────────────────────────
  // 每一次猜错都要付一次"重启 Harness"的代价，所以把定根因需要的东西一次拿全：
  // 这个 cordis root 到底注册了哪些服务、我们的 fiber 挂在哪棵树上、谁调用了 apply。
  const asRecord = (value: unknown): Record<string | symbol, unknown> =>
    value && typeof value === 'object' ? (value as Record<string | symbol, unknown>) : {}
  const liveFiberChain = (): string[] => {
    const chain: string[] = []
    const seen = new Set<unknown>()
    let fiber: unknown = asRecord(ctx).fiber
    while (fiber && !seen.has(fiber) && chain.length < 12) {
      seen.add(fiber)
      const record = asRecord(fiber)
      const entryId = asRecord(record.entry).id
      // state 数字即 cordis FiberState：0 PENDING / 1 LOADING / 2 ACTIVE / 3 DISPOSED / 4 UNLOADING
      chain.push(
        `${String(record.name ?? '?')}#${String(record.uid ?? 'null')}@${String(record.state ?? '?')}${entryId ? `[${String(entryId)}]` : ''}`,
      )
      fiber = asRecord(asRecord(record.parent).fiber === record.fiber ? null : asRecord(record.parent).fiber)
    }
    return chain
  }
  const liveStore = (): string[] => {
    const store = asRecord(asRecord(ctx).reflect).store
    const names: string[] = []
    for (const key of Object.getOwnPropertySymbols(asRecord(store))) {
      const impl = asRecord(asRecord(store)[key])
      names.push(`${String(impl.name)}@${String(asRecord(impl.fiber).state ?? '?')}`)
    }
    return names
  }
  const liveIsolate = (): string[] => {
    const map = asRecord(ctx)[Symbol.for('cordis.isolate')]
    // isolate map 是 Object.create(null) 的**原型链**，每条 loader entry 自己那一层
    // 往往是空的——只数 own key 会永远得到空串，必须用 for...in 连继承的一起看。
    const names: string[] = []
    for (const key in map as object) names.push(`${key}=${String(asRecord(map)[key])}`)
    return names
  }
  const collectForensics = (prefix: string): void => {
    try {
      probe[`${prefix}store`] = liveStore().join('|').slice(0, 900)
      probe[`${prefix}isolate`] = liveIsolate().join(',').slice(0, 900)
      probe[`${prefix}props`] = Object.getOwnPropertyNames(asRecord(asRecord(asRecord(ctx).reflect).props))
        .slice(0, 160)
        .join('|')
      probe[`${prefix}fibers`] = liveFiberChain().join(' <- ').slice(0, 600)
      for (const name of SERVICE_NAMES) {
        const got = ctx.get?.(name, true)
        probe[`${prefix}get:${name}`] = got
          ? `object(${Object.keys(got as object)
              .slice(0, 5)
              .join('|')})`
          : 'undefined'
      }
    } catch (error) {
      probe[`${prefix}forensicsThrew`] = String((error as Error)?.message ?? error).slice(0, 120)
    }
  }
  collectForensics('t0:')
  probe.injectFiredLive = injectFired.join('|') || 'never'
  // 生命周期取证：`internal/status` 是 emit-mode（cordis events.d.ts:219），订阅安全。
  // 只记自己这条 fiber；进入 UNLOADING/DISPOSED 时抓一次栈，看清是谁把我们拆掉的。
  APPLY_COUNT.n += 1
  probe.applyCount = `${String(APPLY_COUNT.n)}@${clock.now()}`
  try {
    ctx.on?.('internal/status', ((fiber: unknown, oldState: unknown) => {
      if (asRecord(fiber) !== asRecord(ctx).fiber) return
      const record = asRecord(fiber)
      const state = Number(record.state ?? -1)
      const entry = asRecord(record.entry)
      const error = record._error
      const tail = `${
        error
          ? ` err=${String((error as Error)?.name ?? '')}:${String((error as Error)?.message ?? error).slice(0, 200)} @${String(
              (error as Error)?.stack ?? '',
            )
              .split('\n')
              .slice(1, 4)
              .map((line) => line.trim().replace(/^at\s+/, ''))
              .join(' <- ')}`
          : ''
      }${
        state >= 4
          ? ` stack=${String(new Error('drc-dispose').stack ?? '')
              .split('\n')
              .slice(1, 7)
              .map((line) => line.trim().replace(/^at\s+/, ''))
              .join(' <- ')
              .slice(0, 400)}`
          : ''
      }`
      states.push(
        `${clock.now()}:${String(oldState)}->${String(state)} entry=${String(entry.id ?? '?')}/disabled=${String(entry.disabled ?? '?')}${tail}`,
      )
      probe.fiberStates = states.join(' | ').slice(0, 1800)
    }) as never)
  } catch (error) {
    probe.statusWatch = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }
  probe.processShape = [
    String((process as unknown as { type?: string }).type ?? ''),
    String((process.versions as unknown as { electron?: string }).electron ?? 'no-electron'),
    String(process.argv[2] ?? '')
      .split('/')
      .pop() ?? '',
    String(process.argv[3] ?? '')
      .split('/')
      .pop() ?? '',
  ].join('|')
  // 谁调用 apply：栈里能看出是 cordis-plugin-loader 还是别的包装层。
  probe.applyStack = String(new Error('drc-probe').stack ?? '')
    .split('\n')
    .slice(1, 9)
    .map((line) => line.trim().replace(/^at\s+/, ''))
    .join(' <- ')
    .slice(0, 900)
  try {
    const loader = ctx.get?.('loader', true) as { entries?: () => Iterable<unknown> } | undefined
    if (typeof loader?.entries === 'function') {
      const rows: string[] = []
      for (const entry of loader.entries()) {
        const options = asRecord(asRecord(entry).options)
        rows.push(`${String(options.id ?? '?')}=${String(options.name ?? '?')}`)
        if (rows.length >= 300) break
      }
      probe.loaderRows = rows.join(',').slice(0, 2600)
    } else {
      probe.loaderRows = 'no-loader-service'
    }
  } catch (error) {
    probe.loaderRows = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }
  // 服务可能晚到：8s / 25s / 60s 各复查一次，把"根本没提供"和"提供得晚"分开。
  for (const delayMs of [8_000, 25_000, 60_000]) {
    try {
      oneShot.schedule(() => {
        probe.injectFiredLive = injectFired.join('|') || 'never'
        probe.injectFired = probe.injectFiredLive
        collectForensics(`t${delayMs}:`)
        probe.injectChildren = injectChildren
          .map(([childName, child]) => {
            const record = asRecord(child)
            const store = asRecord(record.store)
            return `${childName}@${String(record.state ?? '?')}/uid${String(record.uid ?? 'null')}${store ? `[${Object.keys(store).join('|')}]` : ''}`
          })
          .join(' ')
        probe.fiberStates = states.join(' | ').slice(0, 1800)
        // 兜底：inject 子 fiber 若因任何原因没被唤醒，直接查 store——`ctx.get` 不要求
        // inject，真机取证显示它在同一个 ctx 上一直是拿得到的。
        for (const name of SERVICE_NAMES) {
          if (collected[name]) {
            // 已经收下了，但"从哪条路收的"那一笔可能没写进去（accept 里的取证写入是尽力而为）。
            if (!String(probe[name] ?? '').startsWith('via')) probe[name] = `via held(${keysOf(collected[name])})`
            continue
          }
          try {
            accept(name, ctx.get?.(name, true), ctx, 'via get@poll')
          } catch {
            /* 还是没有这个服务 */
          }
        }
        tryStart()
        status.write({ ...state(), carrier: startedCarrier || 'none', probe })
      }, delayMs)
    } catch {
      /* 时钟不可用就少一次复查，不影响主流程 */
    }
  }
  tryStart()
  if (!runtime && config.mockBridge) {
    decided = true
    // mock 载体只为开发与冒烟存在：它的会话 id 一律 `ses_mock` 前缀，
    // 真链路测试里有专门一条断言"看到 ses_mock 就判失败"。
    import('./platform/mock-kernel.js')
      .then(({ createMockKernel }) => start(createMockKernel({ log, clock })))
      .catch(() => {})
  }
  if (!runtime) {
    status.write({ ...state(), carrier: 'none', reason: 'no-carrier', probe })
    log('no kernel carrier available', { hint: '需要 sessions 服务，或把 mockBridge 打开做开发' })
  }

  // ── 配对入口：状态栏那颗 pill 的四条路由 ────────────────────────────
  //
  // **配对唯一入口就是这四条路由**（`/drc` 命令 2026-10-03 整个删掉了）。
  // 主链路先成立：这一半起不来时，上面接好的那些一行都不许被回滚。
  //
  // 整段再包一层 try 不是冗余：`startPill` 内部已经层层兜住，但"层层兜住"是设计不是证明。
  // 它一旦抛出，宿主会把我们这条 fiber 标 FAILED 并 dispose 掉那几个 inject 子 fiber——
  // 那就等于用一个界面功能砸了配对链路（真机取证见 `apply()` 里那条纪律）。
  try {
    pillRoutes = startPill(ctx, {
      enabled: config.pill.enabled,
      // 四条路由要的四件事：幂等发码、只读看当前码、读连接状态、退出配对。
      ensureFresh: () => ensureFreshPairing(),
      current: () => currentPairing(),
      status: () => pillStatus(),
      unpair: () => unpairAll(),
      log,
    })
  } catch (error) {
    pillRoutes = undefined
    log('pill start threw（配对链路不受影响）', {
      message: String((error as Error)?.message ?? error).slice(0, 200),
    })
  }
  // **配对入口没了必须说得出为什么**：`/drc` 命令与终端文本码都在 2026-10-03 删掉了，
  // "这台主机配不了对"如果没有一条可查的记录，表现就是静默失败。那条 `warn:pill` 由
  // `state()` 每次快照现判（理由见那里），原因本身落在同一个快照的 `pill` 探针里——
  // 通常就在软探测那一步（宿主没 `webServer`，或者路由名被占）。

  return {
    config,
    state,
    createPairing,
    stop(): void {
      // 复查定时器要先撤：停机之后它们再去写 status.json，写的是已经过期的取证。
      oneShot.cancelAll()
      // pill 那四条路由也要一起收：它是不在主链路上的旁路，所以单独一句。
      pillRoutes?.stop()
      status.stop()
      // **停机时补一次落盘**：正常关机是唯一能保证"3 秒 tick 之前那几秒的改动也写下去"的时机。
      // 只在有脏数据时写（`save` 内部也会因空文件路径直接返回）。
      if (pairStoreFile && relay && pairStore.hasPendingChanges) {
        pairStore.save(relay.conversations.snapshot(), clock.now())
      }
      runtime?.stop()
      relay?.stop()
      sleep.stop()
    },
  }
}

export { DEFAULT_CONFIG }
export { readConfig, validateConfig } from './shell/config.js'
export type { KernelPort, Clock } from './ports/index.js'
