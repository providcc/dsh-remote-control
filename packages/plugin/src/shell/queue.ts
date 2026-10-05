/**
 * shell/queue — 主机侧的排队表（2026-10-05 用户：排队要双向同步、手机要能删）。
 *
 * ── 为什么主机必须自己排队 ────────────────────────────────────────────
 * 旧行为：`cmd.send_prompt` 一到就 `followup` 出去，主机不留任何痕迹。
 * 于是"排队"只剩手机自己的一份乐观列表——主机转发了什么、还剩几条、
 * 哪条已经发不出去，手机一律不知道。用户看到的就是"没有双向同步"。
 *
 * 而且 `agent.followup()` **不返回句柄**，宿主也没暴露删除 inbox 的入口
 * （取证：包里只有 followup / steer / cancel 三个可用方法）。
 * 所以发出去的消息就再也撤不回来了。
 *
 * 结论：**只有还扣在主机手里的消息才删得掉**。主机必须自己当队列：
 * 消息进来先入表，**这一回合还在跑就扣住**，空闲了才逐条转发。
 * 这样表里每一条都有 id、有状态，手机删得动，主机也推得出真快照。
 *
 * ── 为什么不用 agent 自己的 inbox 排队 ────────────────────────────────
 * agent 确实有 inbox（followup 就是往里塞）。但那是黑盒：进得去出不来，
 * 连"现在有哪几条"都问不出来。让它当队列，手机这边就只能靠猜。
 *
 * ── 三条纪律 ─────────────────────────────────────────────────────────
 * 1. **已经转发的一律不给删**：`ok:false` + 说清在跑了。给假成功比不给更糟。
 * 2. **快照永远全量**：队列短，全量替换比增量好推也好对。
 * 3. **失败不丢消息**：转发失败的那条留在表里（state=failed）让用户看见，
 *    而不是悄悄蒸发。
 */

import type { QueueItem } from 'dsh-remote-wire/payloads'

/** 表里一项的完整形状（比协议里的 QueueItem 多带 sessionId 与附件数）。 */
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
}

/**
 * 队列本身。一个 Runtime 一份（跨会话共用）。
 *
 * 为什么不是每个会话一个：排队是**按转发顺序**的全局资源，一次只有一个回合在跑；
 * 分成多个表就要在它们之间选谁先转发，那正是这个表存在的理由。
 */
export class PromptQueue {
  private items: QueuedMessage[] = []

  /** 当前是否正忙（有消息已转发出去、回合还没结束）。 */
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
   * 但它继续留在表里（纪律 3），用户看得见、也能删。
   */
  takeHeld(sessionId: string): QueuedMessage[] {
    return this.items.filter((it) => it.sessionId === sessionId && it.state === 'held')
  }

  /**
   * 把一批消息标成已转发。**不删**——还要留给 ev.queue 快照说"这条在跑了"，
   * 手机据此把删除按钮收掉（发出去的就删不掉了，这是真话不是猜的）。
   */
  markSent(queueIds: readonly string[]): void {
    const ids = new Set(queueIds)
    for (const it of this.items) {
      if (ids.has(it.queueId)) it.state = 'sent'
    }
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
