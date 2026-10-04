# 更新日志

本项目所有值得注意的改动都记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

## [2.0.0] - 2026-10-04

这一版把配对收敛成**一台、一条路、一颗按钮**，并把 `/drc` 整条删掉。属于**破坏性变更**，
发布时该走主版本号。产品定义（为什么是这三条承诺、由承诺推出的界面判据）在伞仓
`docs/PRODUCT.md`——下面的"等 N 件事"那一条就是它 §3 第 1、2 条落进界面的地方。

### 破坏性变更

- **未配对时点开那颗 pill 直接就是二维码页**，中间那一屏与它那颗 `生成配对码` 按钮一起删掉。
  这一条**反转了 2026-10-03 的"点开不发码"**，但没丢掉它守的东西：那张取舍当时防的是
  "看一眼就消耗一张有寿命的 pending 码"，而**已配对那一侧仍然一次码都不发**（点开只给状态）。
  没配上时面板上没有任何别的内容可看，多点一次只换到一次"原来在这儿"。
  配套两件事：那颗按钮从此只按"配没配上"分两种身份（`刷新` / `退出配对`），退出配对之后就势
  回到二维码页；而**二维码那一屏仍然带正文那几行**（待处理 / 中继 / 状态 / 版本），
  否则这一改会把"连的哪一台、连没连上、跑的是哪一版"从未配对的屏幕上一起删走。
- **`/drc` 命令整条删掉**：`ctx.commands` 上现在**一个命令都不注册**，配对入口只剩状态栏那颗
  pill 的那四条同域路由。`/drc status` 能说的面板抬头都有，`/drc unpair` 换成了面板右上角那颗
  按钮——留着它们只会让"配对入口只有一个"变成一句不真的话。
- **同一时刻只允许配对一台**：新设备配上时，主机当场踢掉旧的那条通道（原来允许多台并存）。
- **`GET …/status` 去掉 `hostLabel`，补上 `version` 与"有没有事在等"**：字段是
  `relay` / `paired` / `serverUrl` / `version` / `waiting` / `waitingOldestSec` 六个，全是非凭据。
  本机名配对时手机上已经看到，留在弹窗里只是占一行；`version` 是本机装的那一版
  （打包时经 esbuild `define` 注入，源码直跑时是 `dev`），用来回答"跑的是哪一版"；
  `waiting` / `waitingOldestSec` 见下面的"等 N 件事"。

### 新增

- **`POST /plugins/dsh-remote-control/unpair`**：面板右上角那颗"退出配对"。写路由，与发码共用
  同一道跨站守卫（`x-drc-pair: 1`）；幂等，没配上时回 `200 {state:'ok',unpaired:0}` 而不是 500
  ——轮询与点击之间状态可能已经翻过去，那是正常竞态不是错误。
- **有东西挂在手机上等回答时，那颗 pill 说的是"等 N 件事"**（抬头 tone 走 amber 那一档），
  面板正文也多出**排在第一行**的 `待处理 · 2 件 · 最久 4 分 12 秒`。
  原来这条链上唯一的可见点是"已配对"——而那一刻真正的事实是**有一条回合停在这台机器上等人点**。
  优先级写死为：`已断开连接`(红) > `等 N 件事` > `已配对`(绿) > `未配对`(灰)：
  链都断了，说"等几件"没有意义（要修的是连接）；而**没配上**时即使还挂着一条没超时的挂起
  （手机中途掉线），抬头也说的是"未配对"——用户能做的第一件事是重新配对，不是去找一台不存在的手机。
  数据来自 `HostRuntime.waiting`（`pending` 表里新增 `kind` 与 `askedAt`，时长用 `clock.now()`
  算，于是 FakeClock 能演"已经等了 4 分钟"）。

- **重启不再逼用户重扫码：会话簿落盘 + 恢复**。配对密钥簿（PSK + convId + seqHost）落到
  status.json 同目录的 `conversations-<hostId>.json`（0600 + 临时文件 rename + hostId 校验），
  **不落**派生密钥、**不落**"此刻谁连着"（后者落盘会让主机一启动就往没人收的通道广播）。
  恢复必须在 `relay.connect()` **之前**——反了会被第一帧 resync 声明空列表，中继当场删通道；
  恢复出的会话立刻 `runtime.start()`，不等 `onPeerJoined`（手机是恢复不是重配，不发
  pair-begin-client，等它 = 主机不订阅任何内核事件，症状与配对丢失一模一样）。
  恢复出来的会话按 7 天剪（与中继 `DRC_CONV_IDLE_TTL_MS` 对齐：中继忘掉它那天本就是该重扫那天），
  `pairStoreFile: 'off'` 关掉即回旧行为。`status.json` 新增
  `pairStore{enabled,file,restored,lastSavedAt}` 四个非凭据字段。

