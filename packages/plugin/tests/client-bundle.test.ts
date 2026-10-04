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
 *      注册；点开是"状态 + 右上角那颗按钮"，再按一次才发码（已配对时那颗按钮是退出配对），
 *      发码后把图与 6 位码画进同一个面板；
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
  PAIR_UNPAIR_ROUTE,
} from '../src/pill/routes.js'

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
  /** `POST /unpair` 的回答。 */
  unpairAnswer?: Record<string, unknown>
  /** `POST /unpair` 直接抛。 */
  unpairThrows?: boolean
  /** 预置一份**上一版**的样式表：模拟"宿主热更了这一半、文档没重载"。 */
  staleStyle?: boolean
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
    return this.findAll(className)[0]
  }

  /** 正文那三行都是 `drc-info`：要按键取，不能只取第一行。 */
  findAll(className: string): FakeElement[] {
    const found: FakeElement[] = []
    for (const child of this.children) {
      if (child.className === className) found.push(child)
      found.push(...child.findAll(className))
    }
    return found
  }

  allText(): string {
    return [this.textContent, ...this.children.map((child) => child.allText())].join(' ')
  }
}

class FakeDocument {
  head = new FakeElement('head', this)
  private documentListeners = new Map<string, Array<(event: unknown) => void>>()
  /** `staleStyle` 用：预置的旧 `<style>`，让 `querySelector` 认得出"插过了"。 */
  seededStyle?: FakeElement

  constructor(readonly visibilityState: string) {}

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this)
  }

  /** 样式探针：默认返回"没注入过"；`seededStyle` 时返回那份**上一版**的样式表。 */
  querySelector(selector: string): FakeElement | null {
    if (this.seededStyle && selector.includes('data-plugin-css')) return this.seededStyle
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

/**
 * **未配对时点一下那颗 pill 就够了**（2026-10-04 改的）：直接进二维码页，
 * 中间那一屏"先按一颗「生成配对码」才出码"已经删掉。
 *
 * 所以这个 helper 现在只做一件事：点开 + 让那次自动发码的回答落地。
 * 它仍然必须 `await flush()`——不 flush 就是在断言"面板停在 loading 上"，
 * 那条会让所有"看 QR / 看 6 位码 / 看倒计时"的断言假绿。
 */
async function openPairing(root: FakeElement): Promise<void> {
  root.find('drc-pill')!.emit('click')
  await flush()
}

/** 一颗够用的假 react：这一半只用 createElement。 */
const FAKE_REACT = {
  createElement: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
}

/** `/status` 那条的默认回答：在线、一台都没配上。 */
const DEFAULT_STATUS = {
  relay: 'online',
  paired: 0,
  serverUrl: 'wss://relay.example.com:443/relay',
  version: '0.0.0-test',
  waiting: 0,
  waitingOldestSec: 0,
}

function load(options: LoadOptions = {}): Harness {
  const requests: string[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const timers: Array<() => void> = []
  const slotRegisters: Array<{ definition: Record<string, unknown>; component?: () => unknown }> = []
  const doc = new FakeDocument(options.hidden ? 'hidden' : 'visible')
  if (options.staleStyle) {
    const seeded = doc.createElement('style')
    seeded.setAttribute('data-plugin-css', 'dsh-remote-control/pill.css')
    seeded.textContent = '.drc-pill { color: red } /* 上一版的样式 */'
    doc.head.appendChild(seeded)
    doc.seededStyle = seeded
  }
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
          json: async () => options.status ?? DEFAULT_STATUS,
        }
      }
      if (url.startsWith(PAIR_UNPAIR_ROUTE)) {
        assert.equal(method, 'POST', '退出配对只接受 POST')
        // 写路由同一条 CSRF 判据：那颗按钮与发码那颗在同一个弹窗里，头名不许分叉。
        assert.equal(
          init?.headers?.[PAIR_MARKER_HEADER],
          PAIR_MARKER_VALUE,
          `退出配对必须带 ${PAIR_MARKER_HEADER}: ${PAIR_MARKER_VALUE}，实际 init=${JSON.stringify(init)}`,
        )
        if (options.unpairThrows) throw new Error('退出配对那条断了')
        return { ok: true, status: 200, json: async () => options.unpairAnswer ?? { state: 'ok', unpaired: 1 } }
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
  const harness = load({ react: FAKE_REACT, slots: true, status: { ...DEFAULT_STATUS, paired: 1 } })
  const root = harness.mountPill()
  await flush()
  const pill = root.find('drc-pill')
  assert.ok(pill, `那颗按钮必须建出来：${root.allText()}`)
  // 抬头那句写在按钮里那个 `drc-label` 上，取它而不是按钮：假 DOM 的 textContent 不聚合后代。
  // 配上了几句台数**不写进抬头**：那排宽度是宿主给的，中文会被逐字断行（见下一条用例），
  // 而"几台"这件事点进去那颗按钮上看得见（只允许一台，所以它只可能是 0 或 1）。
  assert.equal(root.find('drc-label')!.textContent, '已配对')
  assert.equal(pill!.getAttribute('aria-label'), '已配对')
  assert.equal(root.find('drc-dot')!.getAttribute('data-tone'), 'on', '灯的颜色由 tone 决定')
})

