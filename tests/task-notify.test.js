// 长任务结束 → 屏幕右下角系统通知 —— 回归测试（2026-10-04）
//
// 需求原话：「完成长任务的时候，屏幕右下角出现系统提示，XXXX 已经完成」——
// 用户会切到别的应用，不会一直盯着本应用，所以**必须走操作系统级通知**，
// 页面内 toast 在窗口失焦时等于没提示。后续追加："把任务出错/超时也一起提醒"、
// "触发 ask_user 的时候也要提醒，不然对话就卡着了"。
//
// 本文件锁住六条行为：
//   1) 正常完成 + 异常结束（超时/报错/轮次耗尽/无回答/文本工具调用）都提醒
//   2) 「用户自己点中断」（aborted / superseded）不提醒 —— 他就在旁边
//   3) 窗口在前台 / 耗时不足 / 开关关闭 → 不提醒
//   4) 文案按结果分流：完成 =「XXX」已完成，异常 =「XXX」执行出错…；取不到任务名有兜底
//   5) 点击通知把主窗口拉回前台；系统不支持通知 / win 为 null → 静默跳过不抛错
//   6) ask_user 挂起也提醒（对话被阻塞了），且**不设耗时门槛** —— 只看窗口是否失焦
//
// task-notify.js 在模块顶层 require('electron')，故先用桩模块顶掉依赖再 require。
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const TARGET = path.join(__dirname, '..', 'electron', 'task-notify.js')

// ---- electron 桩：记录所有真的 show() 出来的通知 ----
const shown = []
let supported = true
class FakeNotification {
  constructor(opts) {
    this.opts = opts
    this.handlers = {}
  }
  on(evt, fn) {
    this.handlers[evt] = fn
    return this
  }
  show() {
    shown.push(this)
  }
  static isSupported() {
    return supported
  }
}

const electronId = require.resolve('electron', { paths: [path.dirname(TARGET)] })
require.cache[electronId] = {
  id: electronId,
  filename: electronId,
  loaded: true,
  exports: { Notification: FakeNotification },
}

const notify = require(TARGET)

function reset() {
  shown.length = 0
  supported = true
}

// 一个假的 BrowserWindow：记录被调用的动作
function fakeWindow({ focused = false, minimized = false, visible = true, destroyed = false } = {}) {
  const calls = []
  return {
    calls,
    isFocused: () => focused,
    isMinimized: () => minimized,
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  }
}

// ============================================================
//  classifyEndReason —— 唯一的 reason 名单源
// ============================================================
test('classifyEndReason：complete → done；超时/报错/轮次/无回答/文本工具调用 → failed', () => {
  assert.strictEqual(notify.classifyEndReason('complete'), 'done')
  for (const r of ['timeout', 'error', 'max_iterations', 'no_answer', 'text_tool_call']) {
    assert.strictEqual(notify.classifyEndReason(r), 'failed', `${r} 应归 failed`)
  }
})

test('classifyEndReason：用户中断 / 被取代 / 未知原因 → null（不提醒）', () => {
  for (const r of ['aborted', 'superseded', '', undefined, null, 'whatever']) {
    assert.strictEqual(notify.classifyEndReason(r), null, `${JSON.stringify(r)} 不应触发通知`)
  }
})

// ============================================================
//  formatDuration
// ============================================================
test('formatDuration：秒 / 分秒 / 整分 / 小时', () => {
  assert.strictEqual(notify.formatDuration(42 * 1000), '42 秒')
  assert.strictEqual(notify.formatDuration(125 * 1000), '2 分 5 秒')
  assert.strictEqual(notify.formatDuration(120 * 1000), '2 分')
  assert.strictEqual(notify.formatDuration(65 * 60 * 1000), '1 小时 5 分')
  assert.strictEqual(notify.formatDuration(60 * 60 * 1000), '1 小时')
  assert.strictEqual(notify.formatDuration(NaN), '')
  assert.strictEqual(notify.formatDuration(-1), '')
})

