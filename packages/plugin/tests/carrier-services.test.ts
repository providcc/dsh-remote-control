import type { KernelEvent } from '../src/ports/index.js'
/**
 * carrier-services.test — `platform/carrier-services.ts` 的内核调用形状。
 *
 * `core/` 那几层测的是"该发什么"，这一层测的是**调内核时到底传了什么参数**。
 * 这里每一条都对应一次真机取证或一条已归档的权威签名
 * （`docs/legacy-spec/host-plugin-cordis.md` §3 表）：
 *
 * 1. `agents.resume({resumeSessionId, agentOptions})`——**agentOptions 不能省**。
 *    省掉它建出来的 Agent 没有 call configuration，回合在 prompt 装配阶段就死：
 *    `prompt variable "{{model}}" has no value for this assembly`，
 *    手机上表现为"发出去、转两下、一个字都没有"。这是 live-e2e 在本机抓到的第一条真缺陷。
 * 2. 取消的正解是 `agent.cancel({kind:'user'}, {keepInbox:true})`，
 *    **不是** `abort()`/`interrupt()`（那两个符号在全树零命中；复核 R8⑨）。
 * 3. 没有可用模型时必须**在任何内核调用之前**主动拒绝，而不是让宿主去崩
 *    （`prepareRequest` 里抛 `reading 'provider'`，那条崩溃看起来与远程控制毫无关系）。
 *
 * 夹具是一个手搓的 `ServicesBundle`：本层的全部价值就在于"传了什么"能被逐字记下来，
 * 所以这里用记录调用的假服务对象，而不是真内核。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServicesKernel, historyPageFromLog, type ServicesBundle } from '../src/platform/carrier-services.js'
import { FakeClock } from '../src/core/clock.js'
import { parseEvPayload } from 'dsh-remote-wire'
import { questionRequest } from 'dsh-remote-wire'

interface Calls {
  resume: Array<Record<string, unknown>>
  unarchive: string[]
  followup: unknown[]
  steer: unknown[]
  cancel: unknown[][]
}

interface Fixture {
  calls: Calls
  /** 活的 agent 是**同一个对象**：测试要能在它身上删成员（每次 get 返回新对象的话删了也没用）。 */
  readonly liveAgent: Record<string, unknown>
  bundle(overrides?: { live?: boolean; model?: { provider: string; model: string } | undefined }): ServicesBundle
  kernel(services: ServicesBundle): ReturnType<typeof createServicesKernel>
}

function fixture(options: { newSessionCwd?: string } = {}): Fixture {
  const calls: Calls = { resume: [], unarchive: [], followup: [], steer: [], cancel: [] }
  const clock = new FakeClock()
  const liveAgent: Record<string, unknown> = {
    followup: (message: unknown) => calls.followup.push(message),
    steer: (message: unknown) => calls.steer.push(message),
    cancel: (...args: unknown[]) => calls.cancel.push(args),
  }
  const bundle = (
    overrides: { live?: boolean; model?: { provider: string; model: string } | undefined } = {},
  ): ServicesBundle => {
    const live = overrides.live ?? false
    const model = 'model' in overrides ? overrides.model : { provider: 'stepfun', model: 'step-5-preview' }
    return {
      sessions: { list: () => [], get: () => undefined },
      agents: {
        get: () => (live ? liveAgent : undefined),
        resume: (request: Record<string, unknown>) => {
          calls.resume.push(request)
          return Promise.resolve({ agent: liveAgent })
        },
      },
      agentDefaultModel: model ? { currentSelection: () => model } : {},
      workspaceRegistry: {
        archivedSessionIds: ['ses_arch'],
        unarchiveSession: (id: string) => {
          calls.unarchive.push(id)
          return Promise.resolve()
        },
      },
    }
  }
  return {
    calls,
    liveAgent,
    bundle,
    kernel: (services) =>
      createServicesKernel(services, { clock, log: () => {}, newSessionCwd: options.newSessionCwd }),
  }
}

test('冷会话续跑必须带 agentOptions：不带模型续出来的 Agent 会让整回合在装配阶段死掉', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle())
  const ready = await kernel.ensureRunnable?.('ses_idle')
  assert.equal(ready?.ok, true, `续跑被拒：${JSON.stringify(ready)}`)
  assert.equal(f.calls.resume.length, 1, '没有调用 agents.resume：会话根本没被唤醒')
  const request = f.calls.resume[0] as {
    resumeSessionId?: string
    agentOptions?: { provider?: string; model?: string }
  }
  assert.equal(request.resumeSessionId, 'ses_idle', 'resumeSessionId 逐字传')
  assert.equal(
    request.agentOptions?.provider,
    'stepfun',
    'agentOptions.provider 缺失：这就是手机上"一个字都没有"的根因',
  )
  assert.equal(request.agentOptions?.model, 'step-5-preview', 'agentOptions.model 缺失：同上')
})

test('已经有活的 agent 就不许再 resume（每条指令都重建一次 agent 会丢掉会话内状态）', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true }))
  const ready = await kernel.ensureRunnable?.('ses_live')
  assert.equal(ready?.ok, true)
  assert.equal(f.calls.resume.length, 0, `白 resume 了 ${f.calls.resume.length} 次`)
})

test('拿不到模型选择时必须拒绝续跑，并且一次内核调用都不发', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ model: undefined }))
  const ready = await kernel.ensureRunnable?.('ses_idle')
  assert.equal(ready?.ok, false, '没模型也照样 resume：宿主会在 prepareRequest 里抛 reading provider')
  assert.match(ready?.message ?? '', /模型/, '拒绝原因必须是中文且点名模型，否则手机上只有一句看不懂的英文')
  assert.equal(f.calls.resume.length, 0, '拒绝之前已经把 agent 建出来了：这条拒绝就成了空话')
  const sent = await kernel.sendPrompt('ses_live', '跑一下')
  assert.equal(sent.ok, false, '没模型也发指令：turn 会以 error 收场，而手机看不出来')
  assert.equal(f.calls.followup.length, 0)
})

test('归档会话：先 unarchive 再 resume，顺序不能反', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle())
  await kernel.ensureRunnable?.('ses_arch')
  assert.deepEqual(
    f.calls.unarchive,
    ['ses_arch'],
    '没先解归档：宿主的 archived-session-gate 会在 agent/pre-step 直接拒掉',
  )
  assert.equal(f.calls.resume.length, 1)
  assert.ok(f.calls.unarchive.length > 0, 'unarchive 必须在 resume 之前发生')
})

