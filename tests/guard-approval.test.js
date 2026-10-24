// ============================================================
//  tests/guard-approval.test.js —— 审批结果闭合 + fail-closed（electron/tools/guard.js）
//
//  确认框的返回值是四值枚举，**只有 allowed-once 放行**：
//    allowed-once / rejected / cancelled / unavailable
//
//  锁住的旧行为缺口：
//   1) 旧实现返回 boolean，`res.response === 1`，其它一切（含关窗、无人应答）都折成 false，
//      模型分不清「用户说不」和「压根没问到人」，猜错了就原样重试。
//   2) 旧实现 `win` 为 null 时会退化成一个没有父窗口的对话框继续弹 ——
//      主窗口已销毁时那个框可能根本不可见，工具循环在那里等一个永远不会到来的点击。
//
//  这里用注入的 electron 桩跑真实分支，不需要真的弹框。
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const ELECTRON_DIR = path.join(__dirname, '..', 'electron')

// dialog 行为由用例注入：默认「用户点了执行」
let dialogImpl = async () => ({ response: 1 })
const optionsSeen = []
const electronStub = {
  dialog: {
    showMessageBox: (...args) => {
      optionsSeen.push(args)
      return dialogImpl(...args)
    },
  },
}
const stub = (request, exports) => {
  const id = require.resolve(request, { paths: [ELECTRON_DIR] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}
stub('electron', electronStub)

const guard = require(path.join(ELECTRON_DIR, 'tools', 'guard.js'))

// 一个最小的「活着的窗口」桩
function liveWin() {
  const w = {
    destroyed: false,
    focusCalls: 0,
    webContents: { focusCalls: 0, focus() { w.webContents.focusCalls++ } },
    isDestroyed() { return w.destroyed },
    focus() { w.focusCalls++ },
  }
  return w
}

test.beforeEach(() => {
  optionsSeen.length = 0
  dialogImpl = async () => ({ response: 1 })
})

test('APPROVAL 是闭合枚举，只有 allowed-once 算批准', () => {
  assert.deepEqual(
    Object.values(guard.APPROVAL).sort(),
    ['allowed-once', 'cancelled', 'rejected', 'unavailable'],
  )
  assert.equal(guard.isApproved({ status: 'allowed-once' }), true)
  for (const status of ['rejected', 'cancelled', 'unavailable', undefined, null, '']) {
    assert.equal(guard.isApproved({ status }), false, `${status} 不得被当成批准`)
  }
  // 非对象一律不批（fail-closed）
  assert.equal(guard.isApproved(null), false)
  assert.equal(guard.isApproved(undefined), false)
  assert.equal(guard.isApproved({}), false)
})

test('用户点「执行」→ allowed-once 放行', async () => {
  dialogImpl = async () => ({ response: 1 })
  const d = await guard.confirmWithDialog(liveWin(), { reason: '改系统文件', detail: 'x' })
  assert.equal(d.status, 'allowed-once')
  assert.equal(d.allowed, true)
  assert.equal(guard.isApproved(d), true)
  assert.equal(optionsSeen.length, 1, '应该真弹一次框')
  assert.equal(optionsSeen[0].length, 2, '有父窗口时必须带父窗口（否则框可能在窗口后面看不见）')
})

test('用户点「取消」→ rejected（不执行，且能与「没问到人」区分）', async () => {
  dialogImpl = async () => ({ response: 0 })
  const d = await guard.confirmWithDialog(liveWin(), { reason: 'r', detail: 'd' })
  assert.equal(d.status, 'rejected')
  assert.equal(guard.isApproved(d), false)
  assert.match(guard.approvalMessage(d), /用户明确取消/)
})

test('对话框抛异常（弹框途中被系统收回）→ cancelled，不冒泡成工具报错', async () => {
  dialogImpl = async () => { throw new Error('dialog destroyed') }
  const d = await guard.confirmWithDialog(liveWin(), { reason: 'r', detail: 'd' })
  assert.equal(d.status, 'cancelled')
  assert.equal(guard.isApproved(d), false)
  assert.match(guard.approvalMessage(d), /没有拿到用户|确认框异常结束/)
})

test('没拿到 response 字段 → cancelled（按未获批准处理）', async () => {
  dialogImpl = async () => ({ checkboxChecked: false })
  const d = await guard.confirmWithDialog(liveWin(), { reason: 'r', detail: 'd' })
  assert.equal(d.status, 'cancelled')
  assert.equal(guard.isApproved(d), false)
})

test('主窗口已销毁 → unavailable，且**根本不弹框**（不制造不可见的等待）', async () => {
  for (const win of [null, undefined, { isDestroyed: () => true }]) {
    const d = await guard.confirmWithDialog(win, { reason: 'r', detail: 'd' })
    assert.equal(d.status, 'unavailable')
    assert.equal(guard.isApproved(d), false)
    assert.match(guard.approvalMessage(d), /无法向用户请求确认/)
  }
  assert.equal(optionsSeen.length, 0, '窗口不可用时不该试图弹框')
})

test('弹框后恢复窗口焦点（否则渲染层后续 .focus() 会失灵）', async () => {
  const win = liveWin()
  await guard.confirmWithDialog(win, { reason: 'r', detail: 'd' })
  assert.equal(win.focusCalls, 1)
  assert.equal(win.webContents.focusCalls, 1)
})

test('每个拒绝状态都有可执行的说法喂给模型（不是一句泛化错误）', () => {
  const rejected = guard.approvalMessage({ status: 'rejected' })
  const cancelled = guard.approvalMessage({ status: 'cancelled' })
  const unavailable = guard.approvalMessage({ status: 'unavailable' })
  for (const text of [rejected, cancelled, unavailable]) {
    assert.ok(text.length > 10)
    assert.match(text, /不要原样重试|不要执行该操作|让用户决定|让用户自己/)
  }
  // 未知 / 缺失状态也有兜底文案（不返回空串）
  assert.ok(guard.approvalMessage(null).length > 0)
  assert.ok(guard.approvalMessage({}).length > 0)
})
