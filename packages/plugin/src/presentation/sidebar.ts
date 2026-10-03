/**
 * sidebar — 右栏自动弹码那一半的接线（宿主侧）。
 *
 * 它做三件事：按节拍看一版"当前配对码"、把变了的那一版渲染成 PNG 字节、把一条同域只读
 * 路由挂到 `webServer` 上（图由这条路由按请求落盘）。判断在 `presenter.ts`，地址编码在
 * `address.ts`，安全姿态与回答形状在 `route.ts`。
 *
 * **为什么这段代码原来住在另一个包里**：它需要 `webServer` 服务，而主插件刻意不写任何
 * `inject:` 闸门（写闸门会让"某一代宿主缺某个服务"时整行不激活）。分成两包之后，宿主没有
 * `webServer` 时只有那一行不激活，配对/中继一行都不受影响。
 *
 * 2026-10-03 折进主插件之后，**这个隔离必须由代码自己提供**，三条规矩就是它的替代品：
 *
 * 1. `startSidebarQr` 只软探测 `webServer` 一个服务；拿不到就整个 sidebar 不起
 *    （不挂路由、不起节拍），`probe.sidebar.webServer` 里留下"为什么没起"。
 * 2. 它抛出的任何东西都不许到达调用方。调用方（`applyInner`）外面还有一层 try，
 *    但**两都要有**：主插件的 fiber 一旦 FAILED，宿主会把它的 inject 子 fiber 一起
 *    dispose，配对/中继那半条链路会跟着没（真机取证见 `src/index.ts` 的 apply() 注释）。
 * 3. 不再软探测 `dshRemoteControl`：配对码与工作区解析现在直接取主插件内部的
 *    `describeActivePairing()` / `kernel.sessionWorkspace()`。**同一个包里绕一圈服务发现
 *    只会多出两份会漂移的形状**——原来那一圈是为了跨包，跨包的形状还得兼容旧主插件。
 *
 * 与拆分版同款的纪律：`apply` 绝向外抛、inject 回调参数是**作用域化上下文**不是服务实例、
 * 每个候选都"先 get 再直接读属性"两条路各自包 try。
 */
import path from 'node:path'
import { registerPairActionRoutes, type LivePairing } from './pair-actions.js'
import { liveDeps, PairingPresenter, writePrivatePng, type ActivePairing, type PairingArtifact } from './presenter.js'
import { registerPairingRoute, type PairingRouteTarget, type WebServerLike } from './route.js'

/** 只用到 ctx 的几个成员，所以不硬依赖 `@deepseek-ai/cordis` 的类型。 */
interface LooseContext {
  get?<T>(name: string, optional: true): T | undefined
  inject?(names: string[], callback: (scoped: unknown) => void): unknown
}

export interface SidebarQrSettings {
  /** 关掉就只留"什么都不做"这一种行为（路由不会注册）。 */
  enabled: boolean
  /**
   * 二维码 PNG 的**兜底**落盘路径：正常情况下图落在当前会话的工作区
   * （`<workspace>/.dsh/sidebar-qr.png`，2026-10-02 用户拍板：放工作区，不放 home），
   * 只有"会话 → 工作区"解析不出来时才用这里（默认 `~/.dsh/sidebar-qr.png`）。
   */
  imageFile: string
  /** 宿主侧刷新节拍：多久看一眼"当前配对码是不是换了"。 */
  refreshMs: number
}

export interface SidebarDeps {
  config: SidebarQrSettings
  /** 当前正在显示的那张码；没有就是 null。形状与 `describeActivePairing()` 一致。 */
  pairing(): ActivePairing | null
  /** 某条会话的工作区目录；解析不出来是 undefined（图退回兜底落点）。 */
  workspaceOf(sessionId: string): string | undefined
  log(message: string, fields?: Record<string, string | number | boolean | undefined>): void
  /**
   * 幂等地保证"有一张能用的码"（状态栏 pill 点一下走这条）。
   * 中继不在线 / runtime 没起来时返回 null。
   */
  ensureFresh(): LivePairing | null
  /** 只读地看当前有没有仍然有效的码（`pairing.png` 用）。 */
  current(): LivePairing | null
  /** 把码渲染成 PNG 字节（`pairing.png` 用）。 */
  renderPng(qr: string): Promise<Buffer>
}

