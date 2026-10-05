import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendFileNote,
  appendImageNote,
  safeSegment,
  saveFileAttachments,
  saveImageAttachments,
} from '../src/shell/uploads.js'

test('safeSegment：路径穿越与隐藏文件都要被挡住', () => {
  assert.equal(safeSegment('../../etc/passwd', 'x'), 'etc_passwd')
  assert.equal(safeSegment('.ssh', 'x'), 'ssh')
  assert.equal(safeSegment('', 'fallback'), 'fallback')
  assert.equal(safeSegment('   ', 'fallback'), 'fallback')
  assert.equal(safeSegment('a'.repeat(200), 'x').length, 96, '超长截断')
})

test('appendImageNote：正文在后补路径；空正文时（只发图）也能用', () => {
  const saved = [{ name: 'a.jpg', path: '/tmp/x/a.jpg', bytes: 10 }]
  assert.equal(appendImageNote('看这张', saved), '看这张\n\n[图片附件 1 张，已存到本机]\n1. /tmp/x/a.jpg')
  assert.equal(appendImageNote('', saved), '[图片附件 1 张，已存到本机]\n1. /tmp/x/a.jpg')
  assert.equal(appendImageNote('不带图', []), '不带图', '没有附件时正文原样返回')
})

test('saveImageAttachments：整批校验后才落盘；同名加序号不覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-up-'))
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01])
  const first = saveImageAttachments({
    images: [{ name: 'shot.jpg', mediaType: 'image/jpeg', data: jpeg.toString('base64') }],
    dir,
    sessionId: 'ses/1',
  })
  assert.ok(first.ok)
  assert.equal(path.basename(path.dirname(first.saved[0]!.path)), 'ses_1', '会话 id 也要收敛（它要当目录名）')
  // 同名再来一次：加序号而不是覆盖
  const second = saveImageAttachments({
    images: [{ name: 'shot.jpg', mediaType: 'image/jpeg', data: jpeg.toString('base64') }],
    dir,
    sessionId: 'ses/1',
  })
  assert.ok(second.ok)
  assert.equal(path.basename(second.saved[0]!.path), 'shot-2.jpg', '同名不覆盖')
  assert.equal(fs.readdirSync(path.join(dir, 'ses_1')).length, 2)
  // 一批里第二张不行：整批拒，且磁盘上什么都没有（先整批评再落盘）
  const before = fs.readdirSync(dir).length
  const bad = saveImageAttachments({
    images: [
      { name: 'ok.jpg', mediaType: 'image/jpeg', data: jpeg.toString('base64') },
      { name: 'no.png', mediaType: 'image/jpeg', data: Buffer.from([0x89, 0x50]).toString('base64') },
    ],
    dir,
    sessionId: 'ses_2',
  })
  assert.ok(!bad.ok)
  assert.match(bad.message, /第 2 张/)
  assert.ok(!fs.existsSync(path.join(dir, 'ses_2')), '被拒的批次不许留下目录')
  assert.equal(fs.readdirSync(dir).length, before, '也不许多出别的目录')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('saveFileAttachments：保留扩展名、同名加序号、整批先验后写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-file-'))
  const body = Buffer.from('PDFBYTES')
  const r = saveFileAttachments({
    files: [{ name: 'report.pdf', mediaType: 'pdf', data: body.toString('base64') }],
    dir,
    sessionId: 'ses/1',
  })
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.saved.length, 1)
  const one = r.ok && r.saved[0]
  assert.equal(one && one.name, 'report.pdf', '扩展名一个字符都不许动：Agent 认文件靠它')
  assert.equal(one && path.basename(one.path), 'report.pdf')
  assert.equal(one && one.bytes, body.length)
  assert.equal(one && fs.readFileSync(one.path).equals(body), true, '落盘的内容要一个字节都不差')
  assert.equal(one && fs.statSync(one.path).mode & 0o777, 0o600, '附件不该给别人看')

  // 同名再来一份：不许覆盖上一份（用户以为发上去了，其实那份被顶掉了）
  const again = saveFileAttachments({
    files: [{ name: 'report.pdf', mediaType: 'pdf', data: body.toString('base64') }],
    dir,
    sessionId: 'ses/1',
  })
  assert.equal(again.ok, true, '第二份也要落盘成功')
  const second: string = again.ok === true && again.saved[0] ? again.saved[0].path : ''
  assert.equal(path.basename(second), 'report-2.pdf', '序号插在扩展名**前面**')
  const back: string = again.ok === true ? again.dir : ''
  assert.equal(fs.readdirSync(back).length, 2, '两份都要在')
})

test('saveFileAttachments：超预算的批次一个字节都不落盘（整批先验）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-file-'))
  const big = Buffer.alloc(600 * 1024, 1)
  const r = saveFileAttachments({
    files: [
      { name: 'ok.txt', mediaType: 'txt', data: 'aGk=' },
      { name: 'big.zip', mediaType: 'zip', data: big.toString('base64') },
    ],
    dir,
    sessionId: 'ses/1',
    maxBytesPerFile: 512 * 1024,
  })
  assert.equal(r.ok, false, '整批先验：一个不过就整批都不写')
  assert.equal(!r.ok && /600KB/.test(r.message), true, '要说清是哪一个、超了多少')
  assert.equal(fs.existsSync(path.join(dir, 'ses_1')), false, '目录里什么都不该有')
})

test('saveFileAttachments：文件数超过 4 个也不行（协议层同一个数）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-file-'))
  const r = saveFileAttachments({
    files: Array.from({ length: 5 }, (_, i) => ({
      name: `f${i}.txt`,
      data: 'aGk=',
    })),
    dir,
    sessionId: 's',
  })
  assert.equal(r.ok, false)
  assert.equal(!r.ok && /一次最多带 4 个/.test(r.message), true)
})

test('appendFileNote：正文在后补路径与类型；空正文时（只发文件）也能用', () => {
  const saved = [{ name: 'a.pdf', path: '/tmp/u/a.pdf', bytes: 10, mediaType: 'pdf' }]
  assert.equal(appendFileNote('看这份', saved), '看这份\n\n[文件附件 1 个，已存到本机]\n1. /tmp/u/a.pdf（pdf）')
  assert.equal(appendFileNote('', saved), '[文件附件 1 个，已存到本机]\n1. /tmp/u/a.pdf（pdf）')
  assert.equal(appendFileNote('不带文件', []), '不带文件', '没有附件时正文原样返回')
  // 手机给不出类型时不编一个：折成不带括号的纯路径
  assert.equal(
    appendFileNote('', [{ name: 'a', path: '/tmp/u/a', bytes: 1 }]),
    '[文件附件 1 个，已存到本机]\n1. /tmp/u/a',
  )
})
