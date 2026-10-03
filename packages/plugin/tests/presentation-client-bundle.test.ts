/**
 * client-bundle.test — 在 vm 里真跑一遍**打出来的** `dist/bundle/client.cjs`。
 *
 * 为什么要在产物上测、而不是 import 源码：这一半真正容易错的地方是**外壳**
 * （`window.__ModuleLoader__.load({id, factory})` 的 id/闭合/导出形状）和
 * "装载之后到底注册了什么"。外壳写错的表现是整页 web boot 失败——真机上要重启应用才看得见，
 * 所以这里用 Node 的 vm 造一个最小的浏览器环境，把产物原样执行：
 *
 *   1. 外壳注册成功、id 与包名一致、导出的是 `{name, inject, apply}`；
 *   2. 状态栏那颗 pill：向装载器拿 react、软探测 `slots`、往 `conversation.composer.dock`
 *      注册、点击发码、把图与 6 位码画进面板；
 *   3. **任何一条依赖拿不到时只降级成"没有 pill"**：apply 绝不外抛（那会整页起不来），
 *      并且留下一行 warn 说明缺的是哪一样；
 *   4. 发码请求必须带宿主那道守卫要的自定义头（两半的分叉在这里对上）。
 *
 * 2026-10-03 这一半原来还有一条"每 2 秒轮只读路由、把当前码推进右栏"的轮询（连同
 * `inject: ['sidebarRight']`）。右栏方案删除后那些用例一起删了——留下的每条都指着 pill。
 *
 * 这里不测"那颗 pill 好不好看"、也不测"宿主的槽位会不会真的把它画出来"——那是真机验收
 * （配方见伞仓 `docs/HOST-SIDE.md` §6.1）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import {
  PAIR_IMAGE_ROUTE,
  PAIR_MARKER_HEADER,
  PAIR_MARKER_VALUE,
  PAIR_NEW_ROUTE,
  PAIR_STATUS_ROUTE,
} from '../src/presentation/pill-routes.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(here, '..', 'bundle', 'client.cjs')

interface ClientModule {
  name: string
  inject: string[]
  apply(ctx: unknown): void
}

interface LoadOptions {
  hidden?: boolean
  /** 装载器能不能给出 react。缺省给不出——"最坏只少一颗 pill"那条。 */
  react?: unknown
  /** 软探测能不能拿到 `slots` 这个服务。 */
  slots?: boolean
  /**
   * `slots` 只在 `flushInject()` 之后才"到"——真机就是这个形状：浏览器面 `inject` 声明是空的，
   * 于是 `apply()` 在 web boot 那一刻就跑，而 `slots` 服务还在后面。2026-10-03 删掉右栏之后
   * 那颗 pill 在这台机器上**整颗不出现**，就是被这个形状打中的（旧的假上下文只给同步的 `get`，
   * 所以 262 项全绿也没抓到它）。
   */
  lateSlots?: boolean
  /** `ctx.get` 本身抛不抛：真 cordis 的 Proxy 读一个没声明的服务名就是**抛**。 */
  getThrows?: boolean
  /** `/status` 那条的回答。 */
  status?: Record<string, unknown>
  /** `POST /pairing/new` 的回答。 */
  newAnswer?: Record<string, unknown>
  /** `POST /pairing/new` 直接抛（网络断了 / 路由没挂上）。 */
  newThrows?: boolean
}

interface Harness {
  module: ClientModule
  /** fetch 收到的 URL。 */
  requests: string[]
  /** 被记下来的 console.error。 */
  errors: string[]
  /** 被记下来的 console.warn——pill 那一路的降级说的是 warn，不是 error。 */
  warnings: string[]
  /** 装载到现在创建的节拍个数（pill 挂了才有状态轮询）。 */
  timerCount(): number
  fire(index: number): void
  fireAndFlush(index: number): Promise<void>
  /** pill 注册进槽位时 `register` 收到的入参。 */
  slotRegisters(): Array<{ definition: Record<string, unknown>; component?: () => unknown }>
  /** 只有 `lateSlots` 用：把宿主欠我们的那次 `inject(['slots'], cb)` 回调补上。 */
  flushInject(): void
  /** 把那颗 pill 的挂载点交给它的 ref（= 宿主把它挂进 DOM）。 */
  mountPill(): FakeElement
  /** 同一个 ref 再交一次 null（= 宿主把那颗 pill 卸掉）。 */
  unmountPill(): void
  /** 假 document：点外面与 Escape 这两条要往它身上发事件。 */
  fakeDocument(): FakeDocument
}