test('发指令优先 followup；没有 followup 才退到 steer（两者都没有要把 keys 报出来）', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true }))
  const sent = await kernel.sendPrompt('ses_live', '只回复 ok')
  assert.equal(sent.ok, true)
  assert.equal(f.calls.followup.length, 1, '有 followup 却走了别的路：followup 才是"排到下一轮"的正解')
  assert.equal(f.calls.steer.length, 0, 'followup 存在时不该用 steer（steer 是插进当前步）')
  const message = f.calls.followup[0] as { content?: Array<{ type: string; text?: string }> }
  const text = (message?.content ?? []).map((part) => part.text ?? '').join('')
  assert.equal(text, '只回复 ok', '正文必须逐字进 content：官方 apiproxy 就是 createUserMessage({content,source})')

  // 只给 steer 的一代宿主
  const steerOnly = fixture()
  delete steerOnly.liveAgent.followup
  const sent2 = await steerOnly.kernel(steerOnly.bundle({ live: true })).sendPrompt('ses_live', '换个路径')
  assert.equal(sent2.ok, true)
  assert.equal(steerOnly.calls.steer.length, 1, '没 followup 时应退回 steer')

  // 两个都没有：必须把实际形状报出来，而不是静默失败
  const neither = fixture()
  delete neither.liveAgent.followup
  delete neither.liveAgent.steer
  const sent3 = await neither.kernel(neither.bundle({ live: true })).sendPrompt('ses_live', '发不出去')
  assert.equal(sent3.ok, false)
  assert.match(sent3.message ?? '', /keys=\[/, '两个方法都没有时要列出 keys，现场才能判断这一代宿主给了什么')
})

test('中断走 cancel({kind:"user"}, {keepInbox:true})：abort/interrupt 这两个符号在平台上不存在（复核 R8⑨）', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true }))
  const done = await kernel.interrupt('ses_live')
  assert.equal(done.ok, true)
  assert.equal(f.calls.cancel.length, 1, '没走 cancel：手机点了"停止"而内核什么都没发生')
  assert.deepEqual(
    f.calls.cancel[0],
    [{ kind: 'user' }, { keepInbox: true }],
    'cancel 的参数形状必须逐字对：keepInbox 丢了会把已排队的指令一起吞掉',
  )
})

test('modelSelection 与发指令读的是同一条路径（两处各写一遍迟早分叉）', () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle())
  assert.deepEqual(kernel.modelSelection?.(), { provider: 'stepfun', model: 'step-5-preview' })
  const missing = fixture()
  const kernel2 = missing.kernel(missing.bundle({ model: undefined }))
  assert.equal(
    kernel2.modelSelection?.(),
    undefined,
    '没有 currentSelection 时必须返回 undefined，而不是抛或给半个对象',
  )
})

/**
 * 这条测的是"插件绝不带崩宿主"那一条红线在现场的形状。
 *
 * `guardedSubscribe` 只保护**注册**那一步；回调本体是裸交给 cordis 的 emit 的。
 * 一次抛出（下游 runtime/transport 里任何一环都可能）会打断这条事件的派发，
 * 严重时整条订阅被拆掉——真机表现是"回合跑到一半再也没事件"，而 status.json 一片祥和。
 * 所以：不许把异常抛回去，并且必须留下可查的痕迹。
 */
test('事件回调里的异常不许冒回内核，且必须进 status.json 的 kernel.listenerErrors', () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  kernel.subscribe(() => {
    throw new Error('下游炸了')
  })
  const sessionEvent = listeners['session/event']
  assert.ok(sessionEvent, 'session/event 没订阅上：白名单或注册口出问题')
  assert.doesNotThrow(
    () => sessionEvent({ id: 'ses_live' }, { type: 'turn/start', data: { turn: 3 } }),
    '我们的监听器把异常抛回了 cordis 的 emit：这一代 cordis 会因此拆掉整条订阅',
  )
  const described = kernel.describe() as Record<string, unknown>
  assert.match(String(described.listenerErrors), /下游炸了/, '抛错没进 status.json：线上只能靠猜')
  assert.match(String(described.listenerErrors), /^\d+×/, '要带次数：同一处抛一万次与抛一次是完全不同的问题')
})

test('人工交互两面的登记结果必须能从 status.json 读出来（审批卡没弹时的分诊入口）', () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  const listenerOptions: Record<string, unknown> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void, options?: unknown) => {
    listeners[name] = listener
    listenerOptions[name] = options
    return () => {}
  }
  const kernel = f.kernel(services)
  assert.equal(
    (kernel.describe() as Record<string, unknown>).approvalFace,
    'not-attached',
    '还没挂 sink 就说"已登记"：这条字段就成了谎',
  )
  const detach = kernel.attachInteractionSink!({ approval: async () => 'allowed-once', question: async () => null })
  const described = kernel.describe() as Record<string, unknown>
  // 审批是 **waterfall 参与者**，登记动作就是 `on('approval/request', …)`。
  assert.ok(listeners['approval/request'], '没有真正登记 approval/request 参与者')
  assert.equal(described.approvalFace, 'registered', `审批面登记状态读不出真值：${String(described.approvalFace)}`)
  // **这两个选项各治一种"卡没弹"，摘掉任何一个真机都会瞎**：
  // `global` 管"不被作用域过滤掉"，`prepend` 管"排在桌面那位应答者前面"
  // （waterfall 里第一个 hook 是外层，外层不 next() 内层永远轮不到）。
  assert.deepEqual(
    listenerOptions['approval/request'],
    { global: true, prepend: true },
    'approval/request 没带 {global:true, prepend:true}：前者会被 cordis 过滤掉，后者会排在桌面 UI 后面永远轮不到',
  )
  // 提问那条**也是参与者**（2026-10-04 改的）：以前它走 `userQuestions.registerProvider`
  // 那个单提供者口——那一代宿主上根本没有这个成员，而且"接管"意味着桌面问不了问题。
  // 现在它和审批共用同一条参与式实现，所以两个名字都要登记上、选项也要一模一样。
  assert.ok(
    listeners['user-questions/request'],
    '没有登记 user-questions/request 参与者：手机上永远不会有提问卡，而桌面的提问能力也不该被顶掉',
  )
  assert.equal(described.questionsFace, 'registered', `提问面登记状态读不出真值：${String(described.questionsFace)}`)
  assert.deepEqual(
    listenerOptions['user-questions/request'],
    { global: true, prepend: true },
    'user-questions/request 没带同一组选项：提问那条也是按 scopeTarget(agent, agent) 派发的，少了 global 就收不到',
  )
  detach()
})

/**
 * 真机上"审批卡没弹"有两种根因，现场长得一模一样，只有审计面能把它们分开：
 * 整条 waterfall 没人答（我们没被派发）vs 别人抢先答了（我们排在后面）。
 * 所以内核报的 `approval/asked` / `approval/decided` 必须原样进 status.json。
 */
