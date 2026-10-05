/**
 * 图片附件落盘（2026-10-04 加，配套 wire 1.3.0 的 cmd.send_prompt.images）。
 *
 * 为什么主机要落盘：内核端口 sendPrompt(sessionId, text) **只收文本**——这是宿主
 * 那一侧的既有契约，改它要动内核适配器（另一代际的事）。而「给会话里的 Agent 一张图」
 * 在这台机器上有个最朴素的通路：**存成一个文件，把路径写进 prompt 正文**。
 * DSH 的会话本来就能读自己工作区的文件，一行路径就是它能消费的形状。
 *
 * 三条纪律：
 * 1. **只收 jpeg**（与协议层同一个判断，这里是第二道）。相册选完 mp 已经压成 jpeg，
 *    收一张 png 进来只会得到「主机上没人读得了的类型」。
 * 2. **文件名收敛**：手机传来的名字是**不可信输入**（../../x 这种要能挡住）。
 *    会话 id 同样处理——它要当目录名。
 * 3. **写不进去就整条 prompt 失败**，不是「丢了图片照发」：用户的意图里包含这些图，
 *    静悄悄少发几张比明确失败更难查。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 一条落盘成功的图片。 */
export interface SavedImage {
  /** 收敛后的文件名（落盘用的那个）。 */
  name: string
  /** 绝对路径——prompt 正文里给 Agent 的就是它。 */
  path: string
  bytes: number
}

export interface SaveImagesOk {
  ok: true
  saved: SavedImage[]
  /** 落盘目录（排错用；不含文件名）。 */
  dir: string
}

export interface SaveImagesFail {
  ok: false
  /** 给人看的一句话（会原样回到手机上）。 */
  message: string
}

export type SaveImagesResult = SaveImagesOk | SaveImagesFail

/**
 * 文件名/目录名收敛：只留 [A-Za-z0-9._-]，其余折成 _；空串与超长都有兜底。
 * **点号开头的名字直接丢掉点**——.ssh 这种隐藏路径不该由一条手机消息造出来。
 */
export function safeSegment(raw: string, fallback: string, maxLen = 96): string {
  const cleaned = String(raw || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    // 开头与结尾的点/下划线/连字符**整段**丢掉：`../../etc/passwd` 折完是
    // `.._.._etc_passwd`，只去掉开头的点会剩一格下划线，里头还留着 `..`。
    .replace(/^[._-]+/, '')
    .slice(0, maxLen)
    .replace(/[._-]+$/, '')
  return cleaned === '' ? fallback : cleaned
}

/** base64 → Buffer。非法字符会被 Buffer 静默忽略，所以先按字符集拒一遍。 */
function decodeBase64(data: string): Buffer | null {
  if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) return null
  const buf = Buffer.from(data, 'base64')
  return buf.length > 0 ? buf : null
}

/** JPEG 魔数：SOI FF D8 FF。png 第一个字节相同但第二个是 89，对不上。 */
function looksLikeJpeg(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
}

/**
 * 把一批附件写进 <dir>/<safeSessionId>/，返回落盘清单或一句失败原因。
 *
 * maxCount / maxBytesPerImage 是**主机这边的闸门**：协议层也校（count、mediaType），
 * 但协议是别人写的版本，主机不能假设对面那一版一定校过。
 */