// ── 够用的假 DOM ────────────────────────────────────────────────────
// 只实现那颗 pill 真正用到的成员。写全了反而糟：测的就变成"我自己那套假 DOM 的行为"。
class FakeElement {
  children: FakeElement[] = []
  parent: FakeElement | undefined
  attributes = new Map<string, string>()
  listeners = new Map<string, Array<(event: unknown) => void>>()
  textContent = ''
  className = ''
  src = ''
  type = ''
  tabIndex = 0
  style: Record<string, string> = {}
  focused = 0

  constructor(
    readonly tag: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  appendChild(child: FakeElement): FakeElement {
    child.parent = this
    this.children.push(child)
    return child
  }

  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = undefined
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parent = undefined
    this.children = []
    for (const node of nodes) this.appendChild(node)
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name)
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(
      type,
      list.filter((candidate) => candidate !== handler),
    )
  }

  contains(other: unknown): boolean {
    let node: FakeElement | undefined = other as FakeElement
    while (node) {
      if (node === this) return true
      node = node.parent
    }
    return false
  }

  focus(): void {
    this.focused += 1
  }

  /** 触发某类事件；没有监听者就直接红——别让"没接上"伪装成"行为正确"。 */
  emit(type: string, event: unknown = {}): void {
    const list = this.listeners.get(type) ?? []
    assert.ok(list.length > 0, `<${this.tag}> 上没有注册 ${type} 监听器`)
    for (const handler of [...list]) handler(event)
  }

  /** 按 class 找回面板里那一句（比遍历树好读），只在本节点的后代里找。 */
  find(className: string): FakeElement | undefined {
    for (const child of this.children) {
      if (child.className === className) return child
      const nested = child.find(className)
      if (nested) return nested
    }
    return undefined
  }

  allText(): string {
    return [this.textContent, ...this.children.map((child) => child.allText())].join(' ')
  }
}

class FakeDocument {
  head = new FakeElement('head', this)
  private documentListeners = new Map<string, Array<(event: unknown) => void>>()

  constructor(readonly visibilityState: string) {}

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this)
  }

  /** 样式探针：永远返回"没注入过"，于是那颗 pill 会往 head 里补一句 style。 */
  querySelector(): null {
    return null
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.documentListeners.get(type) ?? []
    list.push(handler)
    this.documentListeners.set(type, list)
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.documentListeners.get(type) ?? []
    this.documentListeners.set(
      type,
      list.filter((candidate) => candidate !== handler),
    )
  }

  emit(type: string, event: unknown): void {
    for (const handler of [...(this.documentListeners.get(type) ?? [])]) handler(event)
  }

  listenerCount(type: string): number {
    return (this.documentListeners.get(type) ?? []).length
  }
}

/** 把跨 realm 的 promise 链推完（pill 那一轮有 fetch / json / 写 DOM 好几段 await）。 */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** 一颗够用的假 react：这一半只用 createElement。 */
const FAKE_REACT = {
  createElement: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
}