### 变更

- **主机身份不再每次加载换一个**：`config.hostId` 为空时旧写法是现造一个 `h_<3字节随机>`，
  真机 5 分钟内出现过三个身份（HANDOFF §3.4），每一次都让中继报 `replaced:0`——顶不掉旧 socket，
  手机连的那条会话指向"没有钥匙的对端"，`droppedFrames` 一直涨。现在按
  **配置 > 磁盘上的旧值 > 现造并落盘** 定身份，落点是 status.json 旁边的 `host-id`（0600，
  已存在的值绝不改写；升级前那种 `h_xxxx` 读到了继续用，不借机换号）。
  写不进去 / 目录不可用时退回一次性身份并且**绝不抛**——身份暂时不稳，好过插件起不来。
  `status.json` 新增 `hostId` 字段：以后"手机连不上 / 丢帧涨"第一眼就能看出身份稳不稳。
- **pill 弹出面板重做，以"精炼"为准**：抬头一行（状态 + 右上角**唯一**一颗动作按钮）加正文
  **三行：中继 `host:port` / 中继状态（已连接 / 连接中 / 已断开 / 未启动）/ 版本号**
  （各自拿不到值时不占地方）。删掉"本机 / 台数"那两行、`再配一台` 那个改名，以及
  **`换一张` 按钮连同"倒计时走完自动再要一张"这个能力**。那颗按钮**跟着当前视图走**：
  未配对=`生成配对码`、已配对=`退出配对`、正在出图=`刷新`（同一条幂等发码路由）。
  正文先收成"只有中继一行"，用户嫌单薄，于是补回"状态 / 版本"凑三行——留下的这三条都**不与
  抬头那句重复**：抬头在线时只讲配没配上，这三行才讲连的是哪台、连没连上、跑的是哪一版。
- **状态用颜色说**：`已断开连接` 是**新的红**（`tone: 'error'`），不再和"未配对"共用灰——
  断链是故障，灰色会被读成"还没轮到配"。
- **配上之后面板从二维码翻回状态视图**：那一张码配上就没用了，继续占着面板会让人以为要再扫一次。
- **样式表按内容对齐**（真屏幕事故的修法）：`ensureStyle` 原来只要 `<head>` 里有一份
  `style[data-plugin-css]` 就直接返回。宿主热更这一半时文档未必重载，于是**新 JS 按新结构建 DOM、
  旧 CSS 还在生效**——真屏幕上表现为整块面板错位：右上角那颗按钮掉到第二行居中
  （上一版 `.drc-actions` 的 `justify-content: center` 在管事）、中继那一行竖排。
  现在内容不一致就当场换掉。

### 新增

- **提问也问到手机了，而且不再"接管"**：`user-questions/request` 现在是第二条被**参与**的
  waterfall（登记口与审批共用同一组 `{ global: true, prepend: true }`）。
  原来那条路是 `ctx.userQuestions.registerProvider`——它有两个问题：①这一代宿主的服务里
  `provider` 这个词**零命中**（成员只有 `ask / askTimed / answer / continued / releaseReply`），
  所以开了 `takeOverQuestions` 也只是在 status.json 里多一行 `no registerProvider (keys=…)`，
  手机上永远不会有提问卡；②就算有，"注册一个提供者"是**单提供者**语义，接管就意味着桌面问不了问题，
  那是插件在改变宿主的行为。参与 waterfall 才是既两端同弹、又不吞掉桌面那一条的形状
  （取证：`UserQuestionService.ask()` 末端就是 `ctx.waterfall(scopeTarget(agent, agent), …, noAnswerer)`，
  桌面 UI 是网关转发的 `$on("user-questions/request", …)`）。
- **`takeOverQuestions` 这个键已经不生效**（README 的配置表里标了删除线）。删掉键本体要动
  `shell/config.ts` 与 `index.ts`，而这两棵树此刻正被另一条在飞的改动占着，所以留作单独一轮；
  `describe()` 里 `takeOverQuestionsInert` 会把"它不再管事"说清楚，别拿 `questionsFace` 当它还在管。
- **收回卡片改成按 `requestId` 精确收单**：结算点在补 `ev.run_state`（手机上装的那一版只认这条）
  之外，另发 `ev.permission_resolved` / `ev.question_resolved`（`by: 'desktop' | 'cancelled'`）。
  依赖升到 `dsh-remote-wire@1.2.0`——那两帧与提问的 `expiresAt` 都在那一版里。
- **提问请求带上 `expiresAt`**（= `questionTimeoutMs`，默认 300 秒）。审批那条一直有，提问这条没有，
  于是主机早就判"没答上"了而手机上那张卡看不出什么时候作废。