test('在线但一台没配上：抬头是"未配对"，灯必须是灰的', async () => {
  const harness = load({ react: FAKE_REACT, slots: true })
  const root = harness.mountPill()
  await flush()
  assert.equal(root.find('drc-label')!.textContent, '未配对')
  assert.equal(
    root.find('drc-dot')!.getAttribute('data-tone'),
    'off',
    '绿色只能给"真的配上了一台"，一张还没人扫的码不算',
  )
})

test('那一排挤不下时只许省略号，不许把中文逐字断行（真屏幕截图抓到的形状）', async () => {
  // 现场：宿主 dock 已经挤到 `6 轮 …`、`1.6M to…`，而我们那颗 `已连 1 台` 被压成竖排四个字。
  // flex 项默认可以缩到"中文的最小内容宽度 = 一个字"，所以 nowrap + 省略号必须写死在样式里。
  const harness = load({ react: FAKE_REACT, slots: true, status: { ...DEFAULT_STATUS, paired: 1 } })
  const root = harness.mountPill()
  await flush()
  const css = harness.fakeDocument().head.children.find((node) => node.tag === 'style')?.textContent ?? ''
  assert.ok(css.includes('.drc-pill'), `那颗 pill 的样式没注入到 head：${css.slice(0, 120)}`)
  assert.match(css, /flex: 0 1 auto; white-space: nowrap;/, '按钮不许被压成多行：nowrap 是那条断行的唯一解药')
  assert.match(
    css,
    /\.drc-label \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;[^}]*\}/,
    '缩不下时截断的是文字，不是把整颗按钮撑开',
  )
  // 截断之后全文仍然取得到（悬浮与读屏都靠这两条）
  const pill = root.find('drc-pill')!
  assert.equal(pill.getAttribute('title'), 'dsh-remote-control：已配对')
  assert.equal(pill.getAttribute('aria-label'), '已配对')
})

test('中继断链时说的是"已断开连接"，而且是红的——不能和"还没配上"同一个灰', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, status: { ...DEFAULT_STATUS, relay: 'offline' } })
  const root = harness.mountPill()
  await flush()
  assert.equal(root.find('drc-label')!.textContent, '已断开连接')
  assert.equal(root.find('drc-dot')!.getAttribute('data-tone'), 'error', '断链是故障不是"还没轮到配"，灰灯会被读成后者')
})

test('runtime 还没起来时说"远程未启动"：idle 与 offline 是两件事', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, status: { ...DEFAULT_STATUS, relay: 'idle' } })
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