// ============================================================
//  extractTaskText —— 取本轮"用户让 AI 干什么"当任务名
// ============================================================
test('extractTaskText：取最后一条 user 消息，短消息原样返回', () => {
  const messages = [
    { role: 'user', content: '第一条问题' },
    { role: 'assistant', content: '回答' },
    { role: 'user', content: '重构入库弹窗' },
  ]
  assert.strictEqual(notify.extractTaskText(messages), '重构入库弹窗')
})

test('extractTaskText：多行需求折叠成一行', () => {
  const messages = [{ role: 'user', content: '帮我把入库弹窗\n  改造一下\t谢谢' }]
  assert.strictEqual(notify.extractTaskText(messages), '帮我把入库弹窗 改造一下 谢谢')
})

test('extractTaskText：超长截断到上限并加省略号', () => {
  const long = '甲'.repeat(100)
  const got = notify.extractTaskText([{ role: 'user', content: long }])
  assert.strictEqual(got.length, notify.TASK_MAX_CHARS + 1)
  assert.ok(got.endsWith('…'))
})

test('extractTaskText：content 是 parts 数组时只取 text（图片路径不进通知）', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'file:///C:/tmp/a.png' } },
        { type: 'text', text: '看看这张图' },
      ],
    },
  ]
  assert.strictEqual(notify.extractTaskText(messages), '看看这张图')
})

test('extractTaskText：没有可用 user 文本时返回空串（调用方走兜底文案）', () => {
  assert.strictEqual(notify.extractTaskText([]), '')
  assert.strictEqual(notify.extractTaskText(null), '')
  assert.strictEqual(notify.extractTaskText([{ role: 'user', content: '   ' }]), '')
  assert.strictEqual(notify.extractTaskText([{ role: 'assistant', content: '只有回答' }]), '')
})

// ============================================================
//  shouldNotifyTaskEnd —— 决策矩阵
// ============================================================
test('shouldNotifyTaskEnd：正常完成 + 窗口失焦 + 耗时达标 → 提醒', () => {
  assert.strictEqual(
    notify.shouldNotifyTaskEnd({ reason: 'complete', elapsedMs: 20 * 1000, focused: false }),
    true,
  )
})

test('shouldNotifyTaskEnd：超时 / 报错 / 轮次耗尽 / 无回答 / 文本工具调用 → 都提醒', () => {
  for (const reason of ['timeout', 'error', 'max_iterations', 'no_answer', 'text_tool_call']) {
    assert.strictEqual(
      notify.shouldNotifyTaskEnd({ reason, elapsedMs: 60 * 1000, focused: false }),
      true,
      `${reason} 应触发提醒`,
    )
  }
})

test('shouldNotifyTaskEnd：用户自己点中断（aborted）→ 不提醒', () => {
  assert.strictEqual(
    notify.shouldNotifyTaskEnd({ reason: 'aborted', elapsedMs: 60 * 1000, focused: false }),
    false,
  )
})

test('shouldNotifyTaskEnd：窗口在前台 → 不提醒（用户正看着，弹通知是噪音）', () => {
  assert.strictEqual(
    notify.shouldNotifyTaskEnd({ reason: 'complete', elapsedMs: 60 * 1000, focused: true }),
    false,
  )
  assert.strictEqual(
    notify.shouldNotifyTaskEnd({ reason: 'error', elapsedMs: 60 * 1000, focused: true }),
    false,
  )
})

test('shouldNotifyTaskEnd：耗时不足阈值 → 不提醒（秒回的问答用户来不及切走）', () => {
  assert.strictEqual(
    notify.shouldNotifyTaskEnd({ reason: 'complete', elapsedMs: 14 * 1000, focused: false }),
    false,
  )
  assert.strictEqual(
    notify.shouldNotifyTaskEnd({
      reason: 'complete',
      elapsedMs: 3 * 1000,
      focused: false,
      minDurationMs: 1000,
    }),
    true,
  )
})