- 提问面新增四条读数进 `status.json`：`questionsFace` / `questionsCalls` / `questionsLast` /
  `questionsDesktopVoided` / `questionsSignalHandoff`，与审批面同一套。
  落点写成 `answered-by-phone(1 项)`——**只报题数，答案正文不进 status.json**。

### 修复

- **手机断开之后，主机不再往那条空会话广播**。真机实测：45 秒里中继 `droppedFrames` 涨 9，
  与插件 `session_changed` / `model` / `keep_awake_state` 各涨 3 **逐帧对得上**；
  而那条会话 `clients=0`、默认 7 天 TTL——它就是 `droppedFrames` 的主要来源，
  原来"丢帧集中在活动窗口"的判断是被这一路噪声带着走的。
  根因是一个名字：`hasPeer()` 答的是"**我手里有没有这条通道的密钥**"，
  而调用方要的是"**现在有没有人能收**"。两者在手机上线时恰好同真，所以错误一直藏着。
  现在拆成两个概念：`ConversationBook.has(id)`（有密钥，D3 重连要用，必须留着）与
  `hasClient(id)`（成员表非空），`send()` / `broadcast()` 只认后者。
  **真机 A/B 复测**（配对让 runtime 起来、再让手机断开，造出同一幕 `conv=1 / clients=0`）：
  62 秒里中继 `droppedFrames` **5878 → 5878 一动不动**（改之前是 45 秒涨 9），
  而插件本地照旧记 `session_changed_no_peer` +4——"主机想发、当时没人听"是本地事实，
  它不该变成中继指标里的一次丢帧。
- **顺带修掉一个更早存在的错**：成员表原来**只靠"收到过这台手机的 enc 帧"长出来**，
  而手机回前台时中继发的那条**不带 `pairingToken` 的重连通知**在本端是直接 `return` 的。
  后果是 `status.json` 里"有几台手机连着"在重连之后会短暂报 0，且任何以"有没有活客户端"
  为准的判断都慢一拍。现在两条 `peer-joined` 都登记成员。
  ⚠️ 有一条旧的测试期望因此改了：`peer-left` 之后 `send()` 现在返回 `false`。
  它当初防的是"手机切个后台就再也收不到更新"——那个性质现在由**重连之后必须能再发**
  来守（同一个测试里两半都钉住了），而不是靠"没人也照发"。
- **审批卡终于能弹到手机上了**（真机 2026-10-03 深夜～10-04 凌晨，两轮才修对）。
  根因不在我们读请求的那几行，在**登记的方式**——`ctx.on('approval/request', …)` 少了两个选项，
  各对应一种"没弹"：
  1. **`global: true`——不被作用域过滤掉**。宿主用
     `ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req, next)` 派发，
     cordis 的判据是 `hook.global || !filter || filter.call(thisArg, hook.ctx)`，而那条 filter
     只放行"未打作用域标签的上下文"与"派发键的**祖先**作用域"（原文：
     'A tag BELOW the dispatch key stays excluded — events flow up the chain, never down'）。
     插件那条 fiber 与 agent 作用域是**兄弟**，于是登记成功、`approvalFace` 报 `registered`、
     监听器一次都不会被调用。
  2. **`prepend: true`——排在桌面那位应答者前面**。只加 `global` 之后真机复测仍然
     `approvalCalls=0`，而新的审计字段显示 `approvalAsked=1`、`approvalDecided=not-seen`：
     请求**确实派发了**，但 waterfall 是"外层不 `next()` 内层永远轮不到"，而
     `dispatch()` 返回数组的第一个就是外层（`register()` 用 `unshift` 实现 prepend）——
     桌面 UI 的应答者登记得更早，它一拿到请求就去等真人点按钮且不 `next()`。
  最终形状（真机一次完整闭环的读数）：`approvalCalls=1`、`approvalLast=answered-by-phone(allowed-once)`、
  `approvalDecided=allowed-once`、`outbound.permission_request=1`，手机侧探针收到的卡是
  `{action:'write', reason:'escalate sandbox to workspace-write: …', options:[允许一次, 拒绝], expiresAt:…}`。