export interface SidebarHandle {
  stop(): void
  /** 排错入口：为什么没起 / 服务是从哪条路拿到的 / 路由挂上没。 */
  readonly probe: Record<string, string>
  /**
   * 右栏与状态栏那两条路由**是否真的挂上了**。
   * 主插件用它决定 `/drc pair` 要不要作为兜底注册回来：没 webServer 的宿主上
   * 点不了 pill，命令行是唯一退路。
   */
  readonly available: boolean
}

/** 起 sidebar。返回句柄；`stop()` 幂等。 */
export function startSidebarQr(ctx: LooseContext, deps: SidebarDeps): SidebarHandle {
  const { config, log } = deps
  const probe: Record<string, string> = {}
  const presenter = new PairingPresenter(liveDeps(log))
  let web: WebServerLike | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let unregister: (() => void) | undefined
  let unregisterActions: (() => void) | undefined
  let started = false
  let stopped = false
  /** 已经落过盘的那一版（epoch + 落点）：轮询是 2 秒一次，不记住就会反复写同一个文件。 */
  let written: { epoch: string; file: string } | null = null

  const targetFor = (sessionId: string): PairingRouteTarget => {
    // 会话 → 工作区这点平台知识只在主插件那边有，这里问它要，**绝不自己猜一个路径**：
    // 猜错的表现是"卡片上印 A 地、右栏读 B 地"，而两边都写着成功。
    let workspace: string | undefined
    try {
      workspace = deps.workspaceOf(sessionId)
    } catch (error) {
      // 内核还没起来时那句会抛。跨模块调用任何一步抛出都当"解析不出来"，
      // 不能让一次请求把宿主带崩——兜底位仍是同一个 config.imageFile。
      log('会话工作区解析失败', { message: String((error as Error)?.message ?? error).slice(0, 160) })
      workspace = undefined
    }
    const file = workspace ? path.join(workspace, '.dsh', 'sidebar-qr.png') : config.imageFile
    return {
      file,
      persist: (): boolean => {
        const artifact: PairingArtifact | null = presenter.current()
        if (!artifact) return false
        if (written && written.epoch === artifact.epoch && written.file === file) return true
        if (!writePrivatePng(file, artifact.buffer)) {
          log('二维码落盘失败', { file })
          return false
        }
        written = { epoch: artifact.epoch, file }
        return true
      },
    }
  }

  /** 看一眼当前配对码。任何一步抛出都只记一行，节拍继续。 */
  const tick = async (): Promise<void> => {
    let pairing: ActivePairing | null = null
    try {
      const raw = deps.pairing()
      pairing = raw && typeof raw === 'object' ? raw : null
    } catch (error) {
      log('read pairing state failed', { message: String((error as Error)?.message ?? error).slice(0, 160) })
      return
    }
    try {
      await presenter.observe(pairing)
    } catch (error) {
      // observe 自己已经吞了渲染/落盘异常；这里只兜"别的意外"。
      log('observe failed', { message: String((error as Error)?.message ?? error).slice(0, 160) })
    }
  }

  /** 拿到 webServer 才能起：图落了盘也没人知道地址的话，起节拍只是白写磁盘。 */
  const tryStart = (): void => {
    if (started || stopped || !web) return
    started = true
    try {
      unregister = registerPairingRoute(web, {
        snapshot: () => presenter.snapshot(),
        target: targetFor,
      })
      probe.route = 'registered'
    } catch (error) {
      probe.route = `register threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
      log('route registration failed', { message: String((error as Error)?.message ?? error).slice(0, 200) })
      started = false
      return
    }
    // 状态栏那两条（点一下发码 + 弹窗的图）**单独 try**：它们挂了不该把右栏自动弹码一起拖死，
    // 那是 1.1.0 已经在跑的既有行为。但 `available` 取"两条都上"——pill 点不开就是没成，
    // 主插件据此把 `/drc pair` 作为兜底注册回来。
    try {
      unregisterActions = registerPairActionRoutes(web, {
        ensureFresh: () => deps.ensureFresh(),
        current: () => deps.current(),
        renderPng: (qr: string) => deps.renderPng(qr),
        log,
      })
      probe.actions = 'registered'
    } catch (error) {
      probe.actions = `register threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
      log('状态栏路由注册失败（右栏自动弹码不受影响）', {
        message: String((error as Error)?.message ?? error).slice(0, 200),
      })
    }
    timer = setInterval(() => void tick(), config.refreshMs)
    // 不 unref 的话，任何一次性跑法（headless/CLI/e2e）都会被这个节拍钉住不退出。
    timer.unref?.()
    void tick()
    log('sidebar started', { fallbackImageFile: config.imageFile, refreshMs: config.refreshMs })
  }

  /** 一个候选来源里取出 `name`：先按作用域上下文读，读不到再按"直接就是服务"读。 */
  const pickFrom = (source: unknown, name: string): unknown => {
    if (!source || typeof source !== 'object') return undefined
    const asContext = source as { get?: (n: string, optional: true) => unknown }
    if (typeof asContext.get === 'function') {
      try {
        const got = asContext.get(name, true)
        if (got) return got
      } catch {
        /* 这个候选没有该服务 */
      }
    }
    try {
      return (source as Record<string, unknown>)[name]
    } catch {
      return undefined
    }
  }

  /** 收下这个服务：形状不对就不收（收下不合法的对象比不收更糟）。 */
  const acceptWebServer = (value: unknown, via: string): boolean => {
    if (!value || typeof value !== 'object') return false
    if (typeof (value as WebServerLike).register !== 'function') {
      probe.webServer = 'object without register()'
      return false
    }
    web = value as WebServerLike
    probe.webServer = via
    tryStart()
    return true
  }

  if (!config.enabled) {
    probe.sidebar = 'disabled'
  } else {
    try {
      const found = ctx.get?.('webServer', true)
      if (found) acceptWebServer(found, 'via get')
      else probe.webServer = 'none'
    } catch (error) {
      // 真 cordis 的 ctx 是 Proxy：读一个没声明的服务名是**抛错**，`?.` 挡不住。
      probe.webServer = `get threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
    }
    try {
      ctx.inject?.(['webServer'], ((...args: unknown[]) => {
        try {
          let value: unknown
          for (const candidate of [args[0], ...args, ctx]) {
            value = pickFrom(candidate, 'webServer')
            if (value) break
          }
          if (acceptWebServer(value, 'via inject')) return
          probe.webServer = `${probe.webServer ?? 'none'} (inject fired, empty)`
        } catch (error) {
          probe['injectThrew:webServer'] = String((error as Error)?.message ?? error).slice(0, 160)
        }
      }) as never)
    } catch (error) {
      probe['injectThrew:webServer'] = String((error as Error)?.message ?? error).slice(0, 160)
    }
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    for (const off of [() => unregister?.(), () => unregisterActions?.()]) {
      try {
        off()
      } catch {
        /* 宿主可能已经先一步把 webServer 拆了 */
      }
    }
    unregister = undefined
    unregisterActions = undefined
    if (started) log('sidebar stopped')
  }

  return {
    stop,
    probe,
    // pill 点得开 = 发码与图片两条都挂上了；右栏那条单独挂上不算"能点一下配对"。
    get available() {
      return started && probe.route === 'registered' && probe.actions === 'registered'
    },
  }
}
