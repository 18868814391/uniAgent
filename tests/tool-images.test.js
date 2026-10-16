// 工具产出图片的侧通道（tool-images.js）回归测试
//
// 背景（2026-10-05）：Chat Completions 协议里 role:'tool' 的 content 只能放字符串，
// 所以 browser_read_images 抓到的图必须先暂存、再由 chat.js 注入下一轮 user 消息。
// 本模块是那条通道的**唯一状态载体**：它一旦重复注入 / 漏清空 / 不设上限，
// 表现是"每轮都在为同一张图付费"或"新任务莫名其妙多出几张图"，都很隐蔽。
//
// 本文件锁住 5 条：
//   1) stash → take 取出即清（同一张图不会被注入第二次）
//   2) 相同图片（data URL 相同）在同一批里只收一次
//   3) 单次上限（4 张）与字符预算 —— 超出的计入 dropped，且**不**静默混进 parts
//   4) 按会话隔离，clear 只影响指定会话
//   5) renderImageNote 至少要让模型知道"这些图你能看到"，且逐条带来源信息
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const ti = require(path.join(__dirname, '..', 'electron', 'tool-images'))

// 每例用独立会话 id：模块状态是进程级的，混用会让"取出即清"的断言互相干扰
let seq = 0
const conv = () => `conv-ti-${++seq}`

// part 的形状与 fs-safe.imagePartFromBuffer 的输出一致（data URL，不是外链）
const part = (n, size = 32) => ({
  type: 'image_url',
  image_url: { url: `data:image/jpeg;base64,${'A'.repeat(size)}${n}` },
})
const item = (n, label) => ({ label: label || `图 ${n}`, part: part(n) })

test('stash → take：取出即清，同一张图不会被注入第二次', () => {
  const c = conv()
  const res = ti.stashImages(c, [item(1), item(2)])
  assert.equal(res.accepted, 2)
  assert.equal(ti.pendingCount(c), 2)

  const taken = ti.takeImages(c)
  assert.equal(taken.length, 2)
  assert.equal(taken[0].label, '图 1')
  assert.equal(taken[1].label, '图 2')
  // 关键：取过之后必须为空 —— 否则下一轮请求会把同一张图再发一遍（重复计费）
  assert.equal(ti.pendingCount(c), 0)
  assert.deepEqual(ti.takeImages(c), [])
})

test('相同图片（data URL 完全相同）在同一批里只收一次', () => {
  const c = conv()
  const dup = part(7, 64)
  const res = ti.stashImages(c, [
    { label: 'a', part: dup },
    { label: 'b', part: part(7, 64) },   // 与 dup 字节一致
    { label: 'c', part: part(8) },
  ])
  assert.equal(res.accepted, 2)
  assert.equal(res.duplicates, 1)
  assert.equal(ti.pendingCount(c), 2)
})

test('超过单次上限的图片被丢弃并计数（不静默混进 parts）', () => {
  const c = conv()
  const many = Array.from({ length: 7 }, (_, i) => item(i + 1))
  const res = ti.stashImages(c, many)
  assert.equal(res.total, 7)
  assert.equal(res.accepted, ti.MAX_INJECT_IMAGES)
  assert.equal(res.dropped, 3)
  assert.equal(ti.takeImages(c).length, ti.MAX_INJECT_IMAGES)
})

test('去掉超出体积预算的图（防止造出一个必被网关拒绝的请求体）', () => {
  const c = conv()
  // 每张约 1.2MB 字符 → 第 2 张就该撞上 2MB 预算（真实降采样图约 200~400KB，这里是放大版）
  const big = Math.floor(ti.MAX_INJECT_CHARS * 0.6)
  const bigItem = (n) => ({ label: `大图 ${n}`, part: part(n, big) })
  const res = ti.stashImages(c, [bigItem(1), bigItem(2), bigItem(3)])
  assert.equal(res.accepted, 1)
  assert.equal(res.dropped, 2)
})

test('按会话隔离；clear 只影响指定会话', () => {
  const a = conv()
  const b = conv()
  ti.stashImages(a, [item(1)])
  ti.stashImages(b, [item(2)])
  ti.clearImages(a)
  assert.equal(ti.pendingCount(a), 0)
  assert.equal(ti.pendingCount(b), 1)
  // 空 convId 一律安全（chat.js 在极端情况下可能拿不到会话 id）
  assert.deepEqual(ti.takeImages(''), [])
  assert.deepEqual(ti.takeImages(undefined), [])
  assert.equal(ti.stashImages(null, [item(3)]).accepted, 0)
  ti.clearImages(b)
})

test('形状不合法的条目算 dropped，不能污染 parts/note', () => {
  const c = conv()
  const res = ti.stashImages(c, [{ label: 'x' }, { label: 'y', part: { type: 'image_url' } }, item(9)])
  assert.equal(res.accepted, 1)
  assert.equal(res.dropped, 2)
  assert.equal(ti.pendingCount(c), 1)
  ti.clearImages(c)
})

test('renderImageNote：清单带序号与来源，并明确告诉模型"你能看到"', () => {
  const note = ti.renderImageNote([
    { label: '首页横幅（1200×400）— https://a.com/banner.png' },
    { label: '页面图片 2（尺寸未知）— https://a.com/x' },
  ])
  assert.match(note, /以下 2 张图/)
  assert.match(note, /1\. 首页横幅（1200×400）— https:\/\/a\.com\/banner\.png/)
  assert.match(note, /2\. 页面图片 2/)
  // 模型不认这条通道时的兜底：必须有"你能直接看到"这类字眼，
  // 否则它会退化成"我看到了图片地址"或者干脆说自己看不到图。
  assert.match(note, /你可以直接看到/)
  assert.equal(ti.renderImageNote([]), '')
})