- ⚠️ **但上面那次修复自己引入了一个新的回归，被用户当场指出：手机上弹了，桌面上 DSH 不弹了。**
  根因就是 `prepend` 的另一半：我们排到最外层之后**在那儿等手机**，而 waterfall 是
  "外层不调 `next()`，内层就永远轮不到"——等于插件把宿主自己的审批窗吞掉了。
  **插件不许改变宿主的行为**，这条比"手机上能弹"更硬。
  现在的形状是**两边同时问、谁先给出真实决定谁算**：一进 `participate()` 就立刻 `next()`
  把桌面启动起来，手机并行问，两边赛跑。
  "答"的判据要收紧：手机侧的 `'decline'`（超时）/`'cancelled'`（被撤回）与链子末端的
  `'unavailable'`（没人可问）**都不算答案**——否则"手机没电"会变成"自动拒绝"、
  "桌面暂时没人"会变成"手机还没点就失败"。桌面先答时我们 `abort` 自己那条信号，
  手机这一侧立刻作废（`pending` 条目删掉、`waiting` 角标归零）。
  每一路赛跑结果都**带着"是谁答的"回来**：`'rejected'` 这个词两端都可能给，
  只比数值就不知道该不该收卡（第一版就是这么错的，测试把它钉住了）。
  **任意一端答完，其他端那张卡当场作废**（这一轮补上的一条）：
  - **手机先答 → 桌面那张卡消失**：交给链子下游的那份 `request.signal` 被换成
    `AbortSignal.any([平台的, 我们这条])`，手机答完就撤销我们这条。宿主的 api-gateway 在
    它断掉时向**每一个**渲染端推 `{type:'cancel', eventId}`，卡片由宿主自己的代码收——
    我们只是宣告"这次请求结束了"，不替桌面决定结果（DSH 自己在多窗口场景本来就是这么做的：
    第一个客户端给出结果时其余客户端都收到 cancel）。
    ⚠️ 这条路只有读码读得出来：`next()` 忽略实参（换不掉下游收到的请求对象），
    `ApprovalService.decide` 又在派发**之前**就读走了原件，所以能动的就是那一个字段。
  - **桌面先答 / 平台撤回 / 主机超时 → 手机上那张卡消失**：结算点补发一帧 `ev.run_state`。
    这条帧本来就是小程序认的"挂着的审批/提问卡作废"的唯一信号（它同时清审批卡与提问卡、
    并停掉那条本地倒数），而内核**不会**为"审批被别人答掉了"发状态跳变（这一回合自始至终
    是 running），所以只能由主机补发。补的是内核当前真相，读不到才退缓存快照、再退 `idle`。
    协议里那条按 `requestId` 精确收单的 `ev.permission_resolved`（wire `66e9a63`）仍然待发——
    本仓装的 `dsh-remote-wire` 是 npm 上的 1.1.0，那份里还没有这一帧（追踪：伞仓 HANDOFF §3.10）。
  ⚠️ **代价写在代码注释里**：排到最外层意味着也排在 Auto 预置的自动审阅之前。本机没配 Auto
  （profile 里只有 read-only / workspace-write / danger-full-access），所以没有安全闸门被跳过；
  哪天接上 Auto，这一行要重新审。
- **`approvalFace` 不再被当成"能弹卡"的证据**：`status.json` 的 kernel 面新增四条读数——
  `approvalCalls`（监听器被调用次数）、`approvalLast`（最后一次走到哪一步：
  `answered-by-phone(…)` / `handed-back(no phone target)` / `handed-back(neither answered)`）、
  `approvalAsked`（内核报过几次 `approval/asked`）与 `approvalDecided`（最后一次 `approval/decided`
  的 outcome）。**"没人答"与"别人抢先答了"在现场长得一模一样**，只有 `decided` 能把它们分开——
  这一轮就是靠它从"还是被过滤了"翻到"是排在桌面后面"，少一个字段就要多猜一轮。
- 关弹窗这一半再加两条读数：`approvalSignalHandoff`（`fused` / `ignored` / `failed: <原因>`——
  请求对象的 `signal` 到底换没换成可撤销的那一份）与 `approvalDesktopVoided`
  （手机先答之后撤销了几次，**只在换成功时才计**）。屏幕上看不出桌面那张卡收没收的时候，
  这两个数就是唯一的现场证据：加了而卡还在 ⇒ 断在渲染端；没加 ⇒ 我们这侧没换成功。
- `src/transport/relay.ts` 的 Prettier 格式（随 `4e2528c` 提交进来的长签名），`format:check` 全绿。

- **手机聊天框不再出现原始 XML、工具标题是人话、结果预览不再是乱码**（三件事一个根因：
  内核事件到插件事件的形状映射）。① `assistant/message` 的正文里带着 XML 序列化的工具调用
  （与结构化 `tool/call` 事件是同一信息的第二份副本），剥掉后只留正文，剥完是空串时
  仍发空正文帧（mp 对空正文不建块）；② 工具步骤标题改取模型写的 `description`——
  原来整串贴 455 字符的 JSON；③ `tool/result` 的正文是 part 数组，旧实现 `JSON.stringify`
  出字面量转义（手机上就是一片乱码），改成取文本（数组取文本 part、对象按字段递归、
  非文本 part 跳过）。历史回放走同一个映射函数，旧会话翻上去也是干净的。