test('shouldNotifyTaskEnd：用户关掉开关 / 耗时值非法 / 空参数 → 不提醒', () => {
  assert.strictEqual(
    notify.shouldNotifyTaskEnd({ reason: 'complete', elapsedMs: 60 * 1000, focused: false, enabled: false }),
    false,
  )
  assert.strictEqual(
    notify.shouldNotifyTaskEnd({ reason: 'complete', elapsedMs: undefined, focused: false }),
    false,
  )
  assert.strictEqual(notify.shouldNotifyTaskEnd(), false)
})

// ============================================================
//  buildTaskNotice —— 文案
// ============================================================
test('buildTaskNotice：完成 → 「XXX」已完成 · 耗时 N（标题=任务完成）', () => {
  const { title, body } = notify.buildTaskNotice({ reason: 'complete', task: '重构入库弹窗', elapsedMs: 125 * 1000 })
  assert.strictEqual(title, notify.NOTICE_TITLE_DONE)
  assert.strictEqual(body, '「重构入库弹窗」已完成 · 耗时 2 分 5 秒')
})

test('buildTaskNotice：异常 → 「XXX」+ 人话原因（标题=任务未完成，区别于完成）', () => {
  const cases = [
    ['timeout', '连接超时，任务中断'],
    ['error', '执行出错，任务未完成'],
    ['max_iterations', '达到工具轮次上限，任务未完成'],
    ['no_answer', '未生成回答'],
    ['text_tool_call', '工具调用未执行（当前网关不支持原生 function calling）'],
  ]
  for (const [reason, label] of cases) {
    const { title, body } = notify.buildTaskNotice({ reason, task: '导出报表', elapsedMs: 30 * 1000 })
    assert.strictEqual(title, notify.NOTICE_TITLE_FAILED, `${reason} 标题应为未完成`)
    assert.strictEqual(body, `「导出报表」${label} · 耗时 30 秒`)
  }
})

test('buildTaskNotice：取不到任务名 → 通用文案（不出现空括号）', () => {
  assert.strictEqual(
    notify.buildTaskNotice({ reason: 'complete', task: '   ', elapsedMs: 30 * 1000 }).body,
    '任务已完成 · 耗时 30 秒',
  )
  assert.strictEqual(
    notify.buildTaskNotice({ reason: 'error', elapsedMs: 30 * 1000 }).body,
    '执行出错，任务未完成 · 耗时 30 秒',
  )
})

// ============================================================
//  notifyTaskEnd —— 副作用入口
// ============================================================
test('notifyTaskEnd：窗口失焦的完成 → 真的发出系统通知', () => {
  reset()
  const win = fakeWindow({ focused: false })
  const ok = notify.notifyTaskEnd({
    win,
    reason: 'complete',
    elapsedMs: 20 * 1000,
    task: '重构入库弹窗',
  })
  assert.strictEqual(ok, true)
  assert.strictEqual(shown.length, 1)
  assert.strictEqual(shown[0].opts.title, notify.NOTICE_TITLE_DONE)
  assert.strictEqual(shown[0].opts.body, '「重构入库弹窗」已完成 · 耗时 20 秒')
})

test('notifyTaskEnd：窗口失焦的报错 → 也发通知（标题是未完成）', () => {
  reset()
  const win = fakeWindow({ focused: false })
  const ok = notify.notifyTaskEnd({ win, reason: 'error', elapsedMs: 90 * 1000, task: '导出报表' })
  assert.strictEqual(ok, true)
  assert.strictEqual(shown.length, 1)
  assert.strictEqual(shown[0].opts.title, notify.NOTICE_TITLE_FAILED)
  assert.strictEqual(shown[0].opts.body, '「导出报表」执行出错，任务未完成 · 耗时 1 分 30 秒')
})