/**
 * 面板的两屏（2026-10-04 定形）：**未配对点开就是二维码页，已配对点开只给状态。**
 *
 * 原来这里是"未配对点开只给状态 + 一颗「生成配对码」"，那一屏被删掉了：没配上时面板上
 * 没有任何别的东西可看，多点一次只换到一次"啊，原来在这儿"。
 * 2026-10-03 那条取舍守的东西没有作废，只是挪了位置——**它现在守已配对那一侧**：
 * 配上了之后点开仍然一次码都不发（见下面那条 paired 的用例），因为那时点开的第一预期
 * 确实是"看一眼连得怎么样"，而一张码是有寿命的 pending 资源。
 */
test('未配对点开直接就是二维码页：发一次码、图与 6 位码都在，那颗按钮叫「刷新」', async () => {
  const harness = load({ react: FAKE_REACT, slots: true })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()

  assert.ok(root.find('drc-panel'), '面板要弹出来')
  assert.equal(root.find('drc-head-label')!.textContent, '未配对')
  assert.ok(root.find('drc-qr'), `未配对点开就该在二维码页上，实际：${root.allText()}`)
  assert.ok(root.find('drc-code'), '6 位码要单独印一行（QR 扫不出来时那是唯一退路）')
  assert.equal(
    harness.requests.filter((url) => url === PAIR_NEW_ROUTE).length,
    1,
    '点开要发**且只发一次**码：这条路由幂等，但一次点开排两次是白耗中继的 pending 表',
  )
  assert.equal(root.find('drc-btn')!.textContent, '刷新', '没配上时那颗按钮的身份就是"再要一张码"')
  // 正文那几行在未配对这一屏也要在场：它回答的是"连的哪一台 / 连没连上 / 跑的是哪一版"。
  const rows = root
    .findAll('drc-info')
    .map((row) => [row.find('drc-key')!.textContent, row.find('drc-value')!.textContent])
  // 夹具里 `waiting: 0`，所以"待处理"那一行自己不占地方，正文就是这三行（次序也是判据）。
  assert.deepEqual(rows, [
    ['中继', 'relay.example.com:443'],
    ['状态', '已连接'],
    ['版本', '0.0.0-test'],
  ])
  assert.ok(!root.allText().includes('wss://'), `面板里不许出现完整 URI：${root.allText()}`)
  // 已删掉的说法（这一轮又少了两个）：本机名、台数、再配一台、换一张、生成配对码。
  const flat = root.allText()
  for (const gone of ['本机', '已配对', '再配一台', '换一张', '生成配对码']) {
    assert.ok(!flat.includes(gone), `删掉的说法不该再出现：「${gone}」在 ${flat}`)
  }
})

test('已配对点开只给状态，一次码都不发；正文就是中继/状态/版本三行', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, status: { ...DEFAULT_STATUS, paired: 1 } })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()
  assert.equal(
    harness.requests.filter((url) => url === PAIR_NEW_ROUTE).length,
    0,
    '配上之后点开还发码 = 每次"看一眼"都可能向中继申请一张新的挂在 pending 表里',
  )
  assert.equal(root.find('drc-head-label')!.textContent, '已配对')
  assert.ok(!root.find('drc-qr'), '已配对那一屏不该有二维码')
  const rows = root
    .findAll('drc-info')
    .map((row) => [row.find('drc-key')!.textContent, row.find('drc-value')!.textContent])
  assert.deepEqual(
    rows,
    [
      ['中继', 'relay.example.com:443'],
      ['状态', '已连接'],
      ['版本', '0.0.0-test'],
    ],
    `正文就那三行、按这个次序：${root.allText()}`,
  )
})

