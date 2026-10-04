import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendImageNote, safeSegment, saveImageAttachments } from '../src/shell/uploads.js'

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
