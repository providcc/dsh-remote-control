/**
 * client-bundle.test — 在 vm 里真跑一遍**打出来的** `dist/bundle/client.cjs`。
 *
 * 为什么要在产物上测、而不是 import 源码：这一半真正容易错的地方是**外壳**
 * （`window.__ModuleLoader__.load({id, factory})` 的 id/闭合/导出形状）和
 * "装载之后到底注册了什么"。外壳写错的表现是整页 web boot 失败——真机上要重启应用才看得见，
 * 所以这里用 Node 的 vm 造一个最小的浏览器环境，把产物原样执行：
 *
 *   1. 外壳注册成功、id 与包名一致、导出的是 `{name, inject, apply}`（inject 必须含 sidebarRight，
 *      否则宿主 ctx 的 Proxy 读它会抛错 → apply 失败 → 整页起不来）；
 *   2. apply 之后会把路由地址推进右栏，且**同一个 epoch 只推一次**（换码才再推）；
 *   3. 页面不可见时一次请求都不发；会话面板没挂上时静默等待；
 *   4. 任何一步出错都只记一条 console.error，绝不把异常抛出 apply；
 *   5. 状态栏那颗 pill：向装载器拿 react、往 `conversation.composer.dock` 注册、点击发码、
 *      把图与 6 位码画进面板。**拿不到 react / 探不到 slots 时只降级成"没有 pill"**——
 *      那是新功能唯一能连累已在生产的老功能（右栏自动弹码）的通道，所以每条都钉住。
 *
 * 这里不测"右栏会不会真的打开"，也不测"那颗 pill 好不好看"——那两条是真机验收
 * （见 HANDOFF 的验收清单）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { PAIR_IMAGE_ROUTE, PAIR_NEW_ROUTE, PAIR_STATUS_ROUTE } from '../src/presentation/pair-actions.js'
import { PAIRING_ROUTE } from '../src/presentation/route.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(here, '..', 'bundle', 'client.cjs')
const ROUTE = PAIRING_ROUTE

interface ClientModule {
  name: string
  inject: string[]
  apply(ctx: unknown): void
}

interface LoadOptions {
  hidden?: boolean
  requireThrows?: boolean
  reply?: { body: unknown; ok?: boolean; status?: number }
  /** 装载器能不能给出 react。缺省给不出——那是老用例的形状，也是"最坏只少一颗 pill"那条。 */
  react?: unknown
  /** 软探测能不能拿到 `slots` 这个服务。 */
  slots?: boolean
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
  /** 右栏被推开的地址（按先后顺序）。 */
  opened: string[]
  /** fetch 收到的 URL。 */
  requests: string[]
  /** 被记下来的 console.error。 */
  errors: string[]
  /** 被记下来的 console.warn——pill 那一路的降级说的是 warn，不是 error。 */
  warnings: string[]
  /** 触发一次宿主侧节拍（第 0 个，也就是右栏那条轮询）。 */
  tick(): void
  /** 换掉下一次 fetch 的应答。 */
  reply(body: unknown, init?: { ok?: boolean; status?: number }): void
  /** 登记过的卸载函数（apply 最后注册的那一份）。 */
  disposable(): (() => void) | undefined
  /** 装载到现在创建的节拍个数（右栏 1 个；pill 挂了再加状态轮询与倒计时）。 */
  timerCount(): number
  fire(index: number): void
  fireAndFlush(index: number): Promise<void>
  /** pill 注册进槽位时 `register` 收到的入参。 */
  slotRegisters(): Array<{ definition: Record<string, unknown>; component?: () => unknown }>
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

function readyBody(
  epoch: string,
  address = 'dsh-resource://file/session/sess-1//Users/x/.dsh/a.png',
): Record<string, unknown> {
  return { state: 'ready', epoch, address, expiresAt: Date.now() + 60_000 }
}

/** 一颗够用的假 react：这一半只用 createElement。 */
const FAKE_REACT = {
  createElement: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
}

