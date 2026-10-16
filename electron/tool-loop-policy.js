// ============================================================
//  工具循环收口策略（middleware 语义）—— 2026-10-05
//
//  变更背景：原实现给工具循环设了 `TOOL_LOOP_LIMIT = 60` 的硬上限，跑满即强制
//  截断、再发一次「不带工具」的兜底请求逼答案。问题有两个：
//   ① 长任务（大范围检索、多文件重构、需要反复验证的活儿）被**步数**截断，
//      而步数跟「有没有干成事」并不相关；
//   ② 为了缓解①，旧实现又加了一串「第 40/45/50/55 轮提醒」——提醒是在替硬上限擦屁股，
//      模型知道上限后仍只能抢在 40 轮前收敛，本质还是数步数。
//
//  现在的模型：**内核无最大步数**。收口只依据**进展判据**——
//  连续若干轮没有拿到任何新信息（本轮调用的 (工具名, 参数) 组合之前全都用过，
//  且任务清单也没变化）才逐级升级强制力：
//
//      warn   ：提醒「最近几轮没有新信息」，请自查是不是在绕圈
//      wrapup ：明确要求「停止工具调用、立即作答」（内核仍允许它做最后一次必要调用）
//      stop   ：内核直接跳出工具循环，交给「不带工具的兜底请求」逼出最终回答
//
//  合法性：判据只看「是否拿到新信息」，因此**正常的长任务不会被误收口** ——
//  只要还在读新文件、跑新命令、推进清单，stall 就一直是 0。
//
//  本模块是**纯函数**、不依赖 electron（也不 require 任何本项目模块）：
//  主循环（electron/chat.js）与子代理（electron/sub-agent.js）共用同一套判据，
//  单测见 tests/tool-loop-policy.test.js。
//
//  ⚠️ 改阈值/文案前先跑那两个测试文件：它们锁的是「无步数上限」「按进展收口」两条不变量。
// ============================================================

/** macOS 之外的绝对刹车：不是预算，是防死循环的保险丝（真跑到这里说明模型彻底失控）。 */
const ABSOLUTE_STEP_CEILING = 400

// 软预算提醒的轮次点：20 / 35 / 50，之后每 25 轮一次。
// 只是「提醒你评估一下还剩多少活」，**不附带任何硬上限**——所以文案里不写「共 N 轮」。
const SOFT_BUDGET_MARKS = [20, 35, 50]
const SOFT_BUDGET_EVERY = 25

// 停滞升级阶梯（stall = 连续多少轮没拿到新信息的计数）
const STALL_WARN = 2      // 第 2 轮无新信息 → 提醒自查
const STALL_WRAPUP = 3    // 第 3 轮 → 要求收口作答
const STALL_STOP = 4      // 第 4 轮 → 停止工具调用，强制作答

// 「已见过的调用签名」集合上限：超过就清空重来（代价只是重新计一轮 stall，无正确性影响）
const SEEN_SIG_CAP = 2000

/** 新建一份策略状态（每个工具循环一份：主循环一轮对话一份，子代理各一份）。 */
function newState() {
  return {
    stall: 0,             // 连续「没拿到新信息」的轮数
    lastSig: '',          // 上一轮的进展签名（用于打断连续性判断）
    seen: new Set(),      // 见过的调用签名集合
    lastTodo: null,       // 上一轮的任务清单快照
    warnedAtStall: -1,    // 已经为哪一级停滞发过提醒（避免同级重复塞）
    wrapupArmed: false,   // 是否已发出收口指令
    softWarned: new Set(), // 已提醒过的软预算轮次点
  }
}

/** 调用签名：(工具名, 参数) 完全相同才算同一个调用。参数取原始字符串，拿不到就退化成空。 */
function sigOf(name, args) {
  const n = typeof name === 'string' ? name : ''
  let a = args
  if (a != null && typeof a !== 'string') {
    try {
      a = JSON.stringify(a)
    } catch {
      a = String(a)
    }
  }
  return `${n}\u0000${a == null ? '' : a}`
}

/**
 *  记一轮的产出，更新停滞计数。返回新的 stall 值。
 *
 *  「有进展」的定义（任一成立即可）：
 *    · 本轮至少有一次**此前没用过**的 (工具名, 参数) 调用 —— 新文件 / 新命令 / 新关键词；
 *    · 任务清单快照发生变化 —— 模型在推进计划（子代理不传，视为不适用）。
 *  注意只统计「本轮调用过」的签名：被重复调用拦下的那些本来就在 seen 里，天然算无进展。
 *
 *  @param {object} state newState() 的产物
 *  @param {object} round
 *  @param {Array<{name:string,args:string}>} [round.calls] 本轮实际发出（含被拦下）的调用
 *  @param {string|null} [round.todoSignature] 本轮任务清单快照（不适用传 null）
 */
