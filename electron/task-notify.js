// ============================================================
//  任务提醒通知 —— 长任务跑完 / 出错 / 需要你作答时，在屏幕右下角弹一条系统通知
//
//  为什么必须在主进程发、而不是渲染层做一个页面内 toast：
//  用户切到别的应用之后，应用窗口里的任何元素都不可见 —— 只有操作系统级通知
//  （Windows 10/11 走 Action Center 横幅，出现在屏幕右下角）才能穿透到用户眼前。
//  本模块的触发前提就是「窗口不在前台」，页面内提示在这个场景下等于没提示。
//
//  三种场景都会提醒（都是"用户切走了、需要有人告诉他"的情况）：
//    - 正常完成 ：「XXX」已完成
//    - 异常结束 ：「XXX」执行出错（超时 / 报错 / 轮次耗尽 / 没生成回答 / 工具调用没执行）
//    - 需要作答 ：ask_user 弹出提问卡片 —— **对话真的卡住了**，用户不回来点它就永远不动
//
//  刻意**不**提醒的一种：'aborted' —— 用户自己点的「中断」，他就在旁边，再弹通知是废话。
//
//  收紧条件：
//   - 只在**窗口不在前台**时发 —— 用户就盯着界面看的时候再弹通知纯属噪音。
//   - 结束类通知还要求**跑够久**（<15s 不打扰）；**ask_user 不设时长门槛** ——
//     它不是"结果"，而是"现在轮到你了"，无论多早发生都在阻塞整轮对话。
//   - 点击通知把主窗口拉回前台（最小化则还原），省得用户再去任务栏找。
//
//  决策逻辑（classifyEndReason / shouldNotifyTaskEnd / shouldNotifyAskUser / 各 build*Notice /
//  extractTaskText / formatDuration）刻意做成不依赖 electron 的**纯函数**，由
//  tests/task-notify.test.js 在纯 Node 下直接测；只有 notifyTaskEnd / notifyAskUser 这两层
//  真正用到 electron。故单测 require 本模块时必须桩掉 electron。
// ============================================================
const { Notification } = require('electron')

// 最短提醒时长：15 秒以内的**结束**类任务用户基本还没切走，弹通知只会打断。
// 注意：ask_user 不适用（见文件头说明）。
const MIN_DURATION_MS = 15 * 1000
// 通知正文里回显任务描述的长度上限：Windows 横幅正文约两行，再长会被系统截成省略号。
const TASK_MAX_CHARS = 40
// ask_user 的问题比任务名更"要命"（用户得先看懂问的是什么），给多一点空间。
const QUESTION_MAX_CHARS = 60

// 正常收尾
const DONE_REASONS = ['complete']
// 异常收尾（endReason 取值见 chat.js 收尾段）。
// text_tool_call 也算异常：网关不支持原生 function calling，本轮工具一个都没真跑，
// 用法上等同于"AI 说要干活然后什么都没干"——用户切走时最需要知道的就是这种静默失败。
const FAILED_REASONS = ['timeout', 'error', 'max_iterations', 'no_answer', 'text_tool_call']
// 异常原因 → 通知里的一句话。用「用户看得懂的现象」而不是 endReason 的内部枚举名。
const FAILED_LABELS = {
  timeout: '连接超时，任务中断',
  error: '执行出错，任务未完成',
  max_iterations: '达到工具轮次上限，任务未完成',
  no_answer: '未生成回答',
  text_tool_call: '工具调用未执行（当前网关不支持原生 function calling）',
}

// 通知标题（Windows 横幅第一行，加粗），正文在第二行。
const NOTICE_TITLE_DONE = 'Local AI · 任务完成'
const NOTICE_TITLE_FAILED = 'Local AI · 任务未完成'
const NOTICE_TITLE_ASK = 'Local AI · 需要你作答'