test('审批审计面的两个落点要进 status.json：asked 计次、decided 记 outcome', () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  kernel.subscribe(() => {})
  const fire = listeners['session/event']
  assert.ok(fire, 'session/event 没订阅上')
  const described0 = kernel.describe() as Record<string, unknown>
  assert.equal(described0.approvalAsked, 0, '一次都没问过，计数就该是 0')
  assert.equal(described0.approvalDecided, 'not-seen', '没收到 decided 时要说 not-seen，不能空着让人以为答过了')
  fire({ id: 'ses_live' }, { type: 'approval/asked', data: { id: 'ap_1', toolName: 'write_file' } })
  fire({ id: 'ses_live' }, { type: 'approval/decided', data: { id: 'ap_1', outcome: 'unavailable' } })
  fire({ id: 'ses_live' }, { type: 'approval/asked', data: { id: 'ap_2', toolName: 'bash' } })
  fire({ id: 'ses_live' }, { type: 'approval/decided', data: { id: 'ap_2', outcome: 'rejected' } })
  const described = kernel.describe() as Record<string, unknown>
  assert.equal(described.approvalAsked, 2, `问过两次却报 ${String(described.approvalAsked)}`)
  assert.equal(described.approvalDecided, 'rejected', 'decided 要记**最后一次**的 outcome：它就是"谁答的"的证据')
})

/**
 * `approvalFace='registered'` 只说明"挂上去了"，不说明"收得到"。
 * 这两条把"收到之后走到哪一步"也钉成字段：真机上再出现审批卡没弹，
 * 看 `approvalCalls` 是 0 还是 >0 就能一句话分掉两半。
 */
test('审批 waterfall 被调用时要留下次数与落点：手机答了就记 answered-by-phone', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  const asked: string[] = []
  kernel.attachInteractionSink!({
    approval: async (info: { sessionId: string; action: string }) => {
      asked.push(`${info.sessionId}/${info.action}`)
      return 'allowed-once'
    },
    question: async () => null,
  })
  assert.equal((kernel.describe() as Record<string, unknown>).approvalCalls, 0, '一次都没派发，计数不该动')
  const outcome = await listeners['approval/request']!(
    { agent: { session: { id: 'ses_live' } }, toolName: 'write_file', reason: '要往工作区外写' },
    async () => 'unavailable',
  )
  assert.equal(outcome, 'allowed-once', '手机放行之后没把 outcome 交回瀑布')
  assert.deepEqual(asked, ['ses_live/write_file'], '交给 runtime 的会话与工具名不对：审批卡会问错东西')
  const described = kernel.describe() as Record<string, unknown>
  assert.equal(described.approvalCalls, 1, '调用次数没进 status.json：只能靠猜')
  assert.equal(
    described.approvalLast,
    'answered-by-phone(allowed-once)',
    `落点读不出来：${String(described.approvalLast)}`,
  )
})

test('拿不到会话或手机没答上时要交还桌面，并把"交还了"记进 status.json', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  let sinkCalls = 0
  kernel.attachInteractionSink!({
    approval: async () => {
      sinkCalls += 1
      return 'decline'
    },
    question: async () => null,
  })
  // ① 请求里没有会话 id（宿主换了字段形状）→ 不抢答，交还。
  const noSession = await listeners['approval/request']!({ toolName: 'write_file' }, async () => 'unavailable')
  assert.equal(noSession, 'unavailable', '没有会话 id 却自己答了：会把桌面 UI 的审批权抢掉')
  assert.equal(sinkCalls, 0, '没有会话 id 还去问手机')
  assert.equal(
    (kernel.describe() as Record<string, unknown>).approvalLast,
    'handed-back(no phone target)',
    '交还原因没进 status.json：下次又要从"为什么没弹"猜起',
  )
  // ② 手机超时（sink 回 decline）而链子末端也没人答 → 交还 'unavailable'，而不是替用户拒绝。
  const declined = await listeners['approval/request']!(
    { agent: { session: { id: 'ses_live' } }, toolName: 'write_file' },
    async () => 'unavailable',
  )
  assert.equal(declined, 'unavailable', '手机没答上时我们替用户拒绝：桌面那条链就该自己决定')
  assert.equal(sinkCalls, 1, '这一条该问到手机')
  assert.equal(
    (kernel.describe() as Record<string, unknown>).approvalLast,
    'handed-back(neither answered)',
    '交还原因没进 status.json：下次又要从"为什么没弹"猜起',
  )
  assert.equal((kernel.describe() as Record<string, unknown>).approvalCalls, 2)
})

/**
 * 这三条钉的是同一句红线：**插件不许改变宿主自己的行为**。
 * 2026-10-04 那次只 `prepend` 不自顾地等手机，结果"手机上弹了、桌面上不弹了"——
 * 用户当场要求两边都弹。所以形状必须是：一进函数就把 `next()` 叫起来，两边赛跑。
 */
test('手机先答也必须把链子交给桌面（next() 要跑到）——不许让 DSH 少弹一个窗', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  kernel.attachInteractionSink!({ approval: async () => 'allowed-once', question: async () => null })
  let nextCalls = 0
  const never = new Promise<string>(() => {})
  const outcome = await listeners['approval/request']!(
    { agent: { session: { id: 'ses_live' } }, toolName: 'write_file' },
    () => {
      nextCalls += 1
      return never
    },
  )
  assert.equal(outcome, 'allowed-once')
  assert.equal(nextCalls, 1, '手机先答就不叫 next()：桌面那一半整个不弹了，这是改变宿主行为')
})

test('桌面先答时手机那一侧必须被撤回（signal abort），落点记 answered-by-desktop', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  let phoneSignal: AbortSignal | undefined
  let releasePhone: (value: 'decline') => void = () => {}
  kernel.attachInteractionSink!({
    approval: async (info: { signal?: AbortSignal }) => {
      phoneSignal = info.signal
      // 手机一直没人点：桌面先答之后，这一侧必须被 abort 叫醒，而不是挂到 180s 超时。
      return new Promise<'decline'>((resolve) => {
        releasePhone = resolve
      })
    },
    question: async () => null,
  })
  let releaseDesktop: (value: string) => void = () => {}
  const pending = listeners['approval/request']!(
    { agent: { session: { id: 'ses_live' } }, toolName: 'write_file' },
    () =>
      new Promise<string>((resolve) => {
        releaseDesktop = resolve
      }),
  )
  await new Promise((resolve) => setImmediate(resolve))
  releaseDesktop('rejected')
  assert.equal(await pending, 'rejected', '桌面答了却不被采纳：等于我们把宿主的答案吞了')
  assert.equal(phoneSignal?.aborted, true, '桌面先答却没撤回手机那一侧：手机那张卡会继续倒计时，waiting 角标也不会归零')
  assert.equal(
    (kernel.describe() as Record<string, unknown>).approvalLast,
    'answered-by-desktop(rejected)',
    '落点要分得清是手机答的还是桌面答的——排错时这是两件事',
  )
  releasePhone('decline')
})

