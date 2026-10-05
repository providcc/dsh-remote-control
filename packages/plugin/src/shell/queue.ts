/**
 * shell/queue — 主机侧的排队表（2026-10-05 用户：排队问题很多，重做；
 * 以 dsh 为准，双端一致）。
 *
 * ── 为什么主机必须自己排队 ────────────────────────────────────────────
 * 旧行为：`cmd.send_prompt` 一到就 `followup` 出去，主机不留任何痕迹。
 * 于是"排队"只剩手机自己的一份乐观列表——主机转发了什么、还剩几条、
 * 哪条已经发不出去，手机一律不知道。这就是"没有双向同步"。
 *
 * 而且 `agent.followup()` **不返回句柄**，宿主也没暴露删除 inbox 的入口
 * （取证：包里只有 followup / steer / cancel 三个可用方法）。
 * 所以发出去的消息就再也撤不回来了。
 *
 * 结论：**只有还扣在主机手里的消息才删得掉**。主机必须自己当队列：
 * 消息进来先入表，这一回合还在跑就扣住，空闲了才逐条转发。
 *
 * ── 重做：治用户实测的三条罪状 ──────────────────────────────────────
 *   1. "显示正在跑，其实没跑"
 *   2. "mp 端无法取消"
 *   3. "在 dsh 创建的也要同步显示在 mp 端"
 *
 * 旧实现：`drainQueue` 一转发就 `markSent`，**不管内核有没有真的跑起来**。
 * 于是消息刚交出去、run-state 还没回，手机已经显示"在跑"；而内核要是
 * 压根没起回合（没有活的 agent、sendPrompt 静默成功），这条就永远停在
 * "在跑"——因为 `retireSent` 只在 run-state idle 时调，idle 不来就永不退休。
 *
 * 新实现：**状态只由内核的 run-state 驱动，不由"我们调用了 sendPrompt"驱动**：
 *
 *   held    主机还扣着。含"已转发但内核没确认在跑"——那时候确实没跑，
 *           说它在跑就是撒谎。**可删。**
 *   sent    run-state 说了 running。**这才叫在跑。** 删除 = 中断这一轮。
 *   failed  转发就没成功（业务拒绝或抛异常）。**可删**，带原因。
 *
 * 顺带解决"无法取消"：held 照旧从表里拿掉；sent 走 `kernel.interrupt`
 * ——那是宿主确实有的能力（`cancel` 方法），关掉当前回合。
 * 回执说清"已中断"，不假装"已删除"。
 *
 * ── dsh 侧创建的消息（第三条罪状）──────────────────────────────────
 * 手机发的走 `enqueue`；主机自己发的不经过 `cmd.send_prompt`，表里本来没有。
 * 靠两个信号补：
 *   - run-state → running 且本会话没有可提升的 held 项 → 主机自己起的回合，
 *     造一条 `origin: 'host'` 的占位项（文字等回填）；
 *   - delta 里 `role === 'user'` 的回传 → 把文字填进那条占位项；没有占位项
 *     就新建一条（主机发了但 run-state 还没到）。
 * 这样主机侧发起的回合在手机上同样看得见、同样能中断。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────
 * 1. **快照永远全量**：队列短，全量替换比增量好推也好对。
 * 2. **失败不丢消息**：转发失败的那条留在表里（state=failed）让用户看见。
 * 3. **origin 只在主机内部**：不进协议快照，手机不需要知道消息从哪来。
 */

import type { QueueItem } from 'dsh-remote-wire/payloads'

/** 表里一项的完整形状（比协议里的 QueueItem 多带 sessionId / 附件数 / 来源）。 */
export interface QueuedMessage {
  /** 手机发 send_prompt 时带的 queueId；老手机不带就由主机补一个。 */
  queueId: string
  sessionId: string
  text: string
  images: number
  files: number
  state: 'held' | 'sent' | 'failed'
  /** state=failed 时的原因，原样给手机显示。 */
  message?: string
  /**
   * 这条是谁发起的。'host' = 主机自己起的回合（用户在 DSH 里发的），
   * 它的文字要等用户消息回传（delta role=user）才能填上。
   * **不进协议快照**——手机不需要区分，它只关心状态。
   */
  origin?: 'phone' | 'host'
  /**
   * 已经交给内核了，但内核还没确认在跑。
   * **对手机那一侧仍然显示 held**：它确实还没跑，说它 sent 就是撒谎。
   * 但内部必须记住“这条出过手”，否则第二次 drain 会把同一条再转一遍
   * （2026-10-05 重做时踩到：去掉 markSent 之后，实测同一条主题转发两次）。
   * 删除时它的语义跟 sent 一样——出过手就只能中断。 */
  inflight?: boolean
}

/**
 * 队列本身。一个 Runtime 一份（跨会话共用）。
 *
 * 为什么不是每个会话一个：排队是**按转发顺序**的全局资源，一次只有一个回合在跑；
 * 分成多个表就要在它们之间选谁先转发，那正是这个表存在的理由。
 */
export class PromptQueue {
  private items: QueuedMessage[] = []

  /**
   * 当前是否正忙：内核说在跑，**或者**一次转发正在进行中。
   * 两者都要拦住 drainQueue——前者会重复转发，后者会同一批转两遍。
   */
  private busy = false