/** 折叠空白 + 截断（通知正文只能放一行一截）。空白/非字符串 → 空串。 */
function truncate(text, maxChars) {
  const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  if (!t) return ''
  return t.length > maxChars ? `${t.slice(0, maxChars)}…` : t
}

/**
 * 收尾原因归类：'done'（正常完成）/ 'failed'（异常结束）/ null（不提醒）。
 * 唯一的名单源 —— 不要在别处再抄一份 reason 列表。
 * 'aborted' 刻意归 null（用户主动点中断），'superseded'（被新请求取代）更不该提醒。
 */
function classifyEndReason(reason) {
  if (DONE_REASONS.includes(reason)) return 'done'
  if (FAILED_REASONS.includes(reason)) return 'failed'
  return null
}

/**
 * 毫秒 → 中文时长（用于通知正文）
 * <60s        → 「42 秒」
 * <60min      → 「2 分 15 秒」（整分省略秒）
 * 其它        → 「1 小时 5 分」
 */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec} 秒`
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) {
    const sec = totalSec % 60
    return sec === 0 ? `${totalMin} 分` : `${totalMin} 分 ${sec} 秒`
  }
  const hour = Math.floor(totalMin / 60)
  const min = totalMin % 60
  return min === 0 ? `${hour} 小时` : `${hour} 小时 ${min} 分`
}

// 消息 content 可能是裸字符串（常规），也可能是 content parts 数组（图片/视觉输入）。
// 这里只取文本部分：通知里回显「用户让 AI 干了什么」，图片路径没有意义。
function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join(' ')
  }
  return ''
}

/**
 * 从本轮的 messages 里取「最后一条用户消息」作为任务描述（= 用户视觉里的"这个任务叫什么"）。
 * 找不到就返回空串，调用方退化成不带任务名的通用文案。
 */
function extractTaskText(messages, maxChars = TASK_MAX_CHARS) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    const text = truncate(contentToText(m.content), maxChars)
    if (text) return text
  }
  return ''
}

/**
 * 纯决策：这次**收尾**要不要弹系统通知。
 * @param {object} o
 * @param {string} o.reason       本轮结束原因（chat.js 的 endReason）
 * @param {number} o.elapsedMs    本轮墙钟耗时
 * @param {boolean} o.focused     收尾时主窗口是否在前台
 * @param {boolean} [o.enabled]   用户开关（settings.notifyOnTaskEnd）
 * @param {number} [o.minDurationMs]
 */
function shouldNotifyTaskEnd({
  reason,
  elapsedMs,
  focused,
  enabled = true,
  minDurationMs = MIN_DURATION_MS,
} = {}) {
  if (!enabled) return false
  if (!classifyEndReason(reason)) return false
  if (focused) return false
  if (!Number.isFinite(elapsedMs) || elapsedMs < minDurationMs) return false
  return true
}

/**
 * 纯决策：ask_user 挂起时要不要弹系统通知。
 * 与结束类不同：**不设时长门槛** —— 提问随时可能来，而它一挂起整轮对话就停住了，
 * 用户切走的话会一直干等（界面看不出"在等谁"）。只看「窗口是否失焦 + 开关」。
 */
function shouldNotifyAskUser({ focused, enabled = true } = {}) {
  if (!enabled) return false
  // 必须**明确**是失焦才提醒（focused === false）。缺省/拿不到焦点状态时不打扰 ——
  // 与 notifyAskUser 的 windowFocusState 约定一致：拿不到状态一律当"在前台"。
  return focused === false
}

/** 纯函数：结束通知文案。任务名取不到时退化成通用文案。 */
function buildTaskNotice({ reason, task, elapsedMs } = {}) {
  const kind = classifyEndReason(reason)
  const name = typeof task === 'string' ? task.trim() : ''
  const tip = formatDuration(elapsedMs)
  const parts = []
  if (kind === 'failed') {
    const label = FAILED_LABELS[reason] || '任务未完成'
    parts.push(name ? `「${name}」${label}` : label)
  } else {
    parts.push(name ? `「${name}」已完成` : '任务已完成')
  }
  if (tip) parts.push(`耗时 ${tip}`)
  return {
    title: kind === 'failed' ? NOTICE_TITLE_FAILED : NOTICE_TITLE_DONE,
    body: parts.join(' · '),
  }
}

/** 纯函数：ask_user 通知文案。问题本身就是要传递的信息，任务名只作补充。 */
function buildAskNotice({ question, task } = {}) {
  const q = truncate(question, QUESTION_MAX_CHARS)
  const name = typeof task === 'string' ? task.trim() : ''
  // 问题为空（模型没给 question 字段）时退化成通用文案，并带上任务名帮助定位
  const head = q || (name ? `「${name}」等你确认` : 'AI 正在等你作答')
  return { title: NOTICE_TITLE_ASK, body: q ? `${head}（点击作答）` : `${head}（点击查看）` }
}

// 把主窗口拉回前台：最小化则还原、隐藏则显示，最后 focus。
// 任一环节在窗口已销毁时会抛，故整体兜底 —— 通知的点击回调绝不能把主进程带崩。
function focusWindow(win) {
  try {
    if (!win || win.isDestroyed()) return
    if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore()
    if (typeof win.isVisible === 'function' && !win.isVisible()) win.show()
    win.focus()
  } catch (e) {
    console.warn('[notify] focus window failed:', e && e.message)
  }
}

// 主窗口可用性 + 焦点状态。窗口没了（已销毁 / 未传）返回 null → 调用方直接放弃：
// 没人可提醒，点通知也没处落。拿不到焦点状态时保守当作"在前台"，宁可不打扰。
function windowFocusState(win) {
  if (!win) return null
  try {
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return null
  } catch (e) {
    return null
  }
  try {
    return { focused: !!(typeof win.isFocused === 'function' && win.isFocused()) }
  } catch (e) {
    return { focused: true }
  }
}

// 真正把横幅推给操作系统（唯一的副作用点）。点通知 → 拉回前台。
function emitNotice(win, { title, body }) {
  if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) return false
  const notice = new Notification({ title, body, silent: false })
  notice.on('click', () => focusWindow(win))
  notice.show()
  return true
}

/**
 * 长任务收尾通知（完成 / 异常）。返回是否真的发出了，供调用方记日志/测试断言。
 * 任何异常都不外抛：通知只是锦上添花，不能影响对话收尾。
 */
function notifyTaskEnd({ win, reason, elapsedMs, task, enabled, minDurationMs } = {}) {
  const st = windowFocusState(win)
  if (!st) return false
  if (!shouldNotifyTaskEnd({ reason, elapsedMs, focused: st.focused, enabled, minDurationMs })) return false
  return emitNotice(win, buildTaskNotice({ reason, task, elapsedMs }))
}

/**
 * ask_user 挂起通知：「AI 在等你回答」。
 * 场景很关键 —— 提问卡片在窗口里，用户切走后**整轮对话就停在那里**，
 * 不提醒的话他会以为任务还在跑（或根本没在意），可能白等很久。
 */
function notifyAskUser({ win, question, task, enabled } = {}) {
  const st = windowFocusState(win)
  if (!st) return false
  if (!shouldNotifyAskUser({ focused: st.focused, enabled })) return false
  return emitNotice(win, buildAskNotice({ question, task }))
}

module.exports = {
  MIN_DURATION_MS,
  TASK_MAX_CHARS,
  QUESTION_MAX_CHARS,
  NOTICE_TITLE_DONE,
  NOTICE_TITLE_FAILED,
  NOTICE_TITLE_ASK,
  FAILED_LABELS,
  truncate,
  classifyEndReason,
  formatDuration,
  extractTaskText,
  shouldNotifyTaskEnd,
  shouldNotifyAskUser,
  buildTaskNotice,
  buildAskNotice,
  notifyTaskEnd,
  notifyAskUser,
}