function load(options: LoadOptions = {}): Harness {
  const requests: string[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const timers: Array<() => void> = []
  const slotRegisters: Array<{ definition: Record<string, unknown>; component?: () => unknown }> = []
  const doc = new FakeDocument(options.hidden ? 'hidden' : 'visible')
  let spec: { id?: string; factory?: (require: unknown) => ClientModule } | undefined

  const sandbox: Record<string, unknown> = {
    console: {
      error: (message: unknown) => errors.push(String(message)),
      warn: (message: unknown) => warnings.push(String(message)),
      log: () => {},
    },
    document: doc,
    setInterval: (callback: () => void) => {
      timers.push(callback)
      return timers.length
    },
    clearInterval: () => {},
    fetch: async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      requests.push(url)
      const method = init?.method ?? 'GET'
      if (url.startsWith(PAIR_NEW_ROUTE)) {
        assert.equal(method, 'POST', '发码那条只接受 POST')
        // 那个自定义头是这条写路由唯一的 CSRF 判据（桌面宿主会删 `origin`，真机 2026-10-03 量过）。
        // 浏览器面**忘了带**、或宿主侧改了头名，表现都是"点一下永远 403"，所以两边在这里对上。
        assert.equal(
          init?.headers?.[PAIR_MARKER_HEADER],
          PAIR_MARKER_VALUE,
          `发码请求必须带 ${PAIR_MARKER_HEADER}: ${PAIR_MARKER_VALUE}，实际 init=${JSON.stringify(init)}`,
        )
        if (options.newThrows) throw new Error('发码那条断了')
        return {
          ok: true,
          status: 200,
          json: async () => options.newAnswer ?? { state: 'ready', epoch: 'e1', token: '482913', expiresInMs: 60_000 },
        }
      }
      if (url.startsWith(PAIR_STATUS_ROUTE)) {
        return {
          ok: true,
          status: 200,
          json: async () => options.status ?? { relay: 'online', paired: 0, hasCode: false },
        }
      }
      assert.equal(method, 'GET', `${url} 不该收到 ${method}`)
      return { ok: true, status: 200, json: async () => ({}) }
    },
    window: {
      __ModuleLoader__: {
        load: (loaded: unknown) => {
          spec = loaded as never
        },
      },
    },
  }
  runInContext(readFileSync(CLIENT, 'utf8'), createContext(sandbox), { filename: CLIENT })
  assert.ok(spec, '产物必须在装载时调用 __ModuleLoader__.load')
  assert.equal(typeof spec?.factory, 'function')
  const module = spec!.factory!((id: string): never => {
    if (id === 'react' && options.react !== undefined) return options.react as never
    throw new Error(`client 产物不该 require ${id}（除了向装载器拿 react）`)
  })

  /** slots 服务的形状照宿主那个用法：`inject(槽位名, cb)`，cb 里面调 `register(定义, 组件)`。 */
  const slots = options.slots
    ? {
        inject: (_slotName: string, callback: () => void) => {
          callback()
        },
        register: (definition: Record<string, unknown>, component: () => unknown) => {
          slotRegisters.push({ definition, component })
          return () => undefined
        },
      }
    : undefined

  // 真 cordis 的 `ctx.inject(names, cb)`：cb 可能在 apply 返回之后很久才触发，
  // 参数是一个只能读那些服务名的作用域上下文。
  const pendingInject: Array<(scoped: unknown) => void> = []
  const scopedContext = {
    get: (name: string) => (name === 'slots' ? slots : undefined),
  }
  // 模块声明了 `inject: ['slots']`，所以真宿主上 `ctx.slots` 是直接可读的那一条
  // （宿主自带模板同款）。`lateSlots` 时它在补注入之前必须读不到。
  let delivered = !options.lateSlots
  const ctx: Record<string, unknown> = {
    get: (name: string) => {
      if (options.getThrows) throw new Error(`cannot get property "${name}" without inject`)
      if (!delivered) return undefined
      return name === 'slots' ? slots : undefined
    },
    inject: (names: string[], callback: (scoped: unknown) => void) => {
      if (options.lateSlots && names.includes('slots')) pendingInject.push(callback)
      return () => undefined
    },
    effect: (execute: () => unknown) => {
      execute()
    },
  }
  Object.defineProperty(ctx, 'slots', {
    get() {
      if (options.getThrows) throw new Error('cannot get property "slots" without inject')
      return delivered ? slots : undefined
    },
  })
  module.apply(ctx)

  /**
   * 那颗 pill 的 ref 回调：mount / unmount 都走它，与宿主真正做的事一致。
   * `attach` 是 `mountPill` 里那一份闭包，两次 `component()` 拿到的是**同一个函数**——
   * 若它每次渲染都换新身份，React 会反复拆建那块 DOM，这里也就测不出真行为。
   */
  const pillRef = (): ((node: unknown) => void) => {
    assert.ok(slotRegisters.length > 0, 'pill 必须先注册进槽位')
    const created = slotRegisters[0]!.component!() as { props?: { ref?: (node: unknown) => void } }
    const ref = created?.props?.ref
    assert.equal(typeof ref, 'function', '挂载点必须带 ref，否则那颗 pill 永远进不了 DOM')
    return ref!
  }

  return {
    module,
    requests,
    errors,
    warnings,
    timerCount: () => timers.length,
    fire: (index: number) => {
      assert.ok(timers[index], `第 ${index} 个节拍不存在（一共 ${timers.length} 个）`)
      timers[index]!()
    },
    async fireAndFlush(index: number) {
      timers[index]?.()
      await flush()
    },
    slotRegisters: () => slotRegisters,
    flushInject(): void {
      delivered = true
      for (const callback of pendingInject.splice(0)) callback(scopedContext)
    },
    mountPill(): FakeElement {
      const element = doc.createElement('span')
      pillRef()(element)
      return element
    },
    unmountPill(): void {
      pillRef()(null)
    },
    fakeDocument: () => doc,
  }
}