### 测试

298 项（上一版 290）。**跨端关弹窗这一轮新增八条，六次变异验证各自只抓到自己那条**：
`carrier-services.test.ts` 三条——**手机先答时下游那份 `signal` 必须已被换掉且已撤销**
（不换 / 不撤 / 撤销时连 runtime 那侧一起带倒，三种变异都红）、
**平台中断时并算后的 signal 要保住原来的取消能力，`reason` 也要带下去**、
**`signal` 不可写时不许抛**（严格模式给冻结对象赋值会抛，一抛就顺着 waterfall 把宿主的审批判死）；
`runtime.test.ts` 五条——**桌面先答/超时/撤回三种收场都要补一帧 `ev.run_state` 并留 reason**
（不补 → 5 红；reason 不区分"桌面先答"与"平台撤回" → 1 红）、
**手机自己点掉时不许补**、**内核读不到真相时退缓存快照、再退 `idle`**、
**提问那两类共用同一个结算点**。
`carrier-services.test.ts` 为"两边同时问"新增三条，**第一条就是那句红线**：
**手机先答也必须把链子交给桌面（`next()` 要跑到）**（把 `next()` 那一行拿掉它就红，已变异验证）、
**桌面先答时手机那一侧必须被 `abort`（否则手机卡继续倒计时、`waiting` 角标也不会归零）**、
**手机超时不算答案：桌面稍后给出的真决定必须赢**。
`client-bundle.test.ts` 为"等 N 件事"新增四条：**有东西在等时抬头说
`等 2 件事`、灯是 amber，面板第一行是 `待处理 · 2 件 · 最久 4 分 12 秒`**（把 `pillLabel` 里那条
分支删掉它就红，已变异验证）、**两条优先级：断链压过等待；没配上时挂起不抢抬头那一格，
但面板仍然要说**、**等待时长的四档写法（37 秒 / 1 分 0 秒 / 4 分 12 秒 / 121 分，全部走打出来的
bundle，不直接 import 那个纯函数）**、**`waiting` 缺席（老版宿主）时那一行不建、抬头退回"已配对"**。
新增 `host-id.test.ts` 九条，其中三条是**去掉"读回旧身份"那行就会红**的
判据（重启拿回同一个身份 / 老的 `h_xxxx` 不许借机换号 / 两个实例抢同一目录只有一个胜出），
另外守住 0600、不认的形状要修好并落回去、目录不可写时退回一次性值且不抛。
`carrier-services.test.ts` 新增四条：**登记必须带
`{ global: true, prepend: true }`**（两个选项各摘一个都会红——它们测的不是"挂没挂上"，
而是"挂的地方收不收得到、收得到的时候排不排得到"）、
**被调用时 `approvalCalls`/`approvalLast` 要记到 `answered-by-phone(…)`**、
**没有会话 id 与手机超时两条交还路径要分得开，且都必须 `next()` 交还桌面**、
**审批审计的 `approvalAsked`/`approvalDecided` 要进 status.json**（`decided` 记最后一次的 outcome）。
`client-bundle.test.ts` 新增四条：**"配上之后从二维码翻回状态视图"**
（翻面只重画，不许顺手再要一张）、**"样式表按内容对齐"**（预置一份旧 `<style>`，要求它被换掉、
且不许插第二份）、**"正文三行各自拿不到值时不占地方"**（老版路由没给 `version` 时那一行消失）
与**"`状态` 按 relay 取值翻译"**（连接中 / 已断开 / 未启动）。另外三条按新行为改判：
断链时说 `已断开连接` 且 `tone=error`、二维码页那颗按钮叫 `刷新`、过期后按钮仍是 `刷新`。
`pill-isolation.test.ts` 的 `/status` 字段集合断言加了 `version`，并钉住"源码直跑时它是 `dev`"。

## [1.2.0] - 2026-10-03

这一版把"界面上那一半"收敛成**一条路**：状态栏那颗 pill。右栏自动弹码与终端文本码同时删除，
`/drc pair` 也不再是配对入口（**破坏性变更**，见下）。

### 新增