/**
 * 这一组是"30 秒原则"落进界面的那一条（伞仓 docs/PRODUCT.md §3、§5 G3/G4）。
 *
 * 原来"已配对 + 有一条审批挂在手机上"时，那颗 pill 仍然只说 `已配对`——而那条回合正停在这台
 * 机器上等人点，且这颗 pill 是它在桌面上唯一可能被看见的地方。所以：**有得等就说等几件**。
 */
test('有东西在等时抬头说"等 N 件事"，面板第一行是"待处理 · 最久多久"', async () => {
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    status: { ...DEFAULT_STATUS, paired: 1, waiting: 2, waitingOldestSec: 252 },
  })
  const root = harness.mountPill()
  await flush()
  assert.equal(root.find('drc-label')!.textContent, '等 2 件事', `回合停着等人点，抬头不许还说"已配对"`)
  assert.equal(
    root.find('drc-dot')!.getAttribute('data-tone'),
    'wait',
    '要 amber 那一档：这是"该你动手"，不是"一切正常"的绿',
  )
  root.find('drc-pill')!.emit('click')
  await flush()
  const rows = root
    .findAll('drc-info')
    .map((row) => [row.find('drc-key')!.textContent, row.find('drc-value')!.textContent])
  assert.deepEqual(
    rows[0],
    ['待处理', '2 件 · 最久 4 分 12 秒'],
    `待处理必须排第一（其余三条都是"知道就行"）：${JSON.stringify(rows)}`,
  )
  assert.deepEqual(
    rows.slice(1).map(([key]) => key),
    ['中继', '状态', '版本'],
  )
})

test('两条优先级：断链仍然压过"等 N 件事"；没配上时挂起也不抢那一格', async () => {
  // ① 链都断了，"等几件"是没意义的——用户要修的是连接，那才是故障优先。
  const offline = load({
    react: FAKE_REACT,
    slots: true,
    status: { ...DEFAULT_STATUS, paired: 1, relay: 'offline', waiting: 3, waitingOldestSec: 10 },
  })
  const offlineRoot = offline.mountPill()
  await flush()
  assert.equal(offlineRoot.find('drc-label')!.textContent, '已断开连接')
  assert.equal(offlineRoot.find('drc-dot')!.getAttribute('data-tone'), 'error')

  // ② 手机中途掉线、挂起还没超时：这时能做的第一件事是重新配对，抬头就该说那个。
  const unpaired = load({
    react: FAKE_REACT,
    slots: true,
    status: { ...DEFAULT_STATUS, paired: 0, waiting: 1, waitingOldestSec: 40 },
  })
  const unpairedRoot = unpaired.mountPill()
  await flush()
  assert.equal(unpairedRoot.find('drc-label')!.textContent, '未配对', '没配上却说"等 1 件事"是让人去找一台不存在的手机')
  // 但面板里那一行仍然要说——它回答的是"这台机器上有没有回合被卡住"。
  unpairedRoot.find('drc-pill')!.emit('click')
  await flush()
  const first = unpairedRoot.findAll('drc-info')[0]!
  assert.deepEqual(
    [first.find('drc-key')!.textContent, first.find('drc-value')!.textContent],
    ['待处理', '1 件 · 最久 40 秒'],
    '抬头不抢，不代表面板可以不说',
  )
})

/**
 * 时长写法走**打出来的 bundle**，不直接 import 那个纯函数——这个文件的立足点就是
 * "在 vm 里真跑 client.cjs"，绕过去就等于这条判据没测过 bundle 里那份。
 */
test('等待时长的写法：<60 秒只说秒、十分钟以上不再带秒（这行是扫一眼的，不是秒表）', async () => {
  const cases: Array<[number, string]> = [
    [37, '1 件 · 最久 37 秒'],
    [60, '1 件 · 最久 1 分 0 秒'],
    [252, '1 件 · 最久 4 分 12 秒'],
    [600, '1 件 · 最久 10 分'],
    [7265, '1 件 · 最久 121 分'],
  ]
  for (const [seconds, expected] of cases) {
    const harness = load({
      react: FAKE_REACT,
      slots: true,
      status: { ...DEFAULT_STATUS, paired: 1, waiting: 1, waitingOldestSec: seconds },
    })
    const root = harness.mountPill()
    await flush()
    root.find('drc-pill')!.emit('click')
    await flush()
    const value = root.findAll('drc-info')[0]!.find('drc-value')!.textContent
    assert.equal(value, expected, `${seconds}s 那一档写成了「${value}」，期望「${expected}」`)
  }
})

