/**
 * presentation-pair-actions.test — 状态栏 pill 那三条路由的判据。
 *
 * 这三条与右栏那条**不同一档安全姿态**，所以断言也各自一份：
 * `POST /pairing/new` 会改状态（向中继申请一张新码），因此 Origin 缺席也要拒；
 * `GET /pairing.png` 与 `GET /status` 只读，Origin 缺席放过，但 Host 仍必须环回。
 *
 * 最重要的一条不是"能发码"，而是**响应里绝不能出现凭据**：`psk` 与完整 `qr` URI
 * 一旦经这条路由出去，就等于把"PSK 从不上网"这条红线（D1）从浏览器面捅了个洞。
 * 所以这里既断言字段集合，也把整段响应文本拿去比对凭据子串。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  PAIR_IMAGE_ROUTE,
  PAIR_NEW_ROUTE,
  PAIR_STATUS_ROUTE,
  pairImageHandler,
  pairNewHandler,
  pillStatusHandler,
  registerPairActionRoutes,
  type LivePairing,
  type PairActionDeps,
} from '../src/presentation/pair-actions.js'
import { pairingEpoch } from '../src/presentation/presenter.js'

const FAKE_PSK = 'A'.repeat(64)
const FAKE_TOKEN = '482913'
const FAKE_QR = `dshr:/p?v=1&s=ws://relay&n=host&psk=${FAKE_PSK}&t=${FAKE_TOKEN}`

interface Reply {
  status: number
  headers: Record<string, unknown>
  body: string
  ended: boolean
}

function response(): { res: ServerResponse; reply: () => Reply } {
  const captured: Reply = { status: 0, headers: {}, body: '', ended: false }
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) {
      captured.status = status
      captured.headers = { ...(headers ?? {}) }
      return res
    },
    end(chunk?: unknown) {
      captured.body = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''
      captured.ended = true
      return res
    },
  } as unknown as ServerResponse
  return { res, reply: () => captured }
}

function request(method: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method, url: '/', headers } as unknown as IncomingMessage
}

const LOOPBACK = { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' }

function deps(over: Partial<PairActionDeps> = {}): PairActionDeps & { calls: { ensure: number; current: number } } {
  const calls = { ensure: 0, current: 0 }
  const live: LivePairing = { qr: FAKE_QR, token: FAKE_TOKEN, expiresAt: Date.now() + 60_000 }
  return {
    calls,
    ensureFresh: () => {
      calls.ensure += 1
      return live
    },
    current: () => {
      calls.current += 1
      return live
    },
    renderPng: async () => Buffer.from('png-bytes'),
    status: () => ({ relay: 'online', paired: 1, hasCode: true }),
    log: () => {},
    ...over,
  }
}

// ── POST /pairing/new ────────────────────────────────────────────────

test('点一下发码：回 state/epoch/token/剩余寿命，epoch 与 pairingEpoch 同一个口径', async () => {
  const d = deps()
  const { res, reply } = response()
  await pairNewHandler(d)(request('POST', LOOPBACK), res)
  const got = reply()
  assert.equal(got.status, 200)
  const body = JSON.parse(got.body) as Record<string, unknown>
  assert.equal(body.state, 'ready')
  assert.equal(body.token, FAKE_TOKEN, '6 位码要给——弹窗上"或手输这 6 位数字"靠它')
  assert.equal(body.epoch, pairingEpoch(FAKE_QR), 'epoch 必须是同一个哈希口径，否则弹窗会以为每次都是新码')
  assert.ok(typeof body.expiresInMs === 'number' && (body.expiresInMs as number) > 0)
})

test('响应里绝不含凭据：psk 与完整 qr URI 一个字都不许出现', async () => {
  const d = deps()
  const { res, reply } = response()
  await pairNewHandler(d)(request('POST', LOOPBACK), res)
  const raw = reply().body
  assert.ok(!raw.includes(FAKE_PSK), `响应里出现了 PSK：${raw}`)
  assert.ok(!raw.includes(FAKE_QR), `响应里出现了完整配对 URI：${raw}`)
  assert.ok(!raw.includes('psk'), `响应字段里出现了 psk 字样：${raw}`)
  assert.ok(!raw.includes('dshr:'), `响应里出现了配对 URI 的前缀：${raw}`)
})

test('幂等：连点两次只问一次，屏幕上不会挂出两张有效码', async () => {
  const d = deps()
  for (let i = 0; i < 2; i += 1) {
    const { res, reply } = response()
    await pairNewHandler(d)(request('POST', LOOPBACK), res)
    assert.equal(reply().status, 200)
  }
  // ensureFresh 本身就是"有就回原码"，所以这里数的是路由有没有绕过它去另发一张。
  assert.equal(d.calls.ensure, 2, '两条请求各问一次幂等入口（幂等语义在 ensureFresh 里面，那里另有单测）')
})

test('GET 打开发码路由 → 405：这条只接受 POST', async () => {
  const d = deps()
  const { res, reply } = response()
  await pairNewHandler(d)(request('GET', LOOPBACK), res)
  assert.equal(reply().status, 405)
  assert.equal(d.calls.ensure, 0, '被拒的请求绝不能已经先把码发出去了')
})

test('Origin 缺席 → 403（写路由不吃"没带就当作同源"这套推断）', async () => {
  const d = deps()
  const { res, reply } = response()
  await pairNewHandler(d)(request('POST', { host: '127.0.0.1:19387' }), res)
  assert.equal(reply().status, 403)
  assert.equal(d.calls.ensure, 0, '被拦下的请求不许改状态')
})

test('跨站 Origin 与非环回 Host 都 → 403', async () => {
  for (const headers of [
    { host: '127.0.0.1:19387', origin: 'https://evil.example.com' },
    { host: 'evil.example.com', origin: 'http://127.0.0.1:19387' },
    { host: 'attacker.local:8787', origin: 'http://localhost:8787' },
  ]) {
    const d = deps()
    const { res, reply } = response()
    await pairNewHandler(d)(request('POST', headers), res)
    assert.equal(reply().status, 403, `${JSON.stringify(headers)} 应当被拒`)
    assert.deepEqual(JSON.parse(reply().body), { error: 'request-not-trusted' })
    assert.equal(d.calls.ensure, 0)
  }
})

test('中继不在线：200 + state:"unavailable"，不是 500（pill 要能显示"未连接"）', async () => {
  const d = deps({ ensureFresh: () => null })
  const { res, reply } = response()
  await pairNewHandler(d)(request('POST', LOOPBACK), res)
  assert.equal(reply().status, 200)
  assert.deepEqual(JSON.parse(reply().body), { state: 'unavailable', reason: 'relay-offline' })
})

// ── GET /pairing.png ────────────────────────────────────────────────

test('有码时图片路由回 PNG + no-store + ETag 是这一版的 epoch', async () => {
  const d = deps()
  const { res, reply } = response()
  await pairImageHandler(d)(request('GET', { host: '127.0.0.1:19387' }), res)
  const got = reply()
  assert.equal(got.status, 200)
  assert.equal(got.headers['Content-Type'], 'image/png')
  assert.equal(got.headers['Cache-Control'], 'no-store', '一张码会被就地换掉，缓存等于弹窗里停在废码上')
  assert.equal(got.headers.ETag, `"${pairingEpoch(FAKE_QR)}"`)
  assert.equal(got.body, 'png-bytes')
  assert.equal(d.calls.ensure, 0, '看图不许顺手发码')
})

test('没有效码 → 204（路由在、只是现在没码），不是 404', async () => {
  const d = deps({ current: () => null })
  const { res, reply } = response()
  await pairImageHandler(d)(request('GET', { host: '127.0.0.1:19387' }), res)
  assert.equal(reply().status, 204)
  assert.equal(reply().ended, true)
})

test('图片路由只读：Origin 缺席放过，但非环回 Host 仍拒', async () => {
  const noOrigin = deps()
  const a = response()
  await pairImageHandler(noOrigin)(request('GET', { host: 'localhost:19387' }), a.res)
  assert.equal(a.reply().status, 200, '同源 GET 常常不带 Origin，只读路由不该因此拒')

  const badHost = deps()
  const b = response()
  await pairImageHandler(badHost)(request('GET', { host: 'evil.example.com' }), b.res)
  assert.equal(b.reply().status, 403)
})

test('HEAD 不写 body（宿主可能用它探活）', async () => {
  const d = deps()
  const { res, reply } = response()
  await pairImageHandler(d)(request('HEAD', { host: '127.0.0.1:19387' }), res)
  assert.equal(reply().status, 200)
  assert.equal(reply().body, '')
})

test('渲染抛错 → 500 且带截断后的原因，不抛到宿主', async () => {
  const d = deps({
    renderPng: () => {
      throw new Error('boom'.repeat(200))
    },
  })
  const { res, reply } = response()
  await pairImageHandler(d)(request('GET', { host: '127.0.0.1:19387' }), res)
  assert.equal(reply().status, 500)
  assert.ok((JSON.parse(reply().body).error as string).length <= 200)
})

// ── GET /status（pill 抬头那句连接状态）──────────────────────────────

test('状态路由只出三个非凭据字段：relay / paired / hasCode', async () => {
  const d = deps()
  const { res, reply } = response()
  await pillStatusHandler(d)(request('GET', { host: '127.0.0.1:19387' }), res)
  const got = reply()
  assert.equal(got.status, 200)
  assert.deepEqual(JSON.parse(got.body), { relay: 'online', paired: 1, hasCode: true })
  const raw = got.body
  for (const secret of [FAKE_PSK, FAKE_QR, FAKE_TOKEN, 'dshr:']) {
    assert.ok(!raw.includes(secret), `状态回答里出现了 ${secret}：${raw}`)
  }
  assert.equal(d.calls.ensure, 0, '看状态绝不顺手发码')
})

test('runtime 还没起来时 relay 是 idle，不是 offline（pill 要说的是"没启动"而不是"断了"）', async () => {
  const d = deps({ status: () => ({ relay: 'idle', paired: 0, hasCode: false }) })
  const { res, reply } = response()
  await pillStatusHandler(d)(request('GET', { host: '127.0.0.1:19387' }), res)
  assert.deepEqual(JSON.parse(reply().body), { relay: 'idle', paired: 0, hasCode: false })
})

test('状态路由是只读的：Origin 缺席放过，非环回 Host 仍拒，POST 拒', async () => {
  const noOrigin = deps()
  const a = response()
  await pillStatusHandler(noOrigin)(request('GET', { host: 'localhost:19387' }), a.res)
  assert.equal(a.reply().status, 200)

  const badHost = deps()
  const b = response()
  await pillStatusHandler(badHost)(request('GET', { host: 'evil.example.com' }), b.res)
  assert.equal(b.reply().status, 403)

  const written = deps()
  const c = response()
  await pillStatusHandler(written)(request('POST', LOOPBACK), c.res)
  assert.equal(c.reply().status, 405)
})

test('status() 自己抛错 → 500 且不外抛到宿主', async () => {
  const d = deps({
    status: () => {
      throw new Error('relay 被拆了')
    },
  })
  const { res, reply } = response()
  await pillStatusHandler(d)(request('GET', { host: '127.0.0.1:19387' }), res)
  assert.equal(reply().status, 500)
})

// ── 注册与注销 ───────────────────────────────────────────────────────

test('注册挂上三条、注销把三条都摘掉', () => {
  const registered: string[] = []
  let off = 0
  const web = {
    register: (route: { path: string }) => {
      registered.push(route.path)
      return () => {
        off += 1
      }
    },
  }
  const unregister = registerPairActionRoutes(web as never, deps())
  assert.deepEqual(registered, [PAIR_NEW_ROUTE, PAIR_IMAGE_ROUTE, PAIR_STATUS_ROUTE])
  unregister()
  assert.equal(off, 3)
})

test('一条注销抛错不许让其余留在宿主上', () => {
  let off = 0
  const web = {
    register: () => () => {
      off += 1
      if (off === 1) throw new Error('宿主已经先拆了')
    },
  }
  const unregister = registerPairActionRoutes(web as never, deps())
  assert.doesNotThrow(() => unregister())
  assert.equal(off, 3, '后两条必须仍然被调用')
})

test('反证：把写路由的 Origin 判据退回"缺席也放过"，那条 403 立刻失去牙齿', async () => {
  // 这条是给自己看的：上面"Origin 缺席 → 403"的断言依赖 originMustBeLoopback。
  // 若有人把它改回只读那套（`originIsLoopback`），这里必须显形。
  const d = deps()
  const { res, reply } = response()
  await pairNewHandler(d)(request('POST', { host: '127.0.0.1:19387' }), res)
  assert.equal(reply().status, 403, '写路由对缺席 Origin 必须拒；这一条变绿就说明守卫被放松了')
  assert.equal(d.calls.ensure, 0)
})