- **状态栏那颗 pill：抬头是状态，点开是连接信息，发码要再按一次**。宿主侧三条同域路由——
  `POST /plugins/dsh-remote-control/pairing/new`（幂等发码）、`GET /plugins/dsh-remote-control/pairing.png`
  （弹窗里那张二维码，按需现渲染，`no-store` + `ETag` 用同一口径的 epoch）、
  `GET /plugins/dsh-remote-control/status`（四个非凭据字段：`relay` / `paired` / `hostLabel` /
  `serverUrl`）。浏览器面把一颗 pill 注册进宿主的 `conversation.composer.dock` 槽位：
  抬头那句是 `远程未启动` / `远程未连接` / `连接中` / `未配对` / `已配对`，灯分别是灰 / 灰 / 黄 / 灰 / 绿
  （"有码还没人扫"不再单列一句，也不再给绿灯——绿只能表示真配上了一台）。点一下弹面板，顶部那几行
  就是上面四个字段读出来的**连接信息**（本机名、中继 `host:port`、状态、配了几台），发码是面板里那颗
  **生成配对码**（已配上时改叫**再配一台**）——点开不再顺手向中继申请码，"看一眼"不该消耗 pending 表。
  按下去之后二维码与 6 位数字同时在场（扫不出来时的唯一退路），寿命走完自动再要一张。
- 三条回答里**都不含 `psk`，也不含完整配对 URI**。发码那条是**会改状态**的路由，跨站判据是一个
  只有同源脚本发得出的自定义头 `x-drc-pair: 1`（跨站要带它必然触发 CORS 预检，而这条服务不答应
  预检）；`Origin` 存在时仍要判（环回 http(s) 或宿主自己的 `dsh-app:` 这类自定义 scheme），
  但**它缺席不是拒的理由**——桌面宿主转发 web 请求时会在更外层把 `origin` 头删掉，这一条是
  2026-10-03 在真屏幕上点出来才发现的（当时判据写成"Origin 必须存在"，于是 pill 渲染得好好的、
  点下去永远 403）。403 回答里因此带上**是哪一道守卫**（`guard:"pair-marker-missing"` 等），
  并由 pill 印在弹窗上：宿主 stdout 不落盘，屏幕上那句话是浏览器面唯一的现场。
- `status.json` 的 `pill` 探针（`webServer` / `routes` / `pill`）与一条 `warn:pill`：
  配对入口不可用时必须查得到原因——命令行兜底删了以后，"配不了对"不该是静默失败。
  那条 warn 是**每次写快照时现判**的，不是 `apply()` 里一次性 push：`webServer` 可能由
  `ctx.inject` 的回调晚到，一次性判断会留下 `routes:"registered"` 与 `problems:["warn:pill"]`
  并存的假警报（2026-10-03 真机重装重启后实测抓到，`pill-isolation.test.ts` 里
  "webServer 晚到"那条用例钉住它）。
- 半途失败要回滚：三条路由依次挂，第二条挂不上时第一条**必须被注销掉**，否则它永久留在宿主上、
  `stop()` 再也拿不到注销函数，表现是"重载一次之后那颗 pill 再也不出现"。

### 删除（破坏性）

- **右栏自动弹码那一半整个删除**：宿主侧按节拍渲染 PNG 落到会话工作区、那条只读路由
  `GET /plugins/dsh-remote-control/pairing`、以及浏览器面 `sidebarRight.openResource` 的轮询。
  连带删掉的模块：`src/presentation/{address,presenter,route,sidebar}.ts`（守卫与 `pairingEpoch`
  搬进 `pill-routes.ts`，只留一份）。
- **终端文本码删除**：`platform/qr.ts` 的 `renderTerminalQr` 与 `ascii`/`block`/`half` 三种样式、
  ANSI 反色。理由是它在这个唯一宿主上从来扫不出——DSH 命令卡按 `line-height:1.6` 渲染等宽输出，
  行间留白把半块码横切成条，实测 zxing 在 ≥1.15 行距即失败（取证仍留在 `qr.ts` 文件头）。
- **`/drc pair` 不再是子命令**：`/drc` 只剩 `status` 与 `unpair`。它走的是"每次发一张新码"，
  会在 pill 那张之外再多挂一个仍然有效的 PSK，而手机扫的是屏幕上那张——正是当初"多码事故"的形状。
  打字习惯还留在 `/drc pair` 上的人拿到的是状态快照，不是错误。
- 配置键删除：`qrImage`、`qrOpen`、`qrAnsi`、`qrStyle`、`sidebarQr`（含 `imageFile`/`refreshMs`）。
  留在 patch 里**不产生任何效果**，也不会有 warn（当天先做过一张"退役键各报一条 warn"的表，
  随后按"删了就不会回来，用到再重写"撤掉——见下面"清理"那节）。环境变量
  `DRC_QR_IMAGE`/`DRC_QR_OPEN`/`DRC_QR_ANSI`/`DRC_QR_STYLE`/`DRC_SIDEBAR_QR` 同样删除，
  新增 `DRC_PILL=0/1`。