test('waitingOldestSec 是怪值（老版宿主 / NaN）时那一行只说件数，不许印出 NaN', async () => {
  for (const junk of ['不是数', -7, undefined]) {
    const harness = load({
      react: FAKE_REACT,
      slots: true,
      status: { ...DEFAULT_STATUS, paired: 1, waiting: 2, waitingOldestSec: junk },
    })
    const root = harness.mountPill()
    await flush()
    root.find('drc-pill')!.emit('click')
    await flush()
    const value = root.findAll('drc-info')[0]!.find('drc-value')!.textContent
    assert.equal(value, '2 件', `怪值 ${JSON.stringify(junk)} 应该退化成只说件数，实际「${value}」`)
  }
})

test('waiting 字段缺失（老版宿主）时那一行不建、抬头退回"已配对"', async () => {
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    status: { relay: 'online', paired: 1, serverUrl: 'wss://relay.example.com:443/relay', version: '1.2.0' },
  })
  const root = harness.mountPill()
  await flush()
  assert.equal(root.find('drc-label')!.textContent, '已配对')
  root.find('drc-pill')!.emit('click')
  await flush()
  const keys = root.findAll('drc-info').map((row) => row.find('drc-key')!.textContent)
  assert.deepEqual(keys, ['中继', '状态', '版本'], `没有 waiting 就不该凭空出现一行"待处理"：${JSON.stringify(keys)}`)
})

test('正文那三行各自拿不到值时不占地方：老版路由没给 version、中继字段不认识', async () => {
  // 模拟"宿主是上一版、回答里没有 version"：那一行必须自己消失，而不是印一个空白键。
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    status: { relay: 'weird-state', paired: 0, serverUrl: 'wss://relay.example.com:443/relay' },
  })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()
  const keys = root.findAll('drc-info').map((row) => row.find('drc-key')!.textContent)
  assert.deepEqual(keys, ['中继'], `拿不到值的那两行不该出现，收到：${JSON.stringify(keys)}`)
})

test('中继那条链的细态按 relay 取值翻译：连接中 / 已断开 / 未启动', async () => {
  const cases: Array<[string, string]> = [
    ['connecting', '连接中'],
    ['offline', '已断开'],
    ['idle', '未启动'],
  ]
  for (const [relay, expected] of cases) {
    const harness = load({
      react: FAKE_REACT,
      slots: true,
      status: { relay, paired: 0, serverUrl: 'wss://relay.example.com:443/relay', version: '0.0.0-test' },
    })
    const root = harness.mountPill()
    await flush()
    root.find('drc-pill')!.emit('click')
    await flush()
    const stateRow = root.findAll('drc-info').find((row) => row.find('drc-key')!.textContent === '状态')
    assert.equal(stateRow?.find('drc-value')!.textContent, expected, `relay=${relay} 时那行状态`)
  }
})