test('notifyTaskEnd：用户主动中断 → 一条通知都不发', () => {
  reset()
  const ok = notify.notifyTaskEnd({
    win: fakeWindow({ focused: false }),
    reason: 'aborted',
    elapsedMs: 60 * 1000,
    task: 'x',
  })
  assert.strictEqual(ok, false)
  assert.strictEqual(shown.length, 0)
})

test('notifyTaskEnd：窗口在前台 → 一条通知都不发', () => {
  reset()
  const ok = notify.notifyTaskEnd({
    win: fakeWindow({ focused: true }),
    reason: 'complete',
    elapsedMs: 60 * 1000,
    task: 'x',
  })
  assert.strictEqual(ok, false)
  assert.strictEqual(shown.length, 0)
})

test('notifyTaskEnd：点击通知 → 还原并聚焦主窗口', () => {
  reset()
  const win = fakeWindow({ focused: false, minimized: true, visible: false })
  notify.notifyTaskEnd({ win, reason: 'complete', elapsedMs: 60 * 1000, task: 'x' })
  assert.strictEqual(shown.length, 1)
  shown[0].handlers.click()
  assert.deepStrictEqual(win.calls, ['restore', 'show', 'focus'])
})

test('notifyTaskEnd：窗口未最小化且可见时点击 → 只 focus', () => {
  reset()
  const win = fakeWindow({ focused: false, minimized: false, visible: true })
  notify.notifyTaskEnd({ win, reason: 'complete', elapsedMs: 60 * 1000 })
  shown[0].handlers.click()
  assert.deepStrictEqual(win.calls, ['focus'])
})

test('notifyTaskEnd：系统不支持通知 → 返回 false 且不抛错', () => {
  reset()
  supported = false
  const ok = notify.notifyTaskEnd({
    win: fakeWindow({ focused: false }),
    reason: 'complete',
    elapsedMs: 60 * 1000,
  })
  assert.strictEqual(ok, false)
  assert.strictEqual(shown.length, 0)
})

test('notifyTaskEnd：win 为 null（窗口已关）→ 静默跳过，不抛错', () => {
  reset()
  assert.strictEqual(notify.notifyTaskEnd({ win: null, reason: 'complete', elapsedMs: 60 * 1000 }), false)
  assert.strictEqual(shown.length, 0)
})

test('notifyTaskEnd：拿不到焦点状态（isFocused 抛错）→ 保守当作在前台，不打扰', () => {
  reset()
  const win = {
    isFocused: () => { throw new Error('destroyed') },
    isDestroyed: () => false,
  }
  assert.strictEqual(
    notify.notifyTaskEnd({ win, reason: 'complete', elapsedMs: 60 * 1000 }),
    false,
  )
  assert.strictEqual(shown.length, 0)
})

// ============================================================
//  ask_user 挂起提醒 —— 对话被阻塞，用户切走后必须知道"轮到你作答了"
// ============================================================
test('shouldNotifyAskUser：窗口失焦 → 提醒（且**没有**耗时门槛这个字段）', () => {
  assert.strictEqual(notify.shouldNotifyAskUser({ focused: false }), true)
  // 对照：结束类通知在同样的"无耗时"入参下会被门槛拦下
  assert.strictEqual(
    notify.shouldNotifyTaskEnd({ reason: 'complete', elapsedMs: undefined, focused: false }),
    false,
  )
})

test('shouldNotifyAskUser：窗口在前台 / 开关关闭 / 空参数 → 不提醒', () => {
  assert.strictEqual(notify.shouldNotifyAskUser({ focused: true }), false)
  assert.strictEqual(notify.shouldNotifyAskUser({ focused: false, enabled: false }), false)
  assert.strictEqual(notify.shouldNotifyAskUser(), false)
})