test('手机超时不算答案：桌面稍后给出的真决定必须赢（不许"手机没电=自动拒绝"）', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  kernel.attachInteractionSink!({ approval: async () => 'decline', question: async () => null })
  let releaseDesktop: (value: string) => void = () => {}
  const inflight = listeners['approval/request']!(
    { agent: { session: { id: 'ses_live' } }, toolName: 'write_file' },
    () =>
      new Promise<string>((resolve) => {
        releaseDesktop = resolve
      }),
  )
  await new Promise((resolve) => setImmediate(resolve))
  releaseDesktop('allowed-once')
  assert.equal(await inflight, 'allowed-once', '手机先超时就把这一问判掉，等于替桌面做了决定')
  assert.equal(
    (kernel.describe() as Record<string, unknown>).approvalLast,
    'answered-by-desktop(allowed-once)',
    `落点读错了：${String((kernel.describe() as Record<string, unknown>).approvalLast)}`,
  )
})

/**
 * 这三条钉的是**反方向**那一半：手机先答之后，桌面那张卡也得当场消失。
 *
 * 句柄只有一个：链子下游那份 `request.signal`。宿主的 api-gateway 在它的 signal 断掉时
 * 向每个渲染端推 `{type:'cancel', eventId}`，渲染端据此 `PendingApproval.abort()`
 * ——卡片由宿主自己的代码收，插件只是宣告"这次请求结束了"。
 * 所以这里要钉的是"我们有没有把那个句柄拿到手、并且在对的时刻按一下"。
 */
test('手机先答时必须撤销交给下游的那份 signal——那是关掉桌面那张卡的唯一句柄', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  let phoneSignal: AbortSignal | undefined
  kernel.attachInteractionSink!({
    approval: async (info: { signal?: AbortSignal }) => {
      phoneSignal = info.signal
      return 'allowed-once'
    },
    question: async () => null,
  })
  const platform = new AbortController()
  const request: { agent: { session: { id: string } }; toolName: string; signal?: AbortSignal } = {
    agent: { session: { id: 'ses_live' } },
    toolName: 'write_file',
    signal: platform.signal,
  }
  // 桌面那一半**在被调用时**才读 `request.signal`（网关的 `projected.signal` 就是这么取的），
  // 所以这里也在回调里读，而不是在调用之前读一份快照。
  let downstream: AbortSignal | undefined
  const pending = listeners['approval/request']!(request, () => {
    downstream = request.signal
    // 桌面上一直没人点：手机答完之后这张卡就靠我们那一下撤销来收。
    return new Promise<string>(() => {})
  })
  assert.equal(await pending, 'allowed-once')
  assert.notEqual(
    downstream,
    platform.signal,
    '下游拿到的还是原件那份 signal：手机答完之后没有任何句柄能关掉桌面那张卡',
  )
  assert.equal(downstream?.aborted, true, '换到了句柄却没撤销：桌面那张卡照样挂着')
  const described = kernel.describe() as Record<string, unknown>
  assert.equal(
    described.approvalSignalHandoff,
    'fused',
    `换 signal 的落点读不出来：${String(described.approvalSignalHandoff)}`,
  )
  assert.equal(
    described.approvalDesktopVoided,
    1,
    '这一次撤销没进 status.json：线上就只能靠屏幕猜"桌面那张卡到底收没收"',
  )
  // 撤销**只该往下游传**：runtime 那侧的 signal 跟着断的话，手机自己点掉的这次会被
  // 当成"被撤回"再作废一遍（`settle(id,'cancelled',…)` 会把答案盖掉）。
  assert.equal(phoneSignal?.aborted, false, '我们把下游撤销了，却连 runtime 那侧一起撤了：手机的答案会被自己作废')
})

test('平台自己中断时并算后的 signal 要保住原来的取消能力（reason 也要带下去）', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  let phoneSignal: AbortSignal | undefined
  kernel.attachInteractionSink!({
    approval: async (info: { signal?: AbortSignal }) => {
      phoneSignal = info.signal
      // 手机这一侧被撤回后就是"没人答"（runtime 会结掉它）。
      return new Promise<'decline'>((resolve) => {
        info.signal?.addEventListener('abort', () => resolve('decline'), { once: true })
      })
    },
    question: async () => null,
  })
  const platform = new AbortController()
  const request: { agent: { session: { id: string } }; toolName: string; signal?: AbortSignal } = {
    agent: { session: { id: 'ses_live' } },
    toolName: 'bash',
    signal: platform.signal,
  }
  let downstream: AbortSignal | undefined
  let releaseDesktop: (value: string) => void = () => {}
  const pending = listeners['approval/request']!(
    request,
    () =>
      new Promise<string>((resolve) => {
        downstream = request.signal
        releaseDesktop = resolve
      }),
  )
  await new Promise((resolve) => setImmediate(resolve))
  const reason = new Error('turn cancelled')
  platform.abort(reason)
  assert.equal(downstream?.aborted, true, '平台都中断了、下游那份却没跟着断：并算把宿主的取消能力换掉了')
  assert.equal(downstream?.reason, reason, 'reason 要原样带下去：渲染端靠它说明这张卡为什么消失')
  assert.equal(phoneSignal?.aborted, true, '手机那一侧同样要收到撤回，否则它会挂到超时')
  releaseDesktop('unavailable')
  assert.equal(await pending, 'unavailable', '平台中断且两边都没答时必须交还失败闭合（宿主自己判 cancelled）')
  assert.equal(
    (kernel.describe() as Record<string, unknown>).approvalDesktopVoided,
    0,
    '这一场不是手机答的，那颗计数器不该动',
  )
})

test('请求对象的 signal 不可写时不许抛：换不出去就退回"卡片等它自己的生命周期"', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  kernel.attachInteractionSink!({ approval: async () => 'allowed-once', question: async () => null })
  const request: { agent: { session: { id: string } }; toolName: string; signal?: AbortSignal } = {
    agent: { session: { id: 'ses_live' } },
    toolName: 'write_file',
  }
  // 冻结这一个字段（ESM 严格模式下赋值会**抛** TypeError，那一抛会顺着 waterfall 把宿主的审批判死）。
  Object.defineProperty(request, 'signal', {
    value: new AbortController().signal,
    writable: false,
    enumerable: true,
    configurable: false,
  })
  const outcome = await listeners['approval/request']!(request, async () => 'unavailable')
  assert.equal(outcome, 'allowed-once', '换不出去也得照常把手机的答案交回去，审批不能因为我们这一行而失败')
  assert.equal(request.signal?.aborted, false, '不可写时不许碰原件那份 signal（更不许因为换不出去就把审批判死）')
  const handoff = String((kernel.describe() as Record<string, unknown>).approvalSignalHandoff)
  assert.match(
    handoff,
    /^(failed|ignored)/,
    `换不出去要说得出来（严格模式下赋值会抛，抛了就带原因）：否则"桌面那张卡为什么没关"在现场查不到`,
  )
  assert.equal((kernel.describe() as Record<string, unknown>).approvalDesktopVoided, 0)
})