test('已经配上时右上角那颗是"退出配对"，按下就打 POST /unpair（带同一个守卫头）', async () => {
  // 先未配对地建出来，再把状态切成已配对并触发一次轮询，验证按钮会随状态改文案。
  const harness = load({ react: FAKE_REACT, slots: true, status: { ...DEFAULT_STATUS, paired: 1 } })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()
  assert.equal(root.find('drc-head-label')!.textContent, '已配对')
  const button = root.find('drc-btn')!
  assert.equal(button.textContent, '退出配对')
  assert.equal(
    harness.requests.filter((url) => url.startsWith(PAIR_UNPAIR_ROUTE)).length,
    0,
    '点开面板本身不该解配——必须真的按下那颗按钮',
  )

  button.emit('click')
  await flush()
  assert.ok(
    harness.requests.some((url) => url.startsWith(PAIR_UNPAIR_ROUTE)),
    `按下退出配对必须打那条写路由：${harness.requests.join(' | ')}`,
  )
  // 乐观翻面：不用等下一次 2 秒轮询，抬头与那颗按钮当场就变。
  assert.equal(root.find('drc-head-label')!.textContent, '未配对')
  // 退完之后不再是"先按一颗生成配对码"那一屏：**没配上就直接在二维码页上**，
  // 那颗按钮的身份同时翻成 `刷新`（要再换一张码还是它）。
  assert.equal(root.find('drc-btn')!.textContent, '刷新')
  assert.ok(root.find('drc-qr'), `退出配对之后面板该停在二维码页，实际：${root.allText()}`)
})

test('退出配对那条断了：面板不白屏、抬头仍按乐观结果翻面，并且留下一行 warn', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, status: { ...DEFAULT_STATUS, paired: 1 }, unpairThrows: true })
  const root = harness.mountPill()
  await flush()
  root.find('drc-pill')!.emit('click')
  await flush()
  root.find('drc-btn')!.emit('click')
  await flush()
  assert.equal(harness.errors.length, 0, '这是降级不是故障')
  assert.ok(root.find('drc-panel'), '面板要留着')
  assert.ok(
    harness.warnings.some((line) => line.includes('退出配对')),
    `降级要留下能查的一句：${harness.warnings.join(' | ')}`,
  )
})

test('按下发码那颗：POST 发码那条，再把图与 6 位码画进面板；epoch 进图片 URL', async () => {
  const harness = load({ react: FAKE_REACT, slots: true })
  const root = harness.mountPill()
  await openPairing(root)

  assert.ok(harness.requests.includes(PAIR_NEW_ROUTE), `必须真的打过发码那条：${harness.requests.join(' | ')}`)
  assert.ok(root.find('drc-panel'), '面板要弹出来')
  assert.equal(root.find('drc-qr')!.src, `${PAIR_IMAGE_ROUTE}?e=e1`, '图片地址要带上这一版码的 epoch')
  assert.equal(root.find('drc-code')!.textContent, '482913', '6 位码必须与 QR 同时在屏上——手输是唯一退路')
  assert.equal(root.find('drc-note')!.textContent, '扫码配对 · 1 分 0 秒后过期')
  // 出图这一版右上角那颗是**刷新**，不再是"生成配对码"——同一件事两个说法会让用户以为要重新配一次。
  assert.equal(root.find('drc-btn')!.textContent, '刷新', '二维码页那颗按钮的文案')
  assert.equal(root.find('drc-pill')!.getAttribute('aria-expanded'), 'true')
})

test('200 + state:"unavailable" 不是成功：面板要说明白，不许弹一张白框', async () => {
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    newAnswer: { state: 'unavailable', reason: 'relay-offline' },
  })
  const root = harness.mountPill()
  await openPairing(root)
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
  await openPairing(root)
  assert.match(root.find('drc-note')!.textContent, /request-not-trusted/, '要把宿主说的原因带出来')
  assert.match(root.find('drc-note')!.textContent, /pair-marker-missing/, '更要带出是哪一道守卫')
})