test('外壳注册的形状：id 与包名一致，导出 name/inject/apply；inject 声明 slots（宿主模板同款）', () => {
  const harness = load()
  assert.equal(harness.module.name, 'dsh-remote-control')
  // 展开一次：vm 那个 realm 的数组与本 realm 的 Array.prototype 不是同一个，
  // deepStrictEqual 会因原型不同而红（与代码对错无关）。
  assert.deepEqual(
    [...harness.module.inject],
    ['slots'],
    '这条声明决定激活时机：空列表时 apply 跑在槽位服务之前，那颗 pill 整颗不出现（2026-10-03 真机）',
  )
  assert.equal(typeof harness.module.apply, 'function')
  assert.equal(harness.errors.length, 0)
})

test('拿不到 react：一颗 pill 都不注册，apply 不外抛，且留下一行说得清的 warn', async () => {
  const harness = load()
  await flush()
  assert.equal(harness.slotRegisters().length, 0, '没有 react 就不该去碰槽位')
  assert.equal(harness.errors.length, 0, '这是降级，不是故障')
  assert.equal(harness.timerCount(), 0, 'pill 没起来就不该留节拍')
  assert.ok(
    harness.warnings.some((line) => line.includes('react')),
    `降级要留下能查的一句：${harness.warnings.join(' | ')}`,
  )
})

test('探不到 slots（这代宿主没这个服务）：同样只降级，并指名是没探到 slots', async () => {
  const harness = load({ react: FAKE_REACT })
  await flush()
  assert.equal(harness.slotRegisters().length, 0)
  assert.equal(harness.errors.length, 0)
  assert.ok(
    harness.warnings.some((line) => line.includes('slots')),
    `要指名是没探到 slots：${harness.warnings.join(' | ')}`,
  )
})

test('slots 晚到（真机形状：apply 时拿不到，注入回调之后才有）：pill 必须补挂上，而不是永久没有', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, lateSlots: true })
  await flush()
  assert.equal(harness.slotRegisters().length, 0, 'apply 那一刻还没拿到 slots，不该已经注册')
  harness.flushInject()
  await flush()
  assert.equal(
    harness.slotRegisters().length,
    1,
    '晚到的 slots 必须把那颗 pill 补挂上：浏览器面不声明任何 inject，于是 apply 早于服务到位是常态——' +
      '2026-10-03 删掉右栏之后，这台机器上那颗 pill 整颗不出现就是这个形状打的',
  )
  const root = harness.mountPill()
  await flush()
  assert.ok(root.find('drc-pill'), `补挂之后按钮要建得出来：${root.allText()}`)
})

