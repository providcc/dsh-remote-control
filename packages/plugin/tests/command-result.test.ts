/**
 * command-result.test — `/drc` 命令的返回契约（线上事故回归锁）。
 *
 * 事故原话（用户真机）：`/drc pair报错：command "drc" returned unknown result kind "text"`。
 * 根因：重写时 handler 返回了 `{kind:'text', text}`——这是**旧实现的形状**，而宿主只认
 * `success`/`error` 两种 kind，别的值在**注册边界**上直接抛 TypeError，整条命令失败。
 *
 * 契约的权威来源（本机取证，`@deepseek-ai/dsh-commands` v0.1.0-rc.6）：
 *   ~/.dsh/profiles/<profile>/node_modules/@deepseek-ai/dsh-commands/lib/types/index.js
 *   `normalizeResult(command, value)` 第 155-181 行：
 *     - 非对象 / 无 `kind`            → TypeError("...handler must return a CommandResult")
 *     - kind==='success'：text 可选，给了就必须是 string；sourceEventSeq 可选且须为非负安全整数
 *     - kind==='error'  ：text 必须是非空 string
 *     - 其余 kind                      → TypeError(`...returned unknown result kind "${kind}"`)  ← 事故这一句
 *
 * 两道锁：
 *   1. 类型锁——`packages/plugin/src/index.ts` 里 handler 标注 `Promise<CommandResult>`，
 *      写错 kind 会被 `tsc`（本包 `pnpm build` 先跑 tsc）挡在编译期。
 *   2. 本文件——真的走一遍 `apply()` 把 handler 注册出来，再拿结果过一遍**逐行复刻**的
 *      `normalizeResult`。复刻件自身先用 `{kind:'text'}` 做反证（见"带牙"那条），
 *      确保它不是"永远返回 ok"的空壳。
 *
 * 覆盖分工：`status`、`unpair`、以及"打字习惯还留在 `/drc pair` 上的人拿到什么"这三个返回点
 * 在本文件——每个返回点都必须过一遍宿主那个 kind 校验，因为这条契约破过的现场就是
 * "命令整个失败"（见文件头）。`pair` 子命令本身在 2026-10-03 删了：配对唯一入口是状态栏那颗
 * pill，命令行再发一张会绕过它的幂等语义（多码事故的原样）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { apply, type CommandResult } from '../src/index.js'

/** 一眼假的 token：仓库里不许出现真凭据，这条只验形状（同 status.test.ts）。 */
const FAKE_TOKEN = 'fake-host-token-not-a-real-secret-0123456789abcdef'

/**
 * 逐行复刻宿主的 `normalizeResult`（来源见文件头）。
 *
 * 为什么是复刻而不是 import：真模块的 peerDependencies 是整条 cordis 运行时，
 * 单测里拉进来既慢又脆。所以这里"抄"的是**被约束的那几行**，并且用下面两条
 * 反证保证抄件有牙：(a) `{kind:'text'}` 必须被拒；(b) 若本机能找到宿主源码，
 * 就核对抄件里的报错模板与分支关键字确实还在源码里——宿主改了契约，这条会红。
 */
function harnessNormalizeResult(command: string, value: unknown): CommandResult {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new TypeError(`command "${command}" handler must return a CommandResult`)
  }
  const result = value as { kind: unknown; text?: unknown; sourceEventSeq?: unknown }
  if (result.kind === 'success') {
    if (result.text !== undefined && typeof result.text !== 'string') {
      throw new TypeError(`command "${command}" success text must be a string when supplied`)
    }
    if (
      result.sourceEventSeq !== undefined &&
      (!Number.isSafeInteger(result.sourceEventSeq) || (result.sourceEventSeq as number) < 0)
    ) {
      throw new TypeError(
        `command "${command}" success sourceEventSeq must be a non-negative safe integer when supplied`,
      )
    }
    return { kind: 'success', ...(result.text === undefined ? {} : { text: result.text as string }) }
  }
  if (result.kind === 'error') {
    if (typeof result.text !== 'string' || result.text.trim().length === 0) {
      throw new TypeError(`command "${command}" error text must be a non-empty string`)
    }
    return { kind: 'error', text: result.text }
  }
  throw new TypeError(`command "${command}" returned unknown result kind "${String(result.kind)}"`)
}