/**
 * 提问那条 waterfall 的四条判据（形状与审批那组一一对应，但**每条都有自己的坑**）。
 *
 * 原来这里测的是 `userQuestions.registerProvider`——那条口在这一代宿主上不存在
 * （服务里 provider 一词零命中），而且"注册一个提供者"是单提供者语义：接管 = 桌面问不了问题。
 * 现在提问和审批共用同一条参与式实现，所以这里钉的是"两端同弹、谁先答谁算、两个方向都能收卡"。
 */
test('提问：手机先答时把答案对象原样交回瀑布，并撤销交给桌面那份 signal', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  const asked: string[] = []
  kernel.attachInteractionSink!({
    approval: async () => 'decline',
    question: async (info: { sessionId: string; questions: unknown[] }) => {
      asked.push(`${info.sessionId}/${(info.questions as { id: string }[]).map((q) => q.id).join(',')}`)
      return { answers: [{ id: 'q_env', selected: ['预发'] }] }
    },
  })
  const request: { agent: { session: { id: string } }; questions: unknown[]; signal?: AbortSignal } = {
    agent: { session: { id: 'ses_live' } },
    questions: [{ id: 'q_env', question: '部署到哪个环境？', options: [{ label: '预发' }, { label: '线上' }] }],
  }
  let downstream: AbortSignal | undefined
  const outcome = await listeners['user-questions/request']!(request, () => {
    downstream = request.signal
    // 桌面上一直没人点：手机答完之后这张卡靠我们那一下撤销来收。
    return new Promise<never>(() => {})
  })
  assert.deepEqual(
    outcome,
    { answers: [{ id: 'q_env', selected: ['预发'] }] },
    '手机的答案没被原样交回：宿主那边会把这次提问判成"没人答"',
  )
  assert.deepEqual(asked, ['ses_live/q_env'], '交给 runtime 的会话与题号不对：提问卡会问错东西')
  assert.equal(downstream?.aborted, true, '手机先答却没撤销下游：桌面 composer 里那张提问卡会继续挂着')
  const described = kernel.describe() as Record<string, unknown>
  assert.equal(described.questionsCalls, 1, '提问派发次数没进 status.json')
  assert.equal(described.questionsLast, 'answered-by-phone(1 项)', `落点读不出来：${String(described.questionsLast)}`)
  assert.equal(described.questionsSignalHandoff, 'fused')
  assert.equal(described.questionsDesktopVoided, 1, '这一次撤销没进 status.json：线上只能靠屏幕猜')
  // 答案正文**不进** status.json（`answered-by-phone(1 项)` 只报题数）：那是端到端加密要守的边界。
  assert.equal(JSON.stringify(described).includes('预发'), false, 'status.json 里出现了用户答的内容')
})

test('提问：桌面先答时手机那一侧要被撤回（reason desktop），落点记 answered-by-desktop', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  let phoneSignal: AbortSignal | undefined
  kernel.attachInteractionSink!({
    approval: async () => 'decline',
    question: async (info: { signal?: AbortSignal }) => {
      phoneSignal = info.signal
      // 手机没人点：桌面答完之后这一侧必须被叫醒，而不是挂到 300s 超时。
      return new Promise<null>((resolve) => {
        info.signal?.addEventListener('abort', () => resolve(null), { once: true })
      })
    },
  })
  const pending = listeners['user-questions/request']!(
    { agent: { session: { id: 'ses_live' } }, questions: [{ id: 'q1', question: '要哪个？' }] },
    async () => ({ answers: [{ id: 'q1', selected: ['甲'] }] }),
  )
  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['甲'] }] }, '桌面答了却被我们吞掉')
  assert.equal(phoneSignal?.aborted, true, '桌面先答却没撤回手机那一侧：runtime 不知道要作废，手机上那张卡会继续挂着')
  assert.equal(String(phoneSignal?.reason), 'desktop', 'reason 必须是 desktop：runtime 靠它分"桌面先答"与"平台撤回"')
  assert.equal(
    (kernel.describe() as Record<string, unknown>).questionsLast,
    'answered-by-desktop(1 项)',
    '落点要分得清是手机答的还是桌面答的',
  )
  assert.equal(
    (kernel.describe() as Record<string, unknown>).questionsDesktopVoided,
    0,
    '这一场不是手机答的，那颗计数器不该动',
  )
})

test('提问：两边都没答时必须把链子末端那个 rejection 原样抛回去（吞成 undefined 会冲掉整条链）', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  kernel.attachInteractionSink!({ approval: async () => 'decline', question: async () => null })
  // 宿主那条链的末端是 `noAnswerer()`：它**抛** NO_PROVIDER，而不是回一个值。
  const nobody = (): Promise<unknown> => {
    throw new Error('no user-questions answerer accepted the request')
  }
  // 测试夹具里 `listeners` 的声明是"订阅者返回 void"（emit-mode 的形状），
  // 而参与者**必须返回值**，所以这里按参与者形状窄化一次再断言。
  const ask = listeners['user-questions/request'] as unknown as (
    request: unknown,
    next: () => Promise<unknown>,
  ) => Promise<unknown>
  await assert.rejects(
    () =>
      ask({ agent: { session: { id: 'ses_live' } }, questions: [{ id: 'q1', question: '要哪个？' }] }, () => nobody()),
    /no user-questions answerer/,
    '把"没人答"吞成 undefined：那是把内核整条 turn 搞崩的形状（见 guard.ts 里那条红线）',
  )
  assert.equal(
    (kernel.describe() as Record<string, unknown>).questionsLast,
    'no-answer',
    '没人答这条也要留落点，否则现场只能看到"手机上没弹"这一半',
  )
})

test('提问：没有会话 id 时完整交还桌面，且不问手机（插件不抢答）', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  let sinkCalls = 0
  kernel.attachInteractionSink!({
    approval: async () => 'decline',
    question: async () => {
      sinkCalls += 1
      return { answers: [] }
    },
  })
  const outcome = await listeners['user-questions/request']!(
    { questions: [{ id: 'q1', question: '要哪个？' }] },
    async () => ({ answers: [{ id: 'q1', selected: ['甲'] }] }),
  )
  assert.deepEqual(outcome, { answers: [{ id: 'q1', selected: ['甲'] }] }, '没有会话 id 却自己答了：会抢掉桌面的提问')
  assert.equal(sinkCalls, 0, '没有会话 id 还去问手机')
  assert.equal(
    (kernel.describe() as Record<string, unknown>).questionsLast,
    'handed-back(no phone target)',
    '交还原因没进 status.json',
  )
})

test('未知事件类型不映射但要在 kernel.unmappedEventTypes 里看得见', () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  const seen: string[] = []
  kernel.subscribe((event) => seen.push(event.kind))
  const unknownEvent = listeners['session/event']
  assert.ok(unknownEvent, 'session/event 没订阅上')
  unknownEvent({ id: 'ses_live' }, { type: 'brand/new-event', seq: 1, data: { x: 1 } })
  assert.deepEqual(seen, [], '未知类型被映射成了某个事件：F1 禁止挪用语义')
  assert.equal(
    String((kernel.describe() as Record<string, unknown>).unmappedEventTypes),
    'brand/new-event',
    '没留痕：下一次"手机上缺东西"又要从头猜',
  )
  assert.match(
    String((kernel.describe() as Record<string, unknown>).eventTypes),
    /brand\/new-event/,
    '收到过什么类型也要记：分不清"内核没发"与"我们没认"',
  )
})