  /** 队尾追加。同 queueId 覆盖式去重（手机重发同一条时不该出现两份）。 */
  enqueue(msg: QueuedMessage): void {
    const at = this.items.findIndex((it) => it.queueId === msg.queueId)
    if (at >= 0) {
      this.items[at] = msg
      return
    }
    this.items.push(msg)
  }

  /**
   * 删一条。返回 false = 不在表里（已经转发出去 / 已经删过 / 从没来过）。
   *
   * 调用方要能区分"删掉了"和"删不掉"，所以这里不给静默成功。
   */
  drop(queueId: string): boolean {
    const before = this.items.length
    this.items = this.items.filter((it) => it.queueId !== queueId)
    return this.items.length !== before
  }

  find(queueId: string): QueuedMessage | undefined {
    return this.items.find((it) => it.queueId === queueId)
  }

  get empty(): boolean {
    return this.items.length === 0
  }

  get isBusy(): boolean {
    return this.busy
  }

  setBusy(busy: boolean): void {
    this.busy = busy
  }

  /**
   * 取出这个会话所有还没转发过的消息（按入队顺序）。
   *
   * **failed 的不取**：它已经失败过一次，转它只会再失败一遍；
   * 但它继续留在表里（纪律 2），用户看得见、也能删。
   */
  /**
   * 取出这个会话还没交出去过的消息（按入队顺序）。
   *
   * **inflight 的不取**：那条已经转给内核了，再取就是同一条发两次。
   * **failed 的不取**：它已经失败过一次，转它只会再失败一遍；
   * 但它继续留在表里（纪律 2），用户看得见、也能删。
   */
  takeHeld(sessionId: string): QueuedMessage[] {
    return this.items.filter((it) => it.sessionId === sessionId && it.state === 'held' && !it.inflight)
  }

  /** 标记一条已经交给内核（还没确认在跑）。 */
  markInflight(queueId: string): void {
    const it = this.find(queueId)
    if (it) it.inflight = true
  }

  /**
   * 回合真的开始了：把本会话所有 held 提升为 sent。
   *
   * **这个方法取代了旧的 markSent**。旧版在 drainQueue 里、转发一结束就调，
   * 于是"交出去了"被当成"在跑了"——用户看到的就是"显示正在跑，其实没跑"。
   * 现在只有内核说 running 才调；在那之前它们安安静静地当 held，
   * 手机显示"等主机消化"，而且**还删得动**。
   *
   * @returns 被提升的 queueId 列表（空 = 这一回合不是我们的消息起的）
   */
  markRunning(sessionId: string): string[] {
    const promoted: string[] = []
    for (const it of this.items) {
      if (it.sessionId === sessionId && it.state === 'held') {
        it.state = 'sent'
        promoted.push(it.queueId)
      }
    }
    return promoted
  }

  /**
   * 保证有一条"主机自己起的回合"的占位项，返回它。
   *
   * run-state 说 running 但我们没有任何 held 项可提升时调用——那说明这一回合
   * 是主机侧发起的（用户在 DSH 里发的，或别的入口），手机那边看不见。
   * 造一条 origin=host 的项，文字先空着，等用户消息回传填。
   *
   * 幂等：已有占位项就返回它，不重复造。
   */
  ensureHostSlot(sessionId: string): QueuedMessage {
    const existing = this.items.find((it) => it.sessionId === sessionId && it.origin === 'host')
    if (existing) return existing
    const slot: QueuedMessage = {
      queueId: 'h' + Math.random().toString(36).slice(2, 10),
      sessionId,
      text: '',
      images: 0,
      files: 0,
      state: 'sent',
      origin: 'host',
    }
    this.items.push(slot)
    return slot
  }

  /**
   * 主机侧用户消息的回传到了：把文字填进占位项。
   *
   * @returns true = 填上了（这一帧确实是主机侧回合的回传）
   */
  fillHostText(sessionId: string, text: string): boolean {
    const slot = this.items.find((it) => it.sessionId === sessionId && it.origin === 'host' && it.state === 'sent')
    if (!slot) return false
    if (!slot.text && text) slot.text = text
    return true
  }

  /**
   * 回合结束：把所有 sent 的项撤掉。
   *
   * 为什么是"撤掉"而不是"留着"：主机回传的用户消息这时已经进了消息流，
   * 再在排队条里挂一条只会让用户以为它还在等。
   */
  retireSent(): void {
    this.items = this.items.filter((it) => it.state !== 'sent')
  }

  markFailed(queueId: string, message: string): void {
    const it = this.find(queueId)
    if (it) {
      it.state = 'failed'
      it.message = message
    }
  }

  /** 该会话的快照（协议形状）。空附件数不带字段——协议里它们是 optional。 */
  snapshot(sessionId: string): QueueItem[] {
    return this.items
      .filter((it) => it.sessionId === sessionId)
      .map((it) => {
        const out: QueueItem = { queueId: it.queueId, text: it.text, state: it.state }
        if (it.images > 0) out.images = it.images
        if (it.files > 0) out.files = it.files
        if (it.message) out.message = it.message
        return out
      })
  }

  /** 清空（宿主关闭时用）。 */
  clear(): void {
    this.items = []
    this.busy = false
  }
}