- **为右栏而开的内核口一起删除**：`provide('dshRemoteControl').sessionWorkspace`（"会话 → 工作区目录"
  那个口原来是给右栏那张图算落点的）、内核侧实现 `kernel.sessionWorkspace`，以及只为它存在的诊断字段
  `kernel.workspaceFace`。pill 的二维码是路由**当场渲染、当场回字节**的，不再往磁盘写，所以这条路上
  已经没有任何调用方。

### 变更

- 一次启动现在挂 **3 条**路由（1.1.0 是 1 条，pill 第一版是 4 条），停机一起注销。
- 浏览器面的服务声明从 `inject: ['sidebarRight']` 改为 **`inject: ['slots']`**（右栏那半删掉了，
  `slots` 才是这一半真正要的那个服务），写法照宿主自带的 `templates/decoration/client.js`：
  `ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(...))`。
- **删除过程中抓到并修掉一个真缺陷：那颗 pill 整颗不出现**。把声明改成空 `inject: []`（当时想
  让 `slots` 走软探测）之后，`apply()` 跑在槽位服务之前，而 `mountPill` 只软探一次就返回——
  屏幕上再也没有那颗按钮，而**当时 262 项单测全绿**（假上下文只给同步的 `ctx.get`，演不出"服务
  还没到"）。旧的 `['sidebarRight']` 无意中把激活时机推到了服务齐之后，所以第一版看起来是好的。
  现在三样一起有：`slots` 声明进 `inject`（正路）、软探测与 `ctx.inject(['slots'], …)` 的晚到回调
  两条退路（回调里只 mount 一次），以及一条能演"晚到"的测试（`client-bundle.test.ts`
  的 `lateSlots`/`flushInject`）。`apply` 时没探到的那句 warn 改成"已挂回调等晚到"，不再断言
  "这代宿主没这个服务"。
- **那颗 pill 在挤不动的那一排里不再逐字断行**。宿主 dock 空间不够时会把每一项自己截断
  （`6 轮 …`、`1.6M to…`），而按钮本身是 flex 项、默认可以缩到"中文的最小内容宽度 = 一个字"，
  于是 `已连 1 台` 竖着排成四行（2026-10-03 用户截图）。现在 `.drc-pill` 写死
  `flex: 0 1 auto; white-space: nowrap`，`.drc-label` 给 `min-width: 0` + `text-overflow: ellipsis`，
  与邻居同一个形状；全文仍然在 `title` 与 `aria-label` 上，悬浮和读屏都不丢。
- 配对二维码的编码/解码防回归（伞仓 `scripts/validate-qr.mjs`）从"三条产物"降到两条：
  PNG 与裸矩阵。

### 清理（同一轮，按"没用的就删，用到再重写"）

- **`apiProxy` 那条载体探都不探了**：这一版从一开始就不接它（桌面态没注册过这个服务，旧实现的
  调用信封整个是错的），却仍然 `ctx.get` + `ctx.inject` 各探一次、把结果收进 `collected` 里等一个
  永远不会来的调用方。现在这两块连同 `apiProxyOf()` 一起删掉，注释里写清"真要用再写"。
- **没人读的口与写盘遗物**：`writePrivateFile`（右栏那张 PNG 落盘时代的工具，现在只有测试调它）、
  `StatusFile.refreshing` 与 `StatusFile.path` 两个 getter（注释声称"测试读它"，实际零调用方）。
- **零消费者的导出**：`HISTORY_LIMIT_DEFAULT`（与 `runtime.ts` 里那份是同一个常量的两份）、
  `ports` 的 `PeerSink`/`PendingQuestion`/`TransportPort`/`AnswerItem`、`guard` 的
  `SubscribableEvent`/`WaterfallParticipant`、`qr.ts` 的 `qrModuleCount`，以及 `redactSecret` 与
  `redact` 这个双名导出（合成一个名字）。
- **退役配置键的 warn 表删除**（见上面"删除"那节），连带 5 条断言。
- 顺带清掉 `tsc --noUnusedLocals --noUnusedParameters` 报出的全部未用导入与未用局部。
- **"presentation" 这个名字全部清掉**（右栏方案删了之后它已经什么都不指了）：
  `src/presentation/` → **`src/pill/`**（`pill-routes.ts` → `routes.ts`、`pill.ts` → `start.ts`），
  三张测试改名 `pill-routes.test.ts` / `pill-isolation.test.ts` / `client-bundle.test.ts`，
  全部 import 与注释引用重接；`scripts/install-to-profile.sh` 里为第二个 cordis 条目
  （`dsh-remote-control-presentation`，从未发到 npm，只有本机 profile 装过且早已摘掉）
  留的退役清理也删了——那是一段永远命中不到的迁移代码。
  **同轮修掉一个真隐患**：那个脚本每次运行都往 profile 里多写一份
  `package.json.bak-drc-<时间戳>`，本机已经堆到 **83 份带 `hostToken` 的副本**；
  现在改成单份滚动 `package.json.bak-drc`，并在写入前清掉历史遗留的时间戳副本。

