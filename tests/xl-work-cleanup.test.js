// ============================================================
//  .xl-work 临时目录清理 —— 锁住「根下散落文件也要清」这条
//
//  背景：AI 有时把过程脚本写到 `.xl-work/` 根而不是本轮 run 子目录
//  （2026-09-30 实测：根下堆了 explore1~7.py / fill.py / verify*.py 十几个文件）。
//  旧版 sweepOrphanWorkDirs 只清 `isDirectory()` 的条目，散落文件永远清不掉。
//
//  xl-work 顶层 require('./settings') → 会拉进 electron；这里先把 './settings'
//  塞进 require.cache 再 require 它（同 tests/erp-search.test.js 的 stub 套路）。
// ============================================================
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ELECTRON_DIR = path.resolve(__dirname, '..', 'electron')
const settingsPath = require.resolve('./settings', { paths: [ELECTRON_DIR] })
require.cache[settingsPath] = {
  id: settingsPath,
  filename: settingsPath,
  loaded: true,
  exports: { getExcelOutputDir: () => path.join(os.tmpdir(), 'xl-work-unused') },
}

const xlWork = require('../electron/xl-work')

const DAY = 24 * 60 * 60 * 1000

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xl-work-test-'))
}

function touch(p, ageMs, isDir = false) {
  if (isDir) fs.mkdirSync(p, { recursive: true })
  else {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'x')
  }
  const t = new Date(Date.now() - ageMs)
  fs.utimesSync(p, t, t)
}

test('sweepOrphanWorkDirs：超龄的目录**和文件**都清，未超龄的一律保留', () => {
  const root = makeRoot()
  touch(path.join(root, 'old-run-dir'), 2 * DAY, true)
  touch(path.join(root, 'new-run-dir'), 1 * 60 * 1000, true)
  touch(path.join(root, 'explore6.py'), 2 * DAY) // 本次事故里的散落脚本
  touch(path.join(root, 'just-written.py'), 1 * 60 * 1000)

  const removed = xlWork.sweepOrphanWorkDirs(DAY, root)

  assert.equal(removed, 2, '应删掉 1 个旧目录 + 1 个旧文件')
  assert.equal(fs.existsSync(path.join(root, 'old-run-dir')), false, '超龄目录要删')
  assert.equal(fs.existsSync(path.join(root, 'explore6.py')), false, '超龄散落文件也要删（旧版会漏掉）')
  assert.equal(fs.existsSync(path.join(root, 'new-run-dir')), true, '未超龄目录保留')
  assert.equal(fs.existsSync(path.join(root, 'just-written.py')), true, '未超龄文件保留')

  fs.rmSync(root, { recursive: true, force: true })
})

test('pruneRootLeftovers：只清「早于本轮开始」的根下文件，子目录与新一轮的文件不动', () => {
  const root = makeRoot()
  const runStartedAt = Date.now()

  touch(path.join(root, 'last-turn.py'), 10 * 60 * 1000) // 上一轮遗留
  touch(path.join(root, 'this-turn.py'), 0) // 本轮刚写（mtime = now >= runStartedAt）
  touch(path.join(root, 'some-run-dir'), 10 * 60 * 1000, true) // 子目录：不归它管

  const removed = xlWork.pruneRootLeftovers(runStartedAt, root)

  assert.equal(removed, 1)
  assert.equal(fs.existsSync(path.join(root, 'last-turn.py')), false, '早于本轮开头的散落文件要剪掉')
  assert.equal(fs.existsSync(path.join(root, 'this-turn.py')), true, '本轮新写的绝不能动（并发会话同理）')
  assert.equal(fs.existsSync(path.join(root, 'some-run-dir')), true, '子目录交给 scheduleCleanup，不在这里处理')

  fs.rmSync(root, { recursive: true, force: true })
})

test('pruneRootLeftovers：没有阈值 / 目录不存在时安全返回 0', () => {
  const root = makeRoot()
  assert.equal(xlWork.pruneRootLeftovers(0, root), 0)
  assert.equal(xlWork.pruneRootLeftovers(null, root), 0)
  assert.equal(xlWork.pruneRootLeftovers(Date.now(), path.join(root, 'nope')), 0)
  fs.rmSync(root, { recursive: true, force: true })
})

test('sweepOrphanWorkDirs：目录不存在时返回 0，不抛错', () => {
  assert.equal(xlWork.sweepOrphanWorkDirs(DAY, path.join(os.tmpdir(), 'xl-work-absent-xyz')), 0)
})

test('isInside：越界路径判定（防清理误伤授权目录外的文件）', () => {
  const root = path.join(os.tmpdir(), 'xl-work-root')
  assert.equal(xlWork.isInside(root, path.join(root, 'a', 'b')), true)
  assert.equal(xlWork.isInside(root, root), true)
  assert.equal(xlWork.isInside(root, path.join(root, '..', 'sibling')), false)
  assert.equal(xlWork.isInside(root, os.tmpdir()), false)
})
