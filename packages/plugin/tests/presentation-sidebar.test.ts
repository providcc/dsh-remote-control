/**
 * presentation-sidebar.test — 右栏那一半的接线：软探测 `webServer`、起节拍、挂路由、收干净。
 *
 * 这一层不重复测 presenter / route 的判断（那两个文件各测各的），它测的是**它们被接起来了**：
 * 一次启动之后，真实地渲染出一张 PNG、真实地把它写进磁盘、并且路由给出的地址**指向那个真的
 * 存在的文件**。中间任何一环没接上，这个断言就会红。
 *
 * 原来这些断言写在独立包 `packages/presentation/tests/entry.test.ts` 里，喂的是
 * `apply(ctx, injected)` + 两个服务（`dshRemoteControl` / `webServer`）。折进主插件之后
 * 只剩一个服务要探（`webServer`），配对码与工作区都从主插件内部直接拿，所以这里的 fixture
 * 是 `startSidebarQr(ctx, deps)`。**"另一半服务从 inject 的作用域上下文里到"那条形状没丢**：
 * 真宿主给 inject 回调的是作用域化上下文而不是服务实例，这一点踩过坑，仍然单独钉住。
 *
 * 另外几条是宿主加载纪律：探测抛错不许外抛、没有 webServer 时什么都不做、卸载要收回路由与节拍。
 * 落点仍是"请求那条会话的工作区"，工作区解析不出来才退回 `config.imageFile`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startSidebarQr, type SidebarQrSettings } from '../src/presentation/sidebar.js'
import { PAIR_NEW_ROUTE, PAIR_IMAGE_ROUTE, PAIR_STATUS_ROUTE } from '../src/presentation/pair-actions.js'
import { PAIRING_ROUTE } from '../src/presentation/route.js'

const HOST_HEADERS = { host: '127.0.0.1:5173' }

interface Captured {
  /** setInterval 回调（sidebar 只起一个）。 */
  ticks: Array<() => void>
  /** clearInterval 被调了几次。 */
  cleared: number
}

interface Route {
  kind: string
  path: string
  handler: (request: unknown, response: unknown) => unknown
}

interface Setup {
  ctx: Record<string, unknown>
  routes: Route[]
  unregistered: () => number
}

function settings(file: string, enabled = true): SidebarQrSettings {
  return { enabled, imageFile: file, refreshMs: 1000 }
}

/**
 * 造一版码，**形状照抄 `describeActivePairing()` 序列化出来的那一版**：`expiresAt` 是 ISO
 * 字符串，不是内部毫秒数。只喂毫秒 fixture 的话，就正好绕过了真机上"每版码都被判过期"那个 bug
 * （取证写在 `src/presentation/presenter.ts` 的 `toEpochMs`）。
 */
function pairingWith(qr: string, expiresAtMs: number): { qr: string; expiresAt: string } {
  return { qr, expiresAt: new Date(expiresAtMs).toISOString() }
}

function setup(options: { web?: boolean; get?: boolean; inject?: boolean; scopedInject?: boolean } = {}): Setup {
  const routes: Route[] = []
  let unregistered = 0
  const web = {
    register: (route: Route) => {
      routes.push(route)
      return () => {
        unregistered += 1
      }
    },
  }
  const ctx: Record<string, unknown> = {}
  if (options.get !== false) {
    ctx.get = (name: string) => (name === 'webServer' && options.web !== false ? web : undefined)
  }
  if (options.inject !== false) {
    ctx.inject = (_names: string[], callback: (scoped: unknown) => void) => {
      // 真宿主给的是**作用域化上下文**（要在它上面 get 才拿得到服务），
      // 这里就按那个形状喂，免得测出来的是"回调参数=服务"这个错的形状。
      if (options.scopedInject) callback({ get: (name: string) => (name === 'webServer' ? web : undefined) })
    }
  }
  return { ctx, routes, unregistered: () => unregistered }
}

/**
 * 用真的 Timer 句柄伪装节拍：`clearInterval` 收到的必须是一个真句柄，
 * 否则"卸载时到底清没清"这条断言测的就是假对象的行为了。
 */