function load(options: LoadOptions = {}): Harness {
  const opened: string[] = []
  const requests: string[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const timers: Array<() => void> = []
  const slotRegisters: Array<{ definition: Record<string, unknown>; component?: () => unknown }> = []
  const doc = new FakeDocument(options.hidden ? 'hidden' : 'visible')
  // apply 一返回就会跑第一次 poll（fetch 是**同步**发出去的），所以"第一次应答"必须在这里给，
  // 不能等 load() 返回之后再 reply —— 那时响应对象已经建好了。
  let next: { body: unknown; ok: boolean; status: number } = {
    body: options.reply?.body ?? { state: 'none' },
    ok: options.reply?.ok ?? true,
    status: options.reply?.status ?? 200,
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
    fetch: async (url: string, init?: { method?: string }) => {
      requests.push(url)
      const method = init?.method ?? 'GET'
      if (url.startsWith(PAIR_NEW_ROUTE)) {
        assert.equal(method, 'POST', '发码那条只接受 POST')
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
      return { ok: next.ok, status: next.status, json: async () => next.body }
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

  let disposable: (() => void) | undefined
  const ctx = {
    sidebarRight: {
      require: () => {
        if (options.requireThrows) throw new Error('sidebarRight: no session surface is mounted')
        return { sessionId: 'sess-1' }
      },
      openResource: (address: string) => {
        opened.push(address)
      },
    },
    get: (name: string) => {
      if (options.getThrows) throw new Error(`cannot get property "${name}" without inject`)
      return name === 'slots' ? slots : undefined
    },
    effect: (execute: () => unknown) => {
      const returned = execute()
      if (typeof returned === 'function') disposable = returned as () => void
    },
  }
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
    opened,
    requests,
    errors,
    warnings,
    tick: () => {
      assert.ok(timers.length >= 1, 'apply 必须起一个轮询节拍')
      timers[0]!()
    },
    reply: (body: unknown, init) => {
      next = { body, ok: init?.ok ?? true, status: init?.status ?? 200 }
    },
    disposable: () => disposable,
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

test('外壳注册的形状：id 与包名一致，导出 name/inject/apply，inject 含 sidebarRight', () => {
  const harness = load()
  assert.equal(harness.module.name, 'dsh-remote-control')
  // 展开一次：vm 那个 realm 的数组与本 realm 的 Array.prototype 不是同一个，
  // deepStrictEqual 会因原型不同而红（与代码对错无关）。
  assert.deepEqual([...harness.module.inject], ['sidebarRight'])
  assert.equal(typeof harness.module.apply, 'function')
  assert.equal(harness.errors.length, 0)
})

test('有码就推右栏，地址原样来自路由；同一个 epoch 只推一次，换码再推', async () => {
  const harness = load({ reply: { body: readyBody('e1') } })
  await flush()
  assert.deepEqual(harness.requests, [`${ROUTE}?session=sess-1`])
  assert.deepEqual(harness.opened, ['dsh-resource://file/session/sess-1//Users/x/.dsh/a.png'])

  harness.tick()
  await flush()
  assert.equal(harness.opened.length, 1, '同一版码不该重复顶开右栏')

  harness.reply(readyBody('e2', 'dsh-resource://file/session/sess-1//Users/x/.dsh/b.png'))
  harness.tick()
  await flush()
  assert.deepEqual(harness.opened[1], 'dsh-resource://file/session/sess-1//Users/x/.dsh/b.png')
})

test('没有码 / 已过期 / state 不认识：一次都不推', async () => {
  const harness = load({ reply: { body: { state: 'none' } } })
  await flush()
  harness.reply({ state: 'ready', epoch: 'e9', address: 'x', expiresAt: Date.now() - 1 })
  harness.tick()
  await flush()
  assert.deepEqual(harness.opened, [])
  assert.equal(harness.errors.length, 0)
})

test('页面不可见时一次请求都不发（Electron 里窗口在后台是常态）', async () => {
  const harness = load({ hidden: true, reply: { body: readyBody('e1') } })
  await flush()
  harness.tick()
  await flush()
  assert.deepEqual(harness.requests, [])
  assert.deepEqual(harness.opened, [])
})

test('会话面板还没挂上（require 抛错）：静默等下一轮，不当故障记', async () => {
  const harness = load({ requireThrows: true, reply: { body: readyBody('e1') } })
  await flush()
  harness.tick()
  await flush()
  assert.deepEqual(harness.requests, [])
  assert.equal(harness.errors.length, 0, '这是正常的启动态，不该刷日志')
})

test('路由报错：只记一条 console.error，并把状态码带出来', async () => {
  const harness = load({ reply: { body: { error: 'boom' }, ok: false, status: 500 } })
  await flush()
  assert.ok(
    harness.errors.some((line) => line.includes('500')),
    harness.errors.join('\n'),
  )
  assert.deepEqual(harness.opened, [])
})

test('卸载函数被登记：调用它之后节拍停掉（再 tick 也不发请求）', async () => {
  const harness = load({ reply: { body: readyBody('e1') } })
  await flush()
  const dispose = harness.disposable()
  assert.equal(typeof dispose, 'function', '必须用 ctx.effect 登记卸载')
  dispose!()
  const requestsBefore = harness.requests.length
  harness.tick()
  await flush()
  assert.equal(harness.requests.length, requestsBefore, '停掉之后不该再发请求')
})

// ── 状态栏那颗 pill ────────────────────────────────────────────────

test('拿不到 react：只少一颗 pill，右栏那半照常推地址、一条 error 都不许有', async () => {
  const harness = load({ reply: { body: readyBody('e1') } })
  await flush()
  assert.deepEqual(harness.opened, ['dsh-resource://file/session/sess-1//Users/x/.dsh/a.png'], '老功能不能被新功能连累')
  assert.equal(harness.slotRegisters().length, 0, '没有 react 就不该去碰槽位')
  assert.equal(harness.errors.length, 0)
  assert.ok(
    harness.warnings.some((line) => line.includes('react')),
    `降级要留下能查的一句：${harness.warnings.join(' | ')}`,
  )
})

test('探不到 slots（这代宿主没这个服务）：同样只降级，右栏照旧', async () => {
  const harness = load({ react: FAKE_REACT, reply: { body: readyBody('e1') } })
  await flush()
  assert.equal(harness.slotRegisters().length, 0)
  assert.equal(harness.errors.length, 0)
  assert.ok(
    harness.warnings.some((line) => line.includes('slots')),
    `要指名是没探到 slots：${harness.warnings.join(' | ')}`,
  )
  assert.deepEqual(harness.opened, ['dsh-resource://file/session/sess-1//Users/x/.dsh/a.png'])
})

test('软探测不许抛出 apply：ctx.get 抛（真 cordis 的 Proxy 就是这个形状）时右栏照旧', async () => {
  const harness = load({ react: FAKE_REACT, getThrows: true, reply: { body: readyBody('e1') } })
  await flush()
  assert.equal(harness.errors.length, 0, `抛出 apply 就是整页起不来：${harness.errors.join(' | ')}`)
  assert.equal(harness.slotRegisters().length, 0)
  assert.deepEqual(harness.opened, ['dsh-resource://file/session/sess-1//Users/x/.dsh/a.png'])
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
  // 节拍次序：0 = 右栏轮询，1 = pill 状态轮询，2 = 面板倒计时。
  assert.equal(harness.timerCount(), 3, '该有三个节拍')
  await harness.fireAndFlush(2)
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
  await harness.fireAndFlush(1)
  assert.equal(harness.requests.length, after, '卸载后不该再轮状态')
  assert.equal(doc.listenerCount('pointerdown'), 0, '文档级监听必须摘掉，否则每次重挂都多一份')
})

test('反证：产物里的路由常量与宿主侧定义逐字一致（分叉的表现是"点了没反应而日志全绿"）', () => {
  const bundle = readFileSync(CLIENT, 'utf8')
  for (const constant of [ROUTE, PAIR_NEW_ROUTE, PAIR_IMAGE_ROUTE, PAIR_STATUS_ROUTE]) {
    assert.ok(bundle.includes(constant), `client.cjs 里缺 ${constant}`)
  }
  // 出现一条宿主侧没有的 /plugins 路径就是两边分叉了。
  const found = [...new Set([...bundle.matchAll(/\/plugins\/[a-z0-9./-]+/g)].map((match) => match[0]))].sort()
  assert.deepEqual(found, [ROUTE, PAIR_NEW_ROUTE, PAIR_IMAGE_ROUTE, PAIR_STATUS_ROUTE].sort())
})