/** 在已安装的 profile 里找宿主命令模块（找不到就跳过差分核对，不因此判失败）。 */
function findHarnessTypes(): string | undefined {
  const root = path.join(homedir(), '.dsh', 'profiles')
  if (!existsSync(root)) return undefined
  for (const profile of ['desktop', 'tui']) {
    const file = path.join(root, profile, 'node_modules', '@deepseek-ai', 'dsh-commands', 'lib', 'types', 'index.js')
    if (existsSync(file)) return file
  }
  return undefined
}

interface RegisteredDefinition {
  name: string
  description: string
  input?: { hint?: string }
  handler: (invocation: { commandId: string; rawInput: string }) => Promise<unknown> | unknown
}

/** 起一份"非 cordis"的假上下文：和 e2e/run.mjs 的 bootHost 同形状，只多一个 commands 捕获。 */
function bootCommandHost(): { definition: RegisteredDefinition; dispose: () => void } {
  const registered: Record<string, RegisteredDefinition> = {}
  const disposers: Array<() => void> = []
  const statusDir = mkdtempSync(path.join(tmpdir(), 'drc-cmd-result-'))
  const context = {
    get: () => undefined,
    inject: () => undefined,
    provide: () => undefined,
    // 假上下文直接挂 commands；真 cordis 上 `ctx.commands` 这一读是抛错（走 get/inject 两条路）。
    commands: { register: (definition: RegisteredDefinition) => void (registered[definition.name] = definition) },
    on: () => () => undefined,
    off: () => undefined,
    onDispose: (fn: () => void) => void disposers.push(fn),
  }
  apply(context, {
    enabled: true,
    // 故意不可达：这条测试要的就是"中继离线"这条确定分支，不许它真连上任何东西。
    serverUrl: 'ws://127.0.0.1:1',
    hostToken: FAKE_TOKEN,
    hostId: 'fake-command-host',
    statusFile: path.join(statusDir, 'status.json'),
    mockBridge: false,
    pairOnStartSec: 0,
  })
  const definition = registered.drc
  assert.ok(definition, 'apply() 必须把名为 drc 的命令注册进 ctx.commands')
  assert.equal(typeof definition.handler, 'function', 'drc 命令必须带 handler')
  return {
    definition,
    dispose: () => {
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

test('复刻件带牙：{kind:"text"} 必须被拒，且报错就是事故那一句', () => {
  // (a) 反证 —— 若这条不抛，下面所有断言都失去意义。
  assert.throws(
    () => harnessNormalizeResult('drc', { kind: 'text', text: '二维码…' }),
    (error: unknown) =>
      error instanceof TypeError && /unknown result kind "text"/.test(String((error as Error).message)),
    '复刻件必须拒绝 {kind:"text"}，否则它不是有效判据',
  )
  // (b) 另外两条也要有牙：空 error text、非字符串 success text。
  assert.throws(() => harnessNormalizeResult('drc', { kind: 'error', text: '  ' }), TypeError)
  assert.throws(() => harnessNormalizeResult('drc', { kind: 'success', text: 42 }), TypeError)
  assert.throws(() => harnessNormalizeResult('drc', null), TypeError)
  // (c) 合法形状要放行 —— 免得复刻件"一律抛"也能骗过 (a)。
  assert.deepEqual(harnessNormalizeResult('drc', { kind: 'success' }), { kind: 'success' })
  assert.deepEqual(harnessNormalizeResult('drc', { kind: 'error', text: '不行' }), { kind: 'error', text: '不行' })
})

test('打字习惯还留在 `/drc pair` 上的人：拿到状态快照，且命令行不再发出任何配对凭据', async (t) => {
  const host = bootCommandHost()
  t.after(host.dispose)
  const raw = await host.definition.handler({ commandId: 'cmd-1', rawInput: 'pair' })
  // 先过契约校验：这一行若红，就是用户看到的 `unknown result kind` 又回来了。
  const result = harnessNormalizeResult('drc', raw)
  assert.equal(result.kind, 'success', 'kind 必须是 success（旧实现写的 text 会被宿主抛错）')
  const text = (result as { text?: string }).text ?? ''
  // `pair` 已经不是子命令，落到默认那条 = 状态快照。断"是 JSON"而不是断"含某个词"：
  // 说明文字会改，快照形状才是这条分支的身份。
  const snapshot = JSON.parse(text) as Record<string, unknown>
  assert.ok('relay' in snapshot && 'pill' in snapshot, `应当是状态快照：${text.slice(0, 160)}`)
  // 关键判据：**命令行没有发出第二张码**。这条 fixture 的中继根本不可达，
  // 一旦有人把发码逻辑塞回来，这里就会出现一张码或一句"中继还没连上"。
  assert.doesNotMatch(text, /dshr:|psk/, '命令行不许再把配对凭据印出来')
  assert.doesNotMatch(text, /配对码 \d{6}/, '发码那句不该再出现在命令行的任何输出里')
})

test('status：handler 返回的 result 是 success + 可 JSON.parse 的快照', async (t) => {
  const host = bootCommandHost()
  t.after(host.dispose)
  const raw = await host.definition.handler({ commandId: 'cmd-2', rawInput: 'status' })
  const result = harnessNormalizeResult('drc', raw)
  assert.equal(result.kind, 'success')
  const text = (result as { text: string }).text
  const snapshot = JSON.parse(text) as Record<string, unknown>
  assert.equal(typeof snapshot.relay, 'string', 'status 文本必须是状态快照 JSON（relay 字段是排错入口）')
  assert.ok(!text.includes(FAKE_TOKEN), '状态快照里绝不能出现 token 真值')
  assert.equal(snapshot.hostToken, undefined, 'hostToken 字段必须是 undefined（只留 redact 形态）')
})

test('unpair：handler 返回的 result 过得了宿主 normalizeResult', async (t) => {
  const host = bootCommandHost()
  t.after(host.dispose)
  const raw = await host.definition.handler({ commandId: 'cmd-3', rawInput: 'unpair' })
  const result = harnessNormalizeResult('drc', raw)
  assert.equal(result.kind, 'success')
  assert.ok(((result as { text: string }).text ?? '').length > 0, '成功也要有可读文本：命令面板上是空的会像卡住')
})

test('未知输入落到 status 分支：不会因为参数奇怪就返回非法 kind', async (t) => {
  const host = bootCommandHost()
  t.after(host.dispose)
  for (const rawInput of ['', '   ', 'wat', 'PAIR', ' status ']) {
    const result = harnessNormalizeResult('drc', await host.definition.handler({ commandId: 'cmd-x', rawInput }))
    assert.equal(result.kind, 'success', `rawInput=${JSON.stringify(rawInput)} 必须落到合法分支`)
  }
})

test('差分核对：本机宿主源码里那几行契约关键字（改了契约这条要提醒）', { skip: !findHarnessTypes() }, () => {
  const file = findHarnessTypes()
  assert.ok(file, 'skip 条件保证这里能找到')
  const source = readFileSync(file, 'utf8')
  for (const marker of [
    'unknown result kind',
    "result.kind === 'success'",
    "result.kind === 'error'",
    'must return a CommandResult',
  ]) {
    assert.ok(source.includes(marker), `宿主源码里找不到「${marker}」：契约可能变了，复刻件要同步（${file}）`)
  }
})