function noteRound(state, round = {}) {
  if (!state) return 0
  if (!(state.seen instanceof Set)) state.seen = new Set()
  if (state.seen.size > SEEN_SIG_CAP) state.seen.clear()

  const calls = Array.isArray(round.calls) ? round.calls : []
  let fresh = false
  for (const c of calls) {
    if (!c) continue
    const sig = sigOf(c.name, c.args)
    if (!state.seen.has(sig)) {
      state.seen.add(sig)
      fresh = true
    }
  }

  const todo = round.todoSignature == null ? null : String(round.todoSignature)
  const todoChanged = todo != null && state.lastTodo != null && todo !== state.lastTodo
  if (todo != null) state.lastTodo = todo

  const productive = fresh || todoChanged
  if (productive) {
    // 拿到新信息 → 一切收口状态复位：之后若再次停滞，提醒可以重新发（不是「一轮对话只提醒一次」）
    state.stall = 0
    state.warnedAtStall = -1
    state.wrapupArmed = false
  } else if (calls.length > 0) {
    // 只有「真的发了调用却什么新东西都没拿到」才算停滞；空调用（模型给答案）不会走到这里
    state.stall = (state.stall || 0) + 1
  }
  state.lastSig = String(state.stall)
  return state.stall
}

/** 软预算提醒点：20 / 35 / 50，之后每 25 轮一次。 */
function isSoftMark(loop) {
  if (!Number.isFinite(loop) || loop < 0) return false
  if (SOFT_BUDGET_MARKS.includes(loop)) return true
  const last = SOFT_BUDGET_MARKS[SOFT_BUDGET_MARKS.length - 1]
  return loop > last && (loop - last) % SOFT_BUDGET_EVERY === 0
}

/** 软预算提醒文案：报已用轮数，请模型自查工作量 —— 刻意不写「共 N 轮」，因为没有硬上限。 */
function softBudgetText(loop) {
  return `【进度提醒】你已用掉 ${loop} 轮工具调用。请评估一下剩余工作量：` +
    '如果核心工作已经完成，请现在就给出最终回答；' +
    '如果还需要继续，请集中做真正推进目标的那几件事，不要为了「再确认一下」反复检索同一处。'
}

/** 停滞提醒：明确告诉模型「最近几轮没拿到新信息」，并给出两条出路。 */
function stallWarnText(stall = STALL_WARN) {
  return `【进展提醒】你最近 ${stall} 轮的调用**没有取得任何新信息**（调用的都是之前用过的相同工具+参数）。` +
    '请先判断：是信息已经足够、可以给回答了，还是必须换一个完全不同的思路/参数/工具？' +
    '两条路都行，但不要再用同样的方式重试一遍。'
}

/** 收口指令：停止工具调用、立即作答。 */
function wrapupText(stall = STALL_WRAPUP) {
  return `【收口指令】你已连续 ${stall} 轮没有取得新信息，继续调用工具不会带来更多结果。` +
    '**请立即停止调用工具**，基于已经获得的信息直接给出最终回答。' +
    '确实做不完就明确说明「已完成什么 / 还差什么 / 卡在哪」，不要把同一件事反复重试。'
}

/**
 *  本轮该做什么收口动作。**只依据进展判据与软预算轮次点，不依据任何步数上限。**
 *  返回 { action: 'none' | 'warn' | 'wrapup' | 'stop', text }（text 仅在需要注入提醒时存在）。
 *  命中后会就地更新 state 的提醒标记，保证同一阶段只提醒一次。
 */
function decideRound(state, { loop = 0 } = {}) {
  const st = state || {}
  const stall = Number(st.stall) || 0
  if (stall >= STALL_STOP) return { action: 'stop' }
  if (stall >= STALL_WRAPUP) {
    if (st.wrapupArmed) return { action: 'none' }
    st.wrapupArmed = true
    return { action: 'wrapup', text: wrapupText(stall) }
  }
  if (stall >= STALL_WARN) {
    if (st.warnedAtStall === stall) return { action: 'none' }
    st.warnedAtStall = stall
    return { action: 'warn', text: stallWarnText(stall) }
  }
  if (isSoftMark(loop)) {
    if (!(st.softWarned instanceof Set)) st.softWarned = new Set()
    if (st.softWarned.has(loop)) return { action: 'none' }
    st.softWarned.add(loop)
    return { action: 'warn', text: softBudgetText(loop) }
  }
  return { action: 'none' }
}

module.exports = {
  ABSOLUTE_STEP_CEILING,
  SOFT_BUDGET_MARKS,
  SOFT_BUDGET_EVERY,
  STALL_WARN,
  STALL_WRAPUP,
  STALL_STOP,
  SEEN_SIG_CAP,
  newState,
  sigOf,
  noteRound,
  isSoftMark,
  softBudgetText,
  stallWarnText,
  wrapupText,
  decideRound,
}