test('软探测不许抛出 apply：ctx.get 抛（真 cordis 的 Proxy 就是这个形状）时只降级', async () => {
  const harness = load({ react: FAKE_REACT, getThrows: true })
  await flush()
  assert.equal(harness.errors.length, 0, `抛出 apply 就是整页起不来：${harness.errors.join(' | ')}`)
  assert.equal(harness.slotRegisters().length, 0)
})

test('注册进 conversation.composer.dock：槽位名、id、order 都要对', async () => {
  const harness = load({ react: FAKE_REACT, slots: true })
  await flush()
  const entry = harness.slotRegisters()[0]
  assert.ok(entry, '必须注册进槽位')
  assert.equal(entry!.definition.name, 'conversation.composer.dock')
  assert.equal(entry!.definition.id, 'dsh-remote-control')
  assert.equal(entry!.definition.order, 20, '排在宿主自带的 stats(0) 与 provider-usage(10) 之后，不挤掉它们')
})

test('挂载之后抬头写的是状态路由给的那句', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, status: { relay: 'online', paired: 2, hasCode: false } })
  const root = harness.mountPill()
  await flush()
  const pill = root.find('drc-pill')
  assert.ok(pill, `那颗按钮必须建出来：${root.allText()}`)
  // 抬头那句写在按钮里那个 `drc-label` 上，取它而不是按钮：假 DOM 的 textContent 不聚合后代。
  assert.equal(root.find('drc-label')!.textContent, '已连 2 台')
  assert.equal(pill!.getAttribute('aria-label'), '已连 2 台')
  assert.equal(root.find('drc-dot')!.getAttribute('data-tone'), 'on', '灯的颜色由 tone 决定')
})

test('中继没连上时说的是"远程未连接"，不许假装有得配', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, status: { relay: 'offline', paired: 0, hasCode: false } })
  const root = harness.mountPill()
  await flush()
  assert.equal(root.find('drc-label')!.textContent, '远程未连接')
  assert.equal(root.find('drc-dot')!.getAttribute('data-tone'), 'off')
})

test('runtime 还没起来时说"远程未启动"：idle 与 offline 是两件事', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, status: { relay: 'idle', paired: 0, hasCode: false } })
  const root = harness.mountPill()
  await flush()
  assert.equal(root.find('drc-label')!.textContent, '远程未启动')
})

test('页面不可见时不轮状态（Electron 里窗口在后台是常态）', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, hidden: true })
  harness.mountPill()
  await flush()
  assert.equal(
    harness.requests.filter((url) => url.startsWith(PAIR_STATUS_ROUTE)).length,
    0,
    `不可见时一次都不该发：${harness.requests.join(' | ')}`,
  )
})

test('点击：POST 发码那条，再把图与 6 位码画进面板；epoch 进图片 URL', async () => {
  const harness = load({ react: FAKE_REACT, slots: true })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()

  assert.ok(harness.requests.includes(PAIR_NEW_ROUTE), `必须真的打过发码那条：${harness.requests.join(' | ')}`)
  assert.ok(root.find('drc-panel'), '面板要弹出来')
  assert.equal(root.find('drc-qr')!.src, `${PAIR_IMAGE_ROUTE}?e=e1`, '图片地址要带上这一版码的 epoch')
  assert.equal(root.find('drc-code')!.textContent, '482913', '6 位码必须与 QR 同时在屏上——手输是唯一退路')
  assert.match(root.find('drc-note')!.textContent, /手输这 6 位数字/)
  assert.equal(root.find('drc-pill')!.getAttribute('aria-expanded'), 'true')
})

test('200 + state:"unavailable" 不是成功：面板要说明白，不许弹一张白框', async () => {
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    newAnswer: { state: 'unavailable', reason: 'relay-offline' },
  })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()
  assert.equal(root.find('drc-qr'), undefined, '没有码就不该有那张图')
  assert.match(root.find('drc-note')!.textContent, /中继还没连上/)
  assert.ok(root.find('drc-btn'), '要给一句"再试一次"，别让人以为插件坏了')
})