### 测试

265 项（1.1.0 是 280 —— 那 280 里含 72 项属于这次删掉的两条路，另 3 项属于现在没人调的
`sessionWorkspace`）。删掉 5 个只属于那两条已删路径的测试文件；
`pill-routes.test.ts`（22 条）、`pill-isolation.test.ts`（8 条，含
"配对入口只有 pill：两种宿主上 hint 都不许再宣传 pair"与"webServer 晚到时 warn:pill 必须自己消失"）、
`client-bundle.test.ts`（22 条，在 vm 里真跑打出来的 `client.cjs`，含"`slots` 晚到时那颗 pill 必须补挂"、
"点开只给连接信息、不许顺手发码"、"抬头那句不许把中文逐字断行"）。
伞仓 `e2e/run.mjs` 新增一步：**真中继在线**时点那三条路由——发码、幂等复点同一张、
出的 PNG 与主机维护的那张码同一个 epoch（单测里发码分支永远是"中继不可达"，那条路此前从没走过）。

## [1.1.0] - 2026-10-03

### 新增

- **右栏自动弹码进主插件**：一次构建产出两半——宿主侧 `dist/bundle/index.js` 与浏览器面
  `dist/bundle/client.cjs`。`/drc pair` 之后当前配对码落成 PNG、经一条同域只读路由交给浏览器面，
  右栏自动弹出那张图：不需要用户手动打开侧边栏，也不静默切换工作区。
- 配置项 `sidebarQr`（`enabled` / `imageFile` / `refreshMs`）；环境变量 `DRC_SIDEBAR_QR=0` 可整体关掉。
- `status.json` 多一块 `sidebar`：右栏那一半的软探测结果（`route=registered` / `webServer=none` /
  `disabled` / `register threw: …`）。"二维码没弹"从此有第一现场，而不是只能猜。
- `tests/pill-isolation.test.ts`：同一个假上下文跑两遍 `apply()`，只差有没有 `webServer`，
  要求主链路可观察字段**逐个相等**、`/drc` 返回**逐字节相等**。

### 变更

- **删除 `packages/presentation`**，包名 `dsh-remote-control-presentation` 退役，本仓只剩一个包。
  原来拆两包只是为了在宿主没有 `webServer` 服务时"只有那一行不激活"；折成一个包之后这个隔离
  由代码提供（`src/presentation/sidebar.ts` 只软探测 `webServer`，拿不到就整半不起）。
- 只读路由随 bundle id 改名：`/plugins/dsh-remote-control-presentation/pairing` →
  `/plugins/dsh-remote-control/pairing`。同域、只读、环回+来源守卫三条不变。
  profile 里若还留着旧条目，`scripts/install-to-profile.sh` 会把它从 `dsh.profile.bundles`
  与 `node_modules` 一起摘掉——留着只会多一条"bundle 在列表里但目录已删"的加载失败记录。
- 发布产物收窄为 `dist/bundle` + `cordis.patch.yml`。`exports` 只指向自包含单文件，
  之前 tarball 里的 `dist/src`、`dist/tests`（约 90 个文件、449 KB）全是消费方拿不到的东西。

[未发布]: https://github.com/providcc/dsh-remote-control/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/providcc/dsh-remote-control/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/providcc/dsh-remote-control/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/providcc/dsh-remote-control/releases/tag/v1.0.0

## [1.0.0] - 2026-10-03

### 新增

- DSH Remote Control 宿主侧插件的首次公开发布（npm 包 `dsh-remote-control`，本仓 monorepo 产出）。
- 与零知识中继的配对与长连接；主机认证与自动重连。
- 会话发现、指令下发、流式输出回传；审批（提问）转发到手机并可回答。
- 防休眠策略：有会话时保持唤醒，空闲后自动释放（`caffeinate` / `systemd-inhibit`）。
- 配对二维码渲染：默认出 **PNG**（文本码在 DSH 命令卡的行高下扫不出来），可落到会话工作区 `.dsh`。
- 本仓第二个 bundle `dsh-remote-control-presentation`（`private`，不发 npm）：把当前配对码落盘并
  暴露一条同域只读路由，浏览器面轮询它并**自动推开右栏**——不需要用户手动打开侧边栏，也不静默切换工作区。
- 状态快照 `status.json`（0600）作为 GUI 宿主的排错入口，密钥字段一律脱敏。
- 对宿主内核面的软探测：不写 inject 闸门，缺服务时受影响面最小。
- 自包含单文件产物（esbuild），安装只需拷文件 + 注册 bundle，profile 里不需要 `node_modules`。