// ── 历史：内核日志 → 一页条目 ────────────────────────────────────────
//
// 夹具用的是**真机日志的形状**（取证：`~/.dsh/sessions/**/session.v4.jsonl.zstd`，逐字抄），
// 不是"照着类型定义编一个"。这一层最容易犯的错就是拿想象中的形状去测自己写的解析。

/** 一轮：用户说一句、模型想一下（reasoning + tool-call）、调工具、拿到结果、给出结论。 */
function realLog(sessionId: string): Array<{ type: string; seq: number; data: Record<string, unknown> }> {
  return [
    { type: 'turn/start', seq: 5, data: { turn: 1 } },
    { type: 'step/start', seq: 7, data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      seq: 9,
      data: {
        content: [{ type: 'text', text: '看看这个项目的完成度' }],
        source: { kind: 'user' },
        role: 'user',
        id: 'u-9',
      },
    },
    {
      type: 'assistant/message',
      seq: 11,
      // 正文在 data.message.content；这一条只有 reasoning + tool-call —— 正文是空的
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先看看目录里有什么。' },
            { type: 'tool-call', id: 'call_a', name: 'run_code', arguments: '{"code":"ls"}' },
          ],
        },
      },
    },
    {
      type: 'tool/call',
      seq: 12,
      data: { turn: 1, step: 1, callId: 'call_a', name: 'Bash', arguments: '{"command":"ls -la"}' },
    },
    {
      type: 'tool/result',
      seq: 13,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'call_a' },
          toolCallId: 'call_a',
          content: [{ type: 'text', text: 'total 88\ndrwxr-xr-x  20 dev' }],
        },
      },
    },
    {
      type: 'assistant/message',
      seq: 14,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '看完了。' },
            { type: 'text', text: '项目结构清楚，完成度不错。' },
          ],
        },
      },
    },
    { type: 'turn/end', seq: 15, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

test('历史：与实时流同构的日志被翻译成同一种条目，空正文与运行态都不落进页面', () => {
  const page = historyPageFromLog({ sessionId: 'ses_1', events: realLog('ses_1'), limit: 100 })
  const shape = page.events.map((e) => {
    if (e.kind === 'delta') return `delta:${e.role}:${e.text}`
    if (e.kind === 'tool') return `tool:${e.phase}:${e.callId}`
    return `other:${e.kind}`
  })
  assert.deepEqual(shape, [
    'delta:user:看看这个项目的完成度',
    // 只有 reasoning + tool-call 的那条 assistant/message **不该**产生正文块：
    // 不过滤的话历史里会插进一堆空白正文
    'tool:args:call_a',
    'tool:completed:call_a',
    'delta:assistant:项目结构清楚，完成度不错。',
  ])
  assert.equal(page.nextBeforeSeq, undefined, '整份日志一次给完，不该再给游标')
})

test('历史：思维链正文（M28）一个字节都不出站 —— 历史这条路径也必须守', () => {
  const page = historyPageFromLog({ sessionId: 'ses_1', events: realLog('ses_1'), limit: 100 })
  const dumped = JSON.stringify(page)
  assert.equal(dumped.includes('先看看目录里有什么'), false, 'reasoning 泄漏到出站结构里了')
  assert.equal(dumped.includes('看完了'), false, 'reasoning 泄漏到出站结构里了')
  assert.equal(dumped.includes('reasoning'), false)
})

test('历史：一条原始事件可能折成 0/1/2 条 —— 分页必须切在事件边界上，不能切在条目中间', () => {
  const log = realLog('ses_1')
  const all = historyPageFromLog({ sessionId: 'ses_1', events: log, limit: 100 })
  // 从最后往前一页页翻，拼起来必须与一次全给**逐字相同**
  const collected: unknown[] = []
  let cursor: number | undefined
  for (let guard = 0; guard < 20; guard++) {
    const page = historyPageFromLog({
      sessionId: 'ses_1',
      events: log,
      limit: 2,
      ...(cursor === undefined ? {} : { beforeSeq: cursor }),
    })
    collected.unshift(...page.events)
    if (page.nextBeforeSeq === undefined) break
    cursor = page.nextBeforeSeq
  }
  assert.deepEqual(collected, all.events, '翻页拼起来与一次全给不一致：中间丢或重了')
})

test('历史：翻不动的时候不许给游标（否则手机上会长出一个点了没反应的「加载更早」）', () => {
  const log = realLog('ses_1')
  const one = historyPageFromLog({ sessionId: 'ses_1', events: log, limit: 2 })
  assert.equal(typeof one.nextBeforeSeq, 'number', '还有更早的内容就必须给游标')
  const rest = historyPageFromLog({ sessionId: 'ses_1', events: log, limit: 100, beforeSeq: one.nextBeforeSeq ?? 0 })
  assert.equal(rest.nextBeforeSeq, undefined, '已经到最早了还在给游标')
  assert.ok(rest.events.length > 0)
  // 游标是**排他**上界：拿同一个游标再要一次，结果必须完全一致（幂等）
  const again = historyPageFromLog({ sessionId: 'ses_1', events: log, limit: 100, beforeSeq: one.nextBeforeSeq ?? 0 })
  assert.deepEqual(again, rest)
})

test('历史：预算再小也要给出一整组，不能产出空页（空页 + 游标 = 翻页死循环）', () => {
  const page = historyPageFromLog({ sessionId: 'ses_1', events: realLog('ses_1'), limit: 1 })
  assert.ok(page.events.length >= 1, '给了空页但游标还在动，手机端的「加载更早」会一直转')
})

test('历史：没有下文的工具调用要落成"已结束 + 说明"，不能让它一直显示"正在执行"', () => {
  const log = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '跑一下' }], role: 'user', id: 'u-1' } },
    {
      type: 'tool/call',
      seq: 2,
      data: { turn: 1, step: 1, callId: 'call_x', name: 'Bash', arguments: '{"command":"sleep 999"}' },
    },
    // 这一轮被中断：没有 tool/result，只有一条 error 收尾
    {
      type: 'turn/end',
      seq: 3,
      data: { turn: 1, reason: { kind: 'error', error: { message: 'user interrupted', code: 'ABORT' } } },
    },
  ]
  const page = historyPageFromLog({ sessionId: 'ses_1', events: log, limit: 100 })
  const tool = page.events.find((e) => e.kind === 'tool')
  assert.ok(tool && tool.kind === 'tool')
  assert.equal(tool.phase, 'completed', '停在 args/started 会让步骤组一直显示「正在执行 1 个步骤」')
  assert.match(tool.resultPreview ?? '', /中断/, '要说明为什么没有结果，不能只留一个空结果')
  // 收尾的错误文案要留下：否则手机上"这一轮什么都没发生"与"成功回合"长得一样
  const texts = page.events.filter((e) => e.kind === 'delta').map((e) => (e.kind === 'delta' ? e.text : ''))
  assert.ok(
    texts.some((t) => t.includes('user interrupted')),
    `错误原因被丢了：${JSON.stringify(texts)}`,
  )
})