test('buildAskNotice：带问题 → 正文是问题本身 + （点击作答）', () => {
  const { title, body } = notify.buildAskNotice({ question: '入库弹窗的 type 字段要不要做成必填？', task: '重构入库弹窗' })
  assert.strictEqual(title, notify.NOTICE_TITLE_ASK)
  assert.strictEqual(body, '入库弹窗的 type 字段要不要做成必填？（点击作答）')
})

test('buildAskNotice：问题超长截断；多行折叠成一行', () => {
  const long = '甲'.repeat(200)
  const body = notify.buildAskNotice({ question: long }).body
  assert.ok(body.startsWith('甲'.repeat(notify.QUESTION_MAX_CHARS) + '…'))
  assert.strictEqual(
    notify.buildAskNotice({ question: '第一行\n第二行' }).body,
    '第一行 第二行（点击作答）',
  )
})

test('buildAskNotice：问题为空 → 退化成带任务名的通用文案（不是一片空白）', () => {
  assert.strictEqual(
    notify.buildAskNotice({ task: '重构入库弹窗' }).body,
    '「重构入库弹窗」等你确认（点击查看）',
  )
  assert.strictEqual(notify.buildAskNotice({}).body, 'AI 正在等你作答（点击查看）')
  assert.strictEqual(notify.buildAskNotice().body, 'AI 正在等你作答（点击查看）')
})

test('notifyAskUser：窗口失焦 → 真的发出「需要你作答」通知（短任务也发）', () => {
  reset()
  const win = fakeWindow({ focused: false })
  const ok = notify.notifyAskUser({ win, question: '用哪个目录？', task: '导出报表' })
  assert.strictEqual(ok, true)
  assert.strictEqual(shown.length, 1)
  assert.strictEqual(shown[0].opts.title, notify.NOTICE_TITLE_ASK)
  assert.strictEqual(shown[0].opts.body, '用哪个目录？（点击作答）')
})

test('notifyAskUser：窗口在前台 → 不提醒（提问卡片用户自己看得到）', () => {
  reset()
  const ok = notify.notifyAskUser({ win: fakeWindow({ focused: true }), question: '用哪个目录？' })
  assert.strictEqual(ok, false)
  assert.strictEqual(shown.length, 0)
})

test('notifyAskUser：开关关闭 → 不提醒', () => {
  reset()
  const ok = notify.notifyAskUser({
    win: fakeWindow({ focused: false }),
    question: '用哪个目录？',
    enabled: false,
  })
  assert.strictEqual(ok, false)
  assert.strictEqual(shown.length, 0)
})

test('notifyAskUser：点击通知 → 还原并聚焦主窗口（省得去任务栏找）', () => {
  reset()
  const win = fakeWindow({ focused: false, minimized: true, visible: false })
  notify.notifyAskUser({ win, question: '用哪个目录？' })
  shown[0].handlers.click()
  assert.deepStrictEqual(win.calls, ['restore', 'show', 'focus'])
})

test('notifyAskUser：win 为 null / 系统不支持通知 → 静默跳过，不抛错', () => {
  reset()
  assert.strictEqual(notify.notifyAskUser({ win: null, question: 'q' }), false)
  supported = false
  assert.strictEqual(notify.notifyAskUser({ win: fakeWindow({ focused: false }), question: 'q' }), false)
  assert.strictEqual(shown.length, 0)
})

// ============================================================
//  truncate —— 两种通知共用的文本清洗
// ============================================================
test('truncate：折叠空白 / 截断加省略号 / 非字符串与空白 → 空串', () => {
  assert.strictEqual(notify.truncate('  a \n b  ', 10), 'a b')
  assert.strictEqual(notify.truncate('abcdef', 3), 'abc…')
  assert.strictEqual(notify.truncate('abc', 3), 'abc')
  assert.strictEqual(notify.truncate('   ', 5), '')
  assert.strictEqual(notify.truncate(null, 5), '')
  assert.strictEqual(notify.truncate(123, 5), '')
})