test('守卫拒了就把是哪一道印在屏幕上：那是浏览器面唯一的现场', async () => {
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    newAnswer: { error: 'request-not-trusted', guard: 'pair-marker-missing' },
  })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()
  assert.match(root.find('drc-note')!.textContent, /request-not-trusted/, '要把宿主说的原因带出来')
  assert.match(root.find('drc-note')!.textContent, /pair-marker-missing/, '更要带出是哪一道守卫')
})

test('发码那条直接断（fetch 抛）：面板显示失败原因，不抛出、不白屏', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, newThrows: true })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()
  assert.match(root.find('drc-note')!.textContent, /配对请求没成功/)
  assert.equal(harness.errors.length, 0)
})

test('点外面才关：落在面板里的 pointerdown 不许收起，落在外面与 Escape 都要收', async () => {
  const harness = load({ react: FAKE_REACT, slots: true })
  const root = harness.mountPill()
  await flush()
  const button = root.find('drc-pill')!
  button.emit('click')
  await flush()
  assert.ok(root.find('drc-panel'), '先确认面板开着')

  const panel = root.find('drc-panel')!
  harness.fakeDocument().emit('pointerdown', { target: panel })
  assert.ok(root.find('drc-panel'), '落在面板里的 pointerdown 关掉它，用户就是"复制码时弹窗消失"')

  harness.fakeDocument().emit('pointerdown', { target: harness.fakeDocument().createElement('div') })
  assert.equal(root.find('drc-panel'), undefined, '点外面要关')

  button.emit('click')
  await flush()
  assert.ok(root.find('drc-panel'), '再点要能开')
  harness.fakeDocument().emit('keydown', { key: 'Escape' })
  assert.equal(root.find('drc-panel'), undefined, 'Escape 要关')
})

test('码的寿命走完会自动再要一张（幂等入口此刻才会真的发新的）', async () => {
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    newAnswer: { state: 'ready', epoch: 'e1', token: '482913', expiresInMs: 1_000 },
  })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()
  assert.equal(harness.requests.filter((url) => url === PAIR_NEW_ROUTE).length, 1)
  // 节拍次序：0 = pill 状态轮询，1 = 面板倒计时。
  assert.equal(harness.timerCount(), 2, '该有两个节拍')
  await harness.fireAndFlush(1)
  assert.equal(
    harness.requests.filter((url) => url === PAIR_NEW_ROUTE).length,
    2,
    '倒计时走光必须再去要一张，否则屏幕上留下一张废码',
  )
})

test('卸载（宿主把 pill 摘掉）之后节拍停、文档监听摘干净', async () => {
  const harness = load({ react: FAKE_REACT, slots: true })
  harness.mountPill()
  await flush()
  assert.ok(
    harness.requests.some((url) => url.startsWith(PAIR_STATUS_ROUTE)),
    '先确认状态轮询在跑',
  )
  const doc = harness.fakeDocument()
  assert.ok(doc.listenerCount('pointerdown') > 0, 'pill 必须挂上"点外面"的监听')

  harness.unmountPill()
  const after = harness.requests.length
  await harness.fireAndFlush(0)
  assert.equal(harness.requests.length, after, '卸载后不该再轮状态')
  assert.equal(doc.listenerCount('pointerdown'), 0, '文档级监听必须摘掉，否则每次重挂都多一份')
})

test('反证：产物里的路由常量与宿主侧定义逐字一致（分叉的表现是"点了没反应而日志全绿"）', () => {
  const bundle = readFileSync(CLIENT, 'utf8')
  for (const constant of [PAIR_NEW_ROUTE, PAIR_IMAGE_ROUTE, PAIR_STATUS_ROUTE, PAIR_MARKER_HEADER]) {
    assert.ok(bundle.includes(constant), `client.cjs 里缺 ${constant}`)
  }
  // 出现一条宿主侧没有的 /plugins 路径就是两边分叉了。
  const found = [...new Set([...bundle.matchAll(/\/plugins\/[a-z0-9./-]+/g)].map((match) => match[0]))].sort()
  assert.deepEqual(found, [PAIR_NEW_ROUTE, PAIR_IMAGE_ROUTE, PAIR_STATUS_ROUTE].sort())
})