test('历史：未知事件类型既不映射也不炸（内核一直在加新事件）', () => {
  const page = historyPageFromLog({
    sessionId: 'ses_1',
    events: [
      { type: 'brand/new-event', seq: 1, data: { x: 1 } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '在' }], role: 'user', id: 'u-2' } },
    ],
    limit: 100,
  })
  assert.equal(page.events.length, 1)
  assert.equal(page.events[0]!.kind, 'delta')
})

test('历史：空日志给空页、且不给游标（"这个会话没有内容"与"读不出来"必须分得清）', () => {
  const page = historyPageFromLog({ sessionId: 'ses_1', events: [], limit: 100 })
  assert.deepEqual(page.events, [])
  assert.equal(page.nextBeforeSeq, undefined)
})

test('读历史走 sessionQuery.readSession，把它给的整份事件交给分页', async () => {
  const f = fixture()
  const asked: unknown[] = []
  const services = f.bundle({ live: true })
  services.sessionQuery = {
    readSession: (id: string) => {
      asked.push(id)
      return Promise.resolve({ session: { id }, events: realLog(id) })
    },
  }
  const kernel = f.kernel(services)
  const page = await kernel.readHistory!('ses_1', { limit: 100 })
  assert.deepEqual(asked, ['ses_1'], '读历史必须点名那条会话')
  assert.equal(page.events.length, 4)
  assert.match(String((kernel.describe() as Record<string, unknown>).historyFace), /readSession/)
})

test('宿主没有 sessionQuery.readSession 时必须**抛**，不许回一张空页', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true })) // bundle 里根本没有 sessionQuery
  await assert.rejects(
    () => kernel.readHistory!('ses_1', { limit: 10 }),
    /不能读会话历史/,
    '回空页在手机上是"这个会话没内容"——一个会让人查错方向的假事实',
  )
  assert.match(String((kernel.describe() as Record<string, unknown>).historyFace), /absent/)
})

// ── 新建会话 ────────────────────────────────────────────────────────

test('新建会话走 sessionController.commands.create({})：一个字段都不许自己塞', async () => {
  const f = fixture()
  const asked: unknown[] = []
  const services = f.bundle({ live: true })
  services.sessionController = {
    commands: {
      create: (request: unknown) => {
        asked.push(request)
        // 真实签名（commands.js 的 `async create`）：`{ sessionId, ...(agentPreset ? {agentPreset} : {}) }`
        return Promise.resolve({ sessionId: 'session-abc' })
      },
    },
  }
  const kernel = f.kernel(services)
  const made = await kernel.newSession!()
  assert.deepEqual(made, { ok: true, sessionId: 'session-abc' })
  // 永远不给 sessionId（那才会复用旧会话而不是新建）；这一版连 cwd 都不给——
  // 一条会话都没有、配置也没点名时没有可抄的目录，交给宿主默认（2026-10-04 起
  // cwd 是显式给的，见下面两条；空列表这一档退回旧行为）。
  assert.deepEqual(asked, [{}])
  assert.match(String((kernel.describe() as Record<string, unknown>).createFace), /commands\.create/)
})

test('新建会话带 cwd：不给的话宿主用 process.cwd() 兜底（真机上是 /），会话就不在任何用户项目里', async () => {
  const f = fixture()
  const asked: unknown[] = []
  const services = f.bundle({ live: true })
  // 最近一条会话在 /Users/linbin/dsh-remote-control：用户在做的项目就是它。
  services.sessionQuery = {
    listSessions: () =>
      Promise.resolve([
        {
          header: { id: 'ses_old', createdAt: 1_700_000_000_000, cwd: '/Users/linbin/dsh-remote-control' },
        },
      ]),
  }
  services.sessionController = {
    commands: {
      create: (request: unknown) => {
        asked.push(request)
        return Promise.resolve({ sessionId: 'session-xyz' })
      },
    },
  }
  const made = await f.kernel(services).newSession!()
  assert.equal(made.ok, true)
  assert.deepEqual(asked, [{ cwd: '/Users/linbin/dsh-remote-control' }], '要挂在用户此刻在做的项目上')
})

test('新建会话的 cwd：配置点名优先于"跟着最近一条会话走"', async () => {
  const f = fixture({ newSessionCwd: '/Users/linbin/other-proj' })
  const asked: unknown[] = []
  const services = f.bundle({ live: true })
  services.sessionQuery = {
    listSessions: () => Promise.resolve([{ header: { id: 'ses_old', createdAt: 1_700_000_000_000, cwd: '/w/stale' } }]),
  }
  services.sessionController = {
    commands: {
      create: (request: unknown) => {
        asked.push(request)
        return Promise.resolve({ sessionId: 'session-pinned' })
      },
    },
  }
  await f.kernel(services).newSession!()
  assert.deepEqual(asked, [{ cwd: '/Users/linbin/other-proj' }], '配置点名的目录优先')
})

test('新建的空会话必须出现在列表里 —— 持久化那面还没它，而它已经不是"不存在"', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  // 持久化那面（sessionQuery.listSessions）扫的是会话**日志**，一条还没有任何消息的
  // 新会话根本没有日志。这里就模拟这个局面：它永远报不出新建的那条。
  services.sessionQuery = {
    listSessions: () => Promise.resolve([{ header: { id: 'ses_old', createdAt: 1_700_000_000_000, cwd: '/w/old' } }]),
  }
  services.sessionController = { commands: { create: () => Promise.resolve({ sessionId: 'ses_fresh' }) } }
  const kernel = f.kernel(services)

  const before = await kernel.listSessions(50)
  assert.deepEqual(
    before.map((item) => item.summary.id),
    ['ses_old'],
  )

  await kernel.newSession!()

  const after = await kernel.listSessions(50)
  const ids = after.map((item) => item.summary.id)
  assert.equal(
    ids.includes('ses_fresh'),
    true,
    `新建的会话不在列表里（实得 ${JSON.stringify(ids)}）→ 用户回到列表会以为没建上`,
  )
  assert.equal(ids.length, 2, '补进来的应该正好是新那一条，不能重复')
})