test('发码那条直接断（fetch 抛）：面板显示失败原因，不抛出、不白屏', async () => {
  const harness = load({ react: FAKE_REACT, slots: true, newThrows: true })
  const root = harness.mountPill()
  await openPairing(root)
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

test('码过期后**不再自动补一张**，就地说明白要人自己去按（自动补码已删，重发靠右上角那颗「刷新」）', async () => {
  const harness = load({
    react: FAKE_REACT,
    slots: true,
    newAnswer: { state: 'ready', epoch: 'e1', token: '482913', expiresInMs: 1_000 },
  })
  const root = harness.mountPill()
  await openPairing(root)
  assert.equal(harness.requests.filter((url) => url === PAIR_NEW_ROUTE).length, 1)
  // 节拍次序：0 = pill 状态轮询，1 = 面板倒计时。倒计时走光后自清，所以那一刻仍是 2 个。
  assert.equal(harness.timerCount(), 2, '该有两个节拍')
  await harness.fireAndFlush(1)
  assert.equal(
    harness.requests.filter((url) => url === PAIR_NEW_ROUTE).length,
    1,
    '倒计时走光**不许**再去要一张：自动补码 2026-10-03 删了，重发靠人按右上角那颗「刷新」',
  )
  assert.match(root.find('drc-note')!.textContent, /已过期/)
  assert.equal(root.find('drc-btn')!.textContent, '刷新', '要重发还是右上角那颗（出图时它叫刷新）')
})

test('手机上刚扫完码：面板从二维码当场翻回状态视图，右上角那颗同时变成"退出配对"', async () => {
  // 一张码配上之后就没用了。面板若还停在图上，用户会以为"还没成功、再扫一次"。
  const status: Record<string, unknown> = { ...DEFAULT_STATUS, paired: 0 }
  const harness = load({ react: FAKE_REACT, slots: true, status })
  const root = harness.mountPill()
  await openPairing(root)
  assert.ok(root.find('drc-qr'), '先确认图在屏上')
  assert.equal(root.find('drc-btn')!.textContent, '刷新')

  status.paired = 1
  await harness.fireAndFlush(0)
  assert.equal(root.find('drc-qr'), undefined, '配上之后那张图不该还占着面板')
  assert.equal(root.find('drc-head-label')!.textContent, '已配对')
  assert.equal(root.find('drc-btn')!.textContent, '退出配对')
  assert.ok(harness.requests.filter((url) => url === PAIR_NEW_ROUTE).length === 1, '翻面只是重画，不许顺手再要一张')
})

test('样式表按内容对齐：宿主热更这一半、文档没重载时，旧 CSS 必须被换掉', async () => {
  // 现场（2026-10-03 用户截图）：新 JS 按新结构建 DOM，`<head>` 里却还是上一版的 `<style>`——
  // 旧 `.drc-actions{justify-content:center}` 让右上角那颗按钮掉到第二行居中，整块面板错位。
  const harness = load({ react: FAKE_REACT, slots: true, staleStyle: true })
  harness.mountPill()
  await flush()
  const doc = harness.fakeDocument()
  const styles = doc.head.children.filter((node) => node.tag === 'style')
  assert.equal(styles.length, 1, `不该再插第二份样式表：${styles.length}`)
  assert.ok(
    styles[0]!.textContent.includes('.drc-head'),
    '旧样式表必须被换成这一版的：只看"插过没有"会让上一版的布局一直生效',
  )
  assert.ok(!styles[0]!.textContent.includes('上一版的样式'), '旧内容不许留着')
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
  for (const constant of [PAIR_NEW_ROUTE, PAIR_IMAGE_ROUTE, PAIR_STATUS_ROUTE, PAIR_UNPAIR_ROUTE, PAIR_MARKER_HEADER]) {
    assert.ok(bundle.includes(constant), `client.cjs 里缺 ${constant}`)
  }
  // 出现一条宿主侧没有的 /plugins 路径就是两边分叉了。
  const found = [...new Set([...bundle.matchAll(/\/plugins\/[a-z0-9./-]+/g)].map((match) => match[0]))].sort()
  assert.deepEqual(found, [PAIR_NEW_ROUTE, PAIR_IMAGE_ROUTE, PAIR_STATUS_ROUTE, PAIR_UNPAIR_ROUTE].sort())
})