async function withTimers<T>(run: (captured: Captured) => Promise<T> | T): Promise<T> {
  const captured: Captured = { ticks: [], cleared: 0 }
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  globalThis.setInterval = ((callback: () => void) => {
    captured.ticks.push(callback)
    // 一个真的、永不触发的句柄（顶到最大延时并 unref），这样 clearInterval 有真东西可清。
    const handle = realSet(() => {}, 0x7fffffff)
    handle.unref?.()
    return handle
  }) as never
  globalThis.clearInterval = ((handle: Parameters<typeof realClear>[0]) => {
    captured.cleared += 1
    realClear(handle)
  }) as never
  try {
    return await run(captured)
  } finally {
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
  }
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the route to answer "ready"')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function askRoute(route: Route, url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0
  let payload = ''
  const response = {
    writeHead: (code: number) => {
      status = code
    },
    end: (chunk?: unknown) => {
      payload = typeof chunk === 'string' ? chunk : ''
    },
  }
  await route.handler({ method: 'GET', url, headers: HOST_HEADERS }, response)
  return { status, body: JSON.parse(payload) as Record<string, unknown> }
}

/**
 * 一次启动会挂上**三条**路由（只读状态那条 + 状态栏那颗 pill 的两条），所以取路由要按路径取，
 * 不能靠下标——找不到就直接红，别让它静默退回 `routes[0]` 而测到另一条上去。
 */
function routeAt(routes: Route[], wanted: string): Route {
  const found = routes.find((route) => route.path === wanted)
  assert.ok(
    found,
    `路由 ${wanted} 没挂上，实际挂的是：${routes.map((route) => route.path).join(', ') || '（一条都没有）'}`,
  )
  return found as Route
}

function tempImageFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-sidebar-'))
  return { file: path.join(dir, 'sidebar-qr.png'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * 状态栏那三条路由要的依赖，在这个文件里只是占位——本文件测的是**右栏接线**
 * （软探测、节拍、落盘、注销）。发码的幂等、守卫、204 这些判据单独钉在
 * `presentation-pair-actions.test.ts`，因为那是另一档安全姿态（会改状态）。
 */
const ACTION_DEPS = {
  ensureFresh: () => null,
  current: () => null,
  renderPng: async () => Buffer.from('fake-png'),
  status: () => ({ relay: 'offline' as const, paired: 0, hasCode: false }),
}

const LOGS = () => {
  const lines: string[] = []
  return {
    lines,
    log: (message: string, fields?: Record<string, unknown>) =>
      lines.push(`${message} ${JSON.stringify(fields ?? {})}`),
  }
}

test('webServer 到位：起节拍、挂路由，节拍跑出来的图真的在磁盘上', async () => {
  const { file, cleanup } = tempImageFile()
  try {
    const setupResult = setup({})
    const logs = LOGS()
    await withTimers(async (captured) => {
      const handle = startSidebarQr(setupResult.ctx, {
        config: settings(file),
        pairing: () => pairingWith('dsh-rc://pair?server=ws://x&psk=fake-psk&token=fake-token', Date.now() + 60_000),
        workspaceOf: () => undefined,
        log: logs.log,
        ...ACTION_DEPS,
      })
      assert.deepEqual(
        setupResult.routes.map((route) => route.path),
        [PAIRING_ROUTE, PAIR_NEW_ROUTE, PAIR_IMAGE_ROUTE, PAIR_STATUS_ROUTE],
        '四条路由都要挂上：只读状态那条 + pill 的发码 + pill 的图 + pill 的抬头状态',
      )
      assert.equal(captured.ticks.length, 1, '节拍必须起起来')
      assert.equal(handle.probe.webServer, 'via get')
      assert.equal(handle.probe.route, 'registered')
      assert.equal(handle.probe.actions, 'registered')
      assert.equal(handle.available, true, '三条都挂上了，pill 就该是能点的')

      const answer = await waitFor(async () => {
        const got = await askRoute(routeAt(setupResult.routes, PAIRING_ROUTE), '/?session=sess-1')
        return got.status === 200 && got.body.state === 'ready' ? got : undefined
      })
      assert.equal(typeof answer.body.epoch, 'string')
      assert.equal(typeof answer.body.expiresAt, 'number')
      const address = String(answer.body.address)
      assert.ok(address.startsWith('dsh-resource://file/session/sess-1/'), address)
      assert.ok(address.endsWith(encodeURIComponent(path.basename(file))), address)
      assert.ok(existsSync(file), '地址指向的 PNG 必须真的存在')
      // 地址里绝不能出现码本身（路由是浏览器可达的，码带着一次性 token + PSK）。
      assert.ok(!JSON.stringify(answer).includes('fake-psk'))
      assert.ok(!JSON.stringify(answer).includes('fake-token'))
      handle.stop()
    })
  } finally {
    cleanup()
  }
})

test('会话工作区解析得出来：图落在 <工作区>/.dsh/sidebar-qr.png，配置里的 imageFile 当兜底不用', async () => {
  const { file: fallback, cleanup } = tempImageFile()
  const workspace = mkdtempSync(path.join(tmpdir(), 'drc-sidebar-ws-'))
  try {
    const setupResult = setup({})
    const logs = LOGS()
    await withTimers(async () => {
      const handle = startSidebarQr(setupResult.ctx, {
        config: settings(fallback),
        pairing: () => pairingWith('dsh-rc://pair?server=ws://x&psk=fake-psk&token=fake-token', Date.now() + 60_000),
        workspaceOf: (sessionId) => (sessionId === 'sess-1' ? workspace : undefined),
        log: logs.log,
        ...ACTION_DEPS,
      })
      const answer = await waitFor(async () => {
        const got = await askRoute(routeAt(setupResult.routes, PAIRING_ROUTE), '/?session=sess-1')
        return got.status === 200 && got.body.state === 'ready' ? got : undefined
      })
      const address = String(answer.body.address)
      // 工作区是绝对路径 → 会话作用域地址里出现双斜杠，这是宿主 parseFileAddress 认的形状。
      assert.ok(address.startsWith('dsh-resource://file/session/sess-1//'), address)
      assert.ok(address.endsWith('/.dsh/sidebar-qr.png'), address)
      assert.ok(existsSync(path.join(workspace, '.dsh', 'sidebar-qr.png')), '图必须落在会话工作区的 .dsh 下')
      assert.equal(existsSync(fallback), false, '工作区解析得出来时不该再往兜底位置写')
      handle.stop()
    })
  } finally {
    cleanup()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('工作区解析抛错（内核还没起来）：退回配置里的 imageFile，两边仍指同一个文件', async () => {
  const { file: fallback, cleanup } = tempImageFile()
  try {
    const setupResult = setup({})
    const logs = LOGS()
    await withTimers(async () => {
      const handle = startSidebarQr(setupResult.ctx, {
        config: settings(fallback),
        pairing: () => pairingWith('dsh-rc://pair?psk=fake-psk', Date.now() + 60_000),
        workspaceOf: () => {
          throw new Error('kernel 还没接上')
        },
        log: logs.log,
        ...ACTION_DEPS,
      })
      const answer = await waitFor(async () => {
        const got = await askRoute(routeAt(setupResult.routes, PAIRING_ROUTE), '/?session=sess-1')
        return got.status === 200 && got.body.state === 'ready' ? got : undefined
      })
      assert.ok(String(answer.body.address).endsWith(encodeURIComponent(path.basename(fallback))))
      assert.ok(existsSync(fallback), '兜底落点必须真的写出文件')
      assert.ok(
        logs.lines.some((line) => line.includes('会话工作区解析失败')),
        '退回兜底这件事要留痕，不然排查时会以为是配置指到这里：' + logs.lines.join(' | '),
      )
      handle.stop()
    })
  } finally {
    cleanup()
  }
})

test('落盘写不进去 → 200 + none，绝不交出指向不存在文件的地址', async () => {
  const { file: fallback, cleanup } = tempImageFile()
  const workspace = mkdtempSync(path.join(tmpdir(), 'drc-sidebar-badws-'))
  try {
    // 把"工作区"指到一个**文件**上：`<文件>/.dsh/` 建不出来，writePrivatePng 必然 false。
    const notADir = path.join(workspace, 'not-a-dir')
    writeFileSync(notADir, 'x')
    // 这个计数是"路由真的走到了落点解析那一步"的证据：只有快照 ready 才会去问工作区，
    // 于是它排除了"tick 还没跑完所以答 none"这种假绿。
    let asked = 0
    const setupResult = setup({})
    const logs = LOGS()
    await withTimers(async () => {
      const handle = startSidebarQr(setupResult.ctx, {
        config: settings(fallback),
        pairing: () => pairingWith('dsh-rc://pair?psk=fake-psk', Date.now() + 60_000),
        workspaceOf: () => {
          asked += 1
          return notADir
        },
        log: logs.log,
        ...ACTION_DEPS,
      })
      await waitFor(async () => {
        const got = await askRoute(routeAt(setupResult.routes, PAIRING_ROUTE), '/?session=sess-1')
        return asked > 0 ? got : undefined
      })
      const answer = await askRoute(routeAt(setupResult.routes, PAIRING_ROUTE), '/?session=sess-1')
      assert.deepEqual(answer.body, { state: 'none' })
      assert.equal(existsSync(fallback), false, '兜底位置也不该被写：写不成就不该交地址')
      handle.stop()
    })
  } finally {
    cleanup()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('过期的码：路由一直答 none，且绝不落盘', async () => {
  const { file, cleanup } = tempImageFile()
  try {
    const setupResult = setup({})
    const logs = LOGS()
    await withTimers(async () => {
      const handle = startSidebarQr(setupResult.ctx, {
        config: settings(file),
        pairing: () => pairingWith('dsh-rc://pair?psk=fake-psk', Date.now() - 1),
        workspaceOf: () => undefined,
        log: logs.log,
        ...ACTION_DEPS,
      })
      await new Promise((resolve) => setTimeout(resolve, 120))
      const answer = await askRoute(routeAt(setupResult.routes, PAIRING_ROUTE), '/?session=sess-1')
      assert.deepEqual(answer, { status: 200, body: { state: 'none' } })
      assert.equal(existsSync(file), false, '过期的码不该写出任何文件')
      handle.stop()
    })
  } finally {
    cleanup()
  }
})

test('没有 webServer：什么都不做（图落了盘也没人知道地址），并把原因留在 probe 里', async () => {
  const { file, cleanup } = tempImageFile()
  try {
    const setupResult = setup({ web: false })
    const logs = LOGS()
    await withTimers((captured) => {
      const handle = startSidebarQr(setupResult.ctx, {
        config: settings(file),
        pairing: () => pairingWith('dsh-rc://pair?psk=fake-psk', Date.now() + 60_000),
        workspaceOf: () => undefined,
        log: logs.log,
        ...ACTION_DEPS,
      })
      assert.equal(setupResult.routes.length, 0)
      assert.equal(captured.ticks.length, 0)
      assert.equal(existsSync(file), false, '没起就别写盘')
      // 这条是"二维码不弹"的排查入口：probe 必须说清是没探到，而不是沉默。
      assert.equal(handle.probe.webServer, 'none')
      handle.stop()
    })
  } finally {
    cleanup()
  }
})

test('服务改从 inject 回调（作用域上下文）里拿：同样能起', async () => {
  const { file, cleanup } = tempImageFile()
  try {
    const setupResult = setup({ get: false, scopedInject: true })
    const logs = LOGS()
    await withTimers((captured) => {
      const handle = startSidebarQr(setupResult.ctx, {
        config: settings(file),
        pairing: () => null,
        workspaceOf: () => undefined,
        log: logs.log,
        ...ACTION_DEPS,
      })
      assert.equal(setupResult.routes.length, 4, '四条路由一起挂上')
      assert.equal(captured.ticks.length, 1)
      assert.equal(handle.probe.webServer, 'via inject')
      handle.stop()
    })
  } finally {
    cleanup()
  }
})

test('探到的对象没有 register()：不收，probe 写明形状不对', async () => {
  const { file, cleanup } = tempImageFile()
  try {
    const ctx: Record<string, unknown> = { get: () => ({ notRegister: true }) }
    const logs = LOGS()
    await withTimers((captured) => {
      const handle = startSidebarQr(ctx, {
        config: settings(file),
        pairing: () => null,
        workspaceOf: () => undefined,
        log: logs.log,
        ...ACTION_DEPS,
      })
      assert.equal(captured.ticks.length, 0, '形状不对就不要起节拍')
      assert.equal(handle.probe.webServer, 'object without register()')
      handle.stop()
    })
  } finally {
    cleanup()
  }
})

test('探测本身抛错（宿主 ctx 是 Proxy，读不存在的属性会抛）：绝不向外抛', () => {
  const ctx: Record<string, unknown> = {
    get: () => {
      throw new Error('cannot get property "webServer" without inject')
    },
    inject: () => {
      throw new Error('cannot get property "inject" without inject')
    },
  }
  const logs = LOGS()
  assert.doesNotThrow(() => {
    const handle = startSidebarQr(ctx, {
      config: settings('/tmp/whatever.png'),
      pairing: () => null,
      workspaceOf: () => undefined,
      log: logs.log,
      ...ACTION_DEPS,
    })
    // 抛过也要留下痕迹：'get threw: …' 是唯一能区分"这代宿主没这服务"和"我们读错了"的证据。
    assert.ok(String(handle.probe.webServer).startsWith('get threw:'))
    handle.stop()
  })
})

test('取码那句抛错：节拍继续、不外抛，只记一行', async () => {
  const { file, cleanup } = tempImageFile()
  try {
    const setupResult = setup({})
    const logs = LOGS()
    await withTimers(async (captured) => {
      const handle = startSidebarQr(setupResult.ctx, {
        config: settings(file),
        pairing: () => {
          throw new Error('slots 被拆了')
        },
        workspaceOf: () => undefined,
        log: logs.log,
        ...ACTION_DEPS,
      })
      assert.equal(captured.ticks.length, 1)
      await captured.ticks[0]!()
      assert.ok(
        logs.lines.some((line) => line.includes('read pairing state failed')),
        '读码失败要留痕：' + logs.lines.join(' | '),
      )
      handle.stop()
    })
  } finally {
    cleanup()
  }
})

test('disabled：直接不做事，probe 写明原因', async () => {
  const setupResult = setup({})
  const logs = LOGS()
  await withTimers((captured) => {
    const handle = startSidebarQr(setupResult.ctx, {
      config: settings('/tmp/whatever.png', false),
      pairing: () => null,
      workspaceOf: () => undefined,
      log: logs.log,
      ...ACTION_DEPS,
    })
    assert.equal(setupResult.routes.length, 0)
    assert.equal(captured.ticks.length, 0)
    assert.equal(handle.probe.sidebar, 'disabled')
    handle.stop()
  })
})

test('stop()：路由与节拍一起收回，且幂等', async () => {
  const { file, cleanup } = tempImageFile()
  try {
    const setupResult = setup({})
    const logs = LOGS()
    await withTimers((captured) => {
      const handle = startSidebarQr(setupResult.ctx, {
        config: settings(file),
        pairing: () => null,
        workspaceOf: () => undefined,
        log: logs.log,
        ...ACTION_DEPS,
      })
      assert.equal(setupResult.unregistered(), 0)
      handle.stop()
      assert.equal(setupResult.unregistered(), 4, '四条路由都要注销')
      assert.equal(captured.cleared, 1, '节拍要清掉')
      // 重复调用是幂等的（宿主可能既 dispose fiber 又走停机路径）。
      handle.stop()
      assert.equal(setupResult.unregistered(), 4)
      assert.equal(captured.cleared, 1)
    })
  } finally {
    cleanup()
  }
})

test('register() 自己抛错：不起节拍、probe 留痕、不外抛', async () => {
  const { file, cleanup } = tempImageFile()
  try {
    const ctx: Record<string, unknown> = {
      get: () => ({
        register: () => {
          throw new Error('这个路由名已经被占了')
        },
      }),
    }
    const logs = LOGS()
    await withTimers((captured) => {
      const handle = startSidebarQr(ctx, {
        config: settings(file),
        pairing: () => null,
        workspaceOf: () => undefined,
        log: logs.log,
        ...ACTION_DEPS,
      })
      assert.equal(captured.ticks.length, 0, '路由没挂上就不该起节拍')
      assert.ok(String(handle.probe.route).startsWith('register threw'))
      handle.stop()
    })
  } finally {
    cleanup()
  }
})

test('pill 那三条挂不上：右栏自动弹码照旧起（不能被新特性拖死），但 available 为 false', async () => {
  const { file, cleanup } = tempImageFile()
  try {
    const routes: Route[] = []
    let unregistered = 0
    const ctx: Record<string, unknown> = {
      get: () => ({
        register: (route: Route) => {
          if (route.path !== PAIRING_ROUTE) throw new Error('这两条路径宿主不给挂')
          routes.push(route)
          return () => {
            unregistered += 1
          }
        },
      }),
    }
    const logs = LOGS()
    await withTimers(async (captured) => {
      const handle = startSidebarQr(ctx, {
        config: settings(file),
        pairing: () => pairingWith('dsh-rc://pair?psk=fake-psk', Date.now() + 60_000),
        workspaceOf: () => undefined,
        log: logs.log,
        ...ACTION_DEPS,
      })
      assert.equal(routes.length, 1, '只读状态那条仍要挂着')
      assert.equal(handle.probe.route, 'registered')
      assert.ok(String(handle.probe.actions).startsWith('register threw'))
      assert.equal(captured.ticks.length, 1, '右栏那半该继续跑节拍')
      // 这条就是主插件据此把 `/drc pair` 注册回来的信号：pill 点不开就是"点一下配对"没成。
      assert.equal(handle.available, false)
      await captured.ticks[0]!()
      const answer = await askRoute(routeAt(routes, PAIRING_ROUTE), '/?session=sess-1')
      assert.equal(answer.status, 200, '右栏那条路由仍是活的：' + JSON.stringify(answer))
      handle.stop()
      assert.equal(unregistered, 1, '挂上的那条要收回；没挂上的不该留下半个注销')
    })
  } finally {
    cleanup()
  }
})