test('持久化那面追上之后，本地那条临时记录要退休（不能一直盖着真数据）', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const rows: Array<{ header: { id: string; createdAt: number; cwd?: string } }> = [
    { header: { id: 'ses_old', createdAt: 1_700_000_000_000, cwd: '/w/old' } },
  ]
  services.sessionQuery = { listSessions: () => Promise.resolve(rows) }
  services.sessionController = { commands: { create: () => Promise.resolve({ sessionId: 'ses_fresh' }) } }
  const kernel = f.kernel(services)
  await kernel.newSession!()
  assert.equal((await kernel.listSessions(50)).length, 2, '临时记录先顶上')

  // 宿主把这条落盘了 → 下一次列表里它由持久化那面给出（带 cwd 等真数据）
  rows.push({ header: { id: 'ses_fresh', createdAt: 1_700_000_001_000, cwd: '/w/proj' } })
  const real = await kernel.listSessions(50)
  assert.equal(real.length, 2, '两边都有它的时候不许出现两条')
  const fresh = real.find((item) => item.summary.id === 'ses_fresh')
  assert.equal(fresh?.summary.workspace, '/w/proj', '要让位给真数据，而不是继续用本地那条没 workspace 的')
})

test('宿主没有 sessionController：明确说出缺什么，不许编一个 id 出来', async () => {
  const f = fixture()
  const kernel = f.kernel(f.bundle({ live: true }))
  const made = await kernel.newSession!()
  assert.equal(made.ok, false)
  assert.equal(made.sessionId, undefined, '拒绝时绝不能带 id')
  assert.match(String(made.message), /sessionController/, '要说清楚缺的是哪一层，否则只有一句看不懂的话')
  assert.match(String((kernel.describe() as Record<string, unknown>).createFace), /absent/)
})

test('sessionController 在、但 commands.create 不在：也要点名到成员一级', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  services.sessionController = { commands: { rename: () => undefined } }
  const made = await f.kernel(services).newSession!()
  assert.equal(made.ok, false)
  assert.match(String(made.message), /create/, '缺到哪一层就要报到哪一层（这个对象上有 rename 但没有 create）')
})

test('创建返回里没有 sessionId：按失败处理，不把 undefined 当成一个 id 往下传', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  services.sessionController = { commands: { create: () => Promise.resolve({ agentPreset: 'x' }) } }
  const made = await f.kernel(services).newSession!()
  assert.equal(made.ok, false)
  assert.match(String(made.message), /sessionId/)
})

test('被判定为宿主注入的 user/message：不发出站，但要在 kernel.injectedUserMessages 里留痕', () => {
  // 注入内容（time-context 之类）不能出站：它在手机上会顶着「你的指令」那颗蓝气泡，
  // 而用户没发过那句话。但"我们丢掉"必须看得见，否则「手机上看不到 X」这个问题
  // 分不清是宿主没发、我们丢了、还是路上丢了。
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  const seen: KernelEvent[] = []
  kernel.subscribe((event) => seen.push(event))
  const fire = listeners['session/event']
  assert.ok(fire, 'session/event 没订阅上')

  fire(
    { id: 'ses_live' },
    {
      type: 'user/message',
      seq: 1,
      data: {
        content: [{ type: 'text', text: 'Time sampled while preparing turn 3' }],
        source: { kind: 'time-context' },
        id: 'm-1',
      },
    },
  )
  fire(
    { id: 'ses_live' },
    {
      type: 'user/message',
      seq: 2,
      data: { content: [{ type: 'text', text: '真的指令' }], source: { kind: 'user' }, id: 'm-2' },
    },
  )

  assert.deepEqual(
    seen.map((event) => event.kind),
    ['delta'],
    '只该有真人那一条的 delta：注入的那条出站就是让用户背一句他没说过的话',
  )
  const traced = String((kernel.describe() as Record<string, unknown>).injectedUserMessages)
  assert.match(traced, /time-context/, '丢掉的那条必须留痕，否则真机排错又要从头猜')
  assert.doesNotMatch(traced, /(?<!×)\buser\b(?!-)/, '真人消息不许被算进"注入"计数：那个计数是"我们丢了多少"的账')
})

/**
 * 提问卡在手机上不弹的根因：mapQuestion 产出**协议不合法**的载荷，整帧被静默丢弃。
 *
 * 协议里 questionItem.question 与 choiceOption.label 都是 nonEmpty，而旧实现
 * 写的是 String(item.question ?? '')——宿主那个字段名一旦对不上，空串就让
 * parseEvPayload 返回 null，认不出的载荷**静默丢弃**（没有任何报错）。
 * 现场长这样：dsh 弹了提问框，mp 端什么都没有，而 status.json 里
 * questionsCalls=1 / questionsLast=no-answer，两头都对不上账。
 *
 * 所以判据直接钉「产出的帧必须能过协议自己的解析器」，而不是钉某几个字段名。
 */
test('提问卡：宿主字段名对不上时，产出的帧仍必须能过协议解析（否则手机上静默不弹）', async () => {
  const f = fixture()
  const services = f.bundle({ live: true })
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  services.on = (name: string, listener: (...args: unknown[]) => void) => {
    listeners[name] = listener
    return () => {}
  }
  const kernel = f.kernel(services)
  let received: { questions: unknown[] } | undefined
  kernel.attachInteractionSink!({
    approval: async () => 'decline',
    question: async (info: { questions: unknown[] }) => {
      received = info as { questions: unknown[] }
      return { answers: [] }
    },
  })
  // 三种真实见过的畸形题面：只有 header、只有 text、以及完全没题面只有选项。
  const request = {
    agent: { session: { id: 'ses_live' } },
    questions: [
      { id: 'q1', header: '部署到哪个环境', options: [{ label: '预发' }, {}] },
      { id: 'q2', text: '要不要继续' },
      { id: 'q3', options: [{ value: 'A' }] },
    ],
  }
  await listeners['user-questions/request']!(request, async () => {
    throw new Error('桌面没答')
  })
  assert.ok(received, '提问没有派发到 sink')
  // **这一条是全部重点**：把产出的题面原样塞进协议构造器，必须解析得过。
  assert.notEqual(
    parseEvPayload(
      questionRequest({ requestId: 'q_1', sessionId: 'ses_live', questions: received.questions as never }),
    ),
    null,
    '产出的 ev.question_request 过不了协议解析：这一帧会被静默丢弃，手机上永远不弹卡',
  )
  const items = received.questions as Array<Record<string, unknown>>
  assert.equal(items.length, 3, '不该因为某一题畸形就少发一道')
  assert.equal(items[0]?.question, '部署到哪个环境', '只有 header 时要退回取 header')
  assert.equal(items[1]?.question, '要不要继续', '只有 text 时要退回取 text')
  assert.equal(items[2]?.question, '第 3 题', '完全没有题面文字时给一道稳定的占位题')
  // 选项同理：空 label 会让 choiceOption 校验失败
  assert.deepEqual(items[0]?.options, [
    { id: 'o1', label: '预发' },
    { id: 'o2', label: '选项 2' },
  ])
  assert.deepEqual(items[2]?.options, [{ id: 'o1', label: 'A' }], '只有 value 时取 value')
})