export function saveImageAttachments(options: {
  images: ReadonlyArray<{ name: string; mediaType: string; data: string }>
  dir: string
  sessionId: string
  maxCount?: number
  maxBytesPerImage?: number
}): SaveImagesResult {
  const maxCount = options.maxCount ?? 4
  const maxBytes = options.maxBytesPerImage ?? 4 * 1024 * 1024
  const images = options.images || []
  if (images.length === 0) return { ok: true, saved: [], dir: options.dir }
  if (images.length > maxCount) {
    return { ok: false, message: `一次最多带 ${maxCount} 张图片，收到 ${images.length} 张` }
  }

  // 先**整批评一遍**再落盘：被拒的批次一个字节都不该留在磁盘上。
  // （早先的做法是边验边写，前两张落完了第三张被拒——用户看到的是
  //   "两张图在主机上、第三条指令还失败了"这种最难查的半截状态。）
  const decoded: Array<{ img: (typeof images)[number]; buf: Buffer }> = []
  for (const [i, img] of images.entries()) {
    if (img.mediaType !== 'image/jpeg') {
      return { ok: false, message: `第 ${i + 1} 张不是 jpeg（${img.mediaType || '空'}），主机只收 jpeg` }
    }
    const buf = decodeBase64(img.data)
    if (!buf) return { ok: false, message: `第 ${i + 1} 张的解码失败（不是合法 base64）` }
    if (buf.length > maxBytes) {
      return {
        ok: false,
        message: `第 ${i + 1} 张有 ${Math.round(buf.length / 1024)}KB，超过单张上限 ${Math.round(maxBytes / 1024)}KB`,
      }
    }
    if (!looksLikeJpeg(buf)) {
      return { ok: false, message: `第 ${i + 1} 张的内容不是 jpeg（文件头对不上）` }
    }
    decoded.push({ img, buf })
  }

  const sessionDir = path.join(options.dir, safeSegment(options.sessionId, 'session'))
  const written: SavedImage[] = []
  try {
    fs.mkdirSync(sessionDir, { recursive: true })
    for (const [i, one] of decoded.entries()) {
      const base = safeSegment(one.img.name, `img-${i + 1}.jpg`).replace(/\.jpg$/i, '') + '.jpg'
      // 同名不覆盖：加序号而不是失败（手机按毫秒时间戳命名，撞上就是同一批重发）
      let name = base
      let n = 1
      while (fs.existsSync(path.join(sessionDir, name))) {
        name = base.replace(/\.jpg$/, `-${++n}.jpg`)
      }
      const file = path.join(sessionDir, name)
      fs.writeFileSync(file, one.buf, { mode: 0o600 })
      written.push({ name, path: file, bytes: one.buf.length })
    }
  } catch (error) {
    return {
      ok: false,
      message: `图片落盘失败：${String((error as Error)?.message ?? error).slice(0, 160)}`,
    }
  }
  return { ok: true, saved: written, dir: sessionDir }
}

/** 一批落盘成功的文件（图片之外的附件，2026-10-05 加）。 */
export interface SavedFile {
  /** 收敛后的文件名（落盘用的那个，扩展名保留）。 */
  name: string
  /** 绝对路径——prompt 正文里给 Agent 的就是它。 */
  path: string
  bytes: number
  /** 类型标签（来自手机的扩展名；可能为空）。 */
  mediaType?: string
}

export type SaveFilesResult = SaveImagesResult

/**
 * 文件附件的正文增补。与 {@link appendImageNote} 同一条理由（正文在后、空正文可用），
 * 多带一个类型标签：Agent 认文件靠扩展名，而落盘名可能被收敛过，
 * 把手机上那个原始类型并排列出来更稳。
 */
export function appendFileNote(text: string, saved: ReadonlyArray<SavedFile>): string {
  if (saved.length === 0) return text
  const lines = saved.map((f, i) => (f.mediaType ? `${i + 1}. ${f.path}（${f.mediaType}）` : `${i + 1}. ${f.path}`))
  const note = `\n\n[文件附件 ${saved.length} 个，已存到本机]\n${lines.join('\n')}`
  const head = String(text || '')
  return head === '' ? note.replace(/^\n\n/, '') : head + note
}

