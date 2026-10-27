// 文件检查点（撤销本轮改动）的回归测试（P0-7，2026-10-24）。
//
// 要锁住的口径：
//   ① 覆盖/删除**已存在**的文件前存一份原文；新建文件不存（没东西可恢复）
//   ② 同一轮同一个文件只存第一次 —— 撤销要回到「这一轮开始前」，不是回到上一次编辑
//   ③ 大文件 / 二进制 / 敏感目录（.ssh、AppData…）不落副本（隐私 + 体积）
//   ④ restoreTurn 能把内容恢复、也能把被删掉的文件恢复回来
//   ⑤ 会话删除时 clearSession 清干净
// 本模块纯 node 实现（顶层不 require electron），用 __setRootForTest 指到临时目录。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cp = require(path.join(__dirname, '..', 'electron', 'checkpoints.js'))

let root = null
function freshRoot() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-cp-'))
  cp.__setRootForTest(root)
  return root
}

// ⚠️ 工作文件不能放在 os.tmpdir() 里：Windows 的临时目录在 %LOCALAPPDATA%\Temp 之下，
//    会被 checkpoints 的敏感路径规则（AppData）判成"不落副本" —— 那是**预期行为**，
//    但没法用来测快照。所以工作目录放在 AppData 之外（C:\workspace 或用户目录），跑完删掉。
const WORK_PARENT = fs.existsSync('C:\\workspace') ? 'C:\\workspace' : os.homedir()
let workRoot = null
function workBase(tag) {
  if (!workRoot) workRoot = fs.mkdtempSync(path.join(WORK_PARENT, '.localai-test-cp-'))
  const d = path.join(workRoot, tag)
  fs.mkdirSync(d, { recursive: true })
  return d
}
function workFile(name, content) {
  const p = path.join(workBase('w'), name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
  return p
}

test.after(() => {
  cp.__setRootForTest(null)
  if (workRoot) {
    try {
      fs.rmSync(workRoot, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
})

test('覆盖前存原文 → 撤销后内容回到本轮开始前的样子', () => {
  freshRoot()
  const f = workFile('a.js', 'const a = 1\n')
  assert.equal(cp.snapshotBeforeWrite('conv-1', 3, f), true)
  fs.writeFileSync(f, 'const a = 999\n', 'utf-8')   // 模拟 AI 改坏
  const res = cp.restoreTurn('conv-1', 3)
  assert.equal(res.ok, true)
  assert.deepEqual(res.restored, [f])
  assert.equal(fs.readFileSync(f, 'utf-8'), 'const a = 1\n')
})

test('同一轮同一个文件只存第一次（否则撤销只能回到中间态）', () => {
  freshRoot()
  const f = workFile('b.js', 'v1\n')
  assert.equal(cp.snapshotBeforeWrite('conv-2', 1, f), true)
  fs.writeFileSync(f, 'v2\n', 'utf-8')
  assert.equal(cp.snapshotBeforeWrite('conv-2', 1, f), false, '第二轮不该再存（会把 v2 当原文）')
  fs.writeFileSync(f, 'v3\n', 'utf-8')
  cp.restoreTurn('conv-2', 1)
  assert.equal(fs.readFileSync(f, 'utf-8'), 'v1\n', '必须回到本轮开始前，而不是上一次编辑前')
  assert.equal(cp.turnFileCount('conv-2', 1), 1)
})

test('不同轮次各自独立', () => {
  freshRoot()
  const f = workFile('c.js', 'v1\n')
  cp.snapshotBeforeWrite('conv-3', 1, f)
  fs.writeFileSync(f, 'v2\n', 'utf-8')
  cp.snapshotBeforeWrite('conv-3', 2, f)
  fs.writeFileSync(f, 'v3\n', 'utf-8')
  assert.equal(cp.turnFileCount('conv-3', 1), 1)
  assert.equal(cp.turnFileCount('conv-3', 2), 1)
  cp.restoreTurn('conv-3', 2)   // 只撤第二轮 → 回到 v2
  assert.equal(fs.readFileSync(f, 'utf-8'), 'v2\n')
})

test('被删除的文件也能恢复回来', () => {
  freshRoot()
  const f = workFile('d.js', 'keep me\n')
  cp.snapshotBeforeWrite('conv-4', 1, f)
  fs.unlinkSync(f)
  const res = cp.restoreTurn('conv-4', 1)
  assert.equal(res.ok, true)
  assert.equal(fs.readFileSync(f, 'utf-8'), 'keep me\n')
})

test('新建文件不存快照（没有原文可恢复）', () => {
  freshRoot()
  assert.equal(cp.snapshotBeforeWrite('conv-5', 1, path.join(workBase('new'), 'brand-new.js')), false)
})

test('大文件 / 二进制 / 敏感目录 一律不落副本', () => {
  freshRoot()
  const big = workFile('big.js', 'x'.repeat(6 * 1024 * 1024))
  assert.equal(cp.snapshotBeforeWrite('conv-6', 1, big), false, '>5MB 不存')

  const png = workFile('pic.png', 'fake-png')
  assert.equal(cp.snapshotBeforeWrite('conv-6', 1, png), false, '二进制不存')

  // 敏感目录：在 AppData 下模拟（真实系统里那是 %LOCALAPPDATA%）
  const sens = path.join(workBase('sens'), 'AppData', 'secret.js')
  fs.mkdirSync(path.dirname(sens), { recursive: true })
  fs.writeFileSync(sens, 'token\n')
  assert.equal(cp.snapshotBeforeWrite('conv-6', 1, sens), false, '敏感目录不存（别把密钥复制进 userData）')
  assert.equal(cp.turnFileCount('conv-6', 1), 0)
})

test('缺少 convId / turnId 时安全跳过（子代理没有轮次概念）', () => {
  freshRoot()
  const f = workFile('e.js', 'x\n')
  assert.equal(cp.snapshotBeforeWrite(null, 1, f), false)
  assert.equal(cp.snapshotBeforeWrite('conv-7', undefined, f), false)
  assert.equal(cp.snapshotBeforeWrite('conv-7', 1, ''), false)
})

test('listTurns 只列出真有文件的轮次；clearSession 清干净', () => {
  freshRoot()
  const f = workFile('f.js', 'x\n')
  cp.snapshotBeforeWrite('conv-8', 2, f)
  cp.snapshotBeforeWrite('conv-8', 5, f)
  const turns = cp.listTurns('conv-8').map((t) => t.turnId)
  assert.deepEqual(turns, [5, 2], '新 → 旧')
  cp.clearSession('conv-8')
  assert.deepEqual(cp.listTurns('conv-8'), [])
  assert.equal(cp.turnFileCount('conv-8', 2), 0)
})

test('撤销不存在的轮次 → 给一句可读的原因，不抛异常', () => {
  freshRoot()
  const res = cp.restoreTurn('conv-none', 99)
  assert.equal(res.ok, false)
  assert.match(res.reason, /没有可恢复的文件/)
})