/**
 * 把一批文件附件写进 <dir>/<safeSessionId>/。
 *
 * 与 `saveImageAttachments` 的三处差别，都是文件本身逼出来的：
 * 1. **不校内容魔数**。图片那边有 JPEG 文件头这一道，文件类型太多了，硬凑一份
 *    魔数表只会给出"看起来校验过"的假保证。真正的闸在 mp 侧两道 + 这里的大小上限。
 * 2. **不改扩展名**。图片统一强写成 .jpg（画布重编码出来的就是 jpeg），文件改了
 *    扩展名 Agent 就不认它了。收敛仍走 `safeSegment`——手机传来的名字是不可信输入。
 * 3. **同名不覆盖**（与图片同一条理由）：加序号而不是失败。
 *
 * 整批先验后写：被拒的批次一个字节都不留在磁盘上。
 */
export function saveFileAttachments(options: {
  files: ReadonlyArray<{ name: string; mediaType?: string; data: string }>
  dir: string
  sessionId: string
  maxCount?: number
  maxBytesPerFile?: number
}): SaveFilesResult {
  const maxCount = options.maxCount ?? 4
  const maxBytes = options.maxBytesPerFile ?? 512 * 1024
  const files = options.files || []
  if (files.length === 0) return { ok: true, saved: [], dir: options.dir }
  if (files.length > maxCount) {
    return { ok: false, message: `一次最多带 ${maxCount} 个文件，收到 ${files.length} 个` }
  }

  const decoded: Array<{ file: (typeof files)[number]; buf: Buffer }> = []
  for (const [i, one] of files.entries()) {
    const buf = decodeBase64(one.data)
    if (!buf) return { ok: false, message: `第 ${i + 1} 个文件的解码失败（不是合法 base64）` }
    if (buf.length > maxBytes) {
      return {
        ok: false,
        message: `第 ${i + 1} 个文件有 ${Math.round(buf.length / 1024)}KB，超过单个上限 ${Math.round(maxBytes / 1024)}KB`,
      }
    }
    decoded.push({ file: one, buf })
  }

  const sessionDir = path.join(options.dir, safeSegment(options.sessionId, 'session'))
  const written: SavedFile[] = []
  try {
    fs.mkdirSync(sessionDir, { recursive: true })
    for (const [i, one] of decoded.entries()) {
      // 空名字兜底成按序号的通用名：手机那头可能给一个只有扩展名的文件，
      // 收敛之后就什么都不剩了。
      const fallback = `file-${i + 1}`
      const base = safeSegment(one.file.name, fallback, 96) || fallback
      let name = base
      let n = 1
      while (fs.existsSync(path.join(sessionDir, name))) {
        // 序号插在扩展名之前（a.pdf → a-2.pdf），插在末尾会变成 a.pdf-2，Agent 认不出。
        const dot = base.lastIndexOf('.')
        name = dot > 0 ? `${base.slice(0, dot)}-${++n}${base.slice(dot)}` : `${base}-${++n}`
      }
      const file = path.join(sessionDir, name)
      fs.writeFileSync(file, one.buf, { mode: 0o600 })
      written.push({ name, path: file, bytes: one.buf.length, mediaType: one.file.mediaType })
    }
  } catch (error) {
    return {
      ok: false,
      message: `文件落盘失败：${String((error as Error)?.message ?? error).slice(0, 160)}`,
    }
  }
  return { ok: true, saved: written, dir: sessionDir }
}

/**
 * prompt 正文增补：把落盘路径写成 Agent 能消费的形状。
 *
 * 放在**正文之后**——用户打的话是意图，附件是它的补充，颠倒会让长 prompt 读起来别扭。
 * 正文为空串时（只发图）也能用：那正是一条纯附件消息。
 */
export function appendImageNote(text: string, saved: ReadonlyArray<SavedImage>): string {
  if (saved.length === 0) return text
  const lines = saved.map((img, i) => `${i + 1}. ${img.path}`)
  const note = `\n\n[图片附件 ${saved.length} 张，已存到本机]\n${lines.join('\n')}`
  const head = String(text || '')
  return head === '' ? note.replace(/^\n\n/, '') : head + note
}
