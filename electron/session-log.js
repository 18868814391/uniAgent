// ============================================================
//  Session Log —— 会话日志（模型可见 ⟺ 已记录）
//
//  问题：渲染层落盘的 history 只有 { role, content } —— 工具调用与工具结果从来不进
//  <convId>.json，主进程的工具结果只活在单次请求的局部变量 currentMessages 里。
//  于是「这一轮模型到底看到了什么」在磁盘上**没有记录**，只能靠 turn-snapshot 这个
//  只在中途中断时才写的 sidecar 兜着；正常完成、报错、被新请求取代的轮次全部丢弃。
//
//  这里把每一轮的**完整消息序列**（含 assistant.tool_calls 与 tool 结果）作为正常产物
//  追加进 <convId>.log.json，并提供两个方向的投影：
//    · deriveMessages()  —— 日志 → 渲染层 history（只要用户 / AI 的文本，工具序列不出现）
//    · fullSequence()    —— 日志 → 回放用的完整序列（续跑时喂给 repairToolSequence）
//
//  与 turn-snapshot 的分工：快照是**中断时的临时 sidecar**（有 TTL、命中即清），
//  日志是**每轮都写的长期记录**（无 TTL）。续跑优先用快照，快照不在时由日志兜底 ——
//  应用崩过一次也还能接上断点，不再依赖"中断那一刻恰好写成了快照"。
//
//  ⚠️ 顶层不 require('electron')：单测在纯 node 下 require 本模块，惰性取 app.getPath。
// ============================================================
const path = require('path')
const fs = require('fs')

// 消息归一化与历史指纹全项目只有一份定义（turn-messages.js），避免「日志里的指纹」
// 与「快照里的指纹」漂移 —— 一旦漂移，续跑会静默失效（不报错，只是总不命中）。
// ⚠️ 这里不能从 turn-snapshot 解构：那会形成加载期耦合，只桩掉 turn-snapshot 的测试
//    （chat 系列）会把本模块一起打挂。
const { normalizeTurnMessages, hashHistory } = require('./turn-messages')

const LOG_VERSION = 1
// 单会话日志上限：超了就丢最旧的轮次（丢的同时会在日志里留一条 truncated 标记，
// 让 deriveMessages 不会误以为会话是从中间开始的）。64MB ≈ 一个长任务几十轮的体量。
const MAX_LOG_BYTES = 64 * 1024 * 1024
const MAX_TURNS = 500

function getLogPath(convId) {
  const { app } = require('electron')
  return path.join(app.getPath('userData'), 'conversations', `${convId}.log.json`)
}

// ============================================================
//  读写
// ============================================================

/** 读整份日志；不存在 / 版本不符 / 解析失败一律返回 null（调用方自然退回普通流程）。 */
function readLog(convId) {
  if (!convId) return null
  try {
    const p = getLogPath(convId)
    if (!fs.existsSync(p)) return null
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (!data || data.v !== LOG_VERSION) return null
    if (!Array.isArray(data.turns)) return null
    return data
  } catch (e) {
    console.warn('[session-log] 读取会话日志失败:', e && e.message)
    return null
  }
}

function writeLog(convId, log) {
  const p = getLogPath(convId)
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(p, JSON.stringify(log), 'utf-8')
}

/**
 * 追加一轮日志。
 *
 * 调用方传的是**已经还原过折叠**的消息（见 chat.js 的 persistTurnLog）——
 * 日志的用途是"回放真实工具结果"，存折叠摘要会让续跑的模型拿到一行占位符。
 *
 * @param {string} convId
 * @param {object} entry
 * @param {Array}  entry.messages   本轮从用户消息起的完整消息序列（system 会被丢掉）
 * @param {string} [entry.endReason] complete / aborted / timeout / error / unfinished_todos …
 * @param {string} [entry.abortedBy] user / idle / superseded / null
 * @param {string} [entry.inputHash] 本轮开始时渲染层 history 的指纹（续跑一致性校验用）
 * @returns {boolean} 是否写入成功
 */
function appendTurn(convId, { messages, endReason = '', abortedBy = null, inputHash = '' } = {}) {
  if (!convId) return false
  // system 不进日志：它每一轮都由调用方按当前开关/当前角色重建，
  // 存进日志只会在回放时把过期的提示词一起喂给模型。
  const rest = (Array.isArray(messages) ? messages : []).filter((m) => !m || m.role !== 'system')
  const normalized = normalizeTurnMessages(rest)
  if (normalized.length === 0) return false
  try {
    const log = readLog(convId) || { v: LOG_VERSION, convId, turns: [], truncated: 0 }
    const seq = log.turns.length ? log.turns[log.turns.length - 1].seq + 1 : 1
    log.turns.push({
      seq,
      ts: Date.now(),
      endReason: endReason || '',
      abortedBy: abortedBy || null,
      inputHash: typeof inputHash === 'string' ? inputHash : '',
      messages: normalized,
    })
    log.truncated = Math.max(0, log.truncated || 0)

    // 超限只丢最旧的轮次：保留最近的执行记录，truncated 记下丢了多少轮，
    // 让"日志不完整"这件事是显式的，而不是悄悄变成"会话从中间开始"。
    const tooManyTurns = log.turns.length > MAX_TURNS
    let text = JSON.stringify(log)
    if (tooManyTurns || text.length > MAX_LOG_BYTES) {
      let dropped = 0
      while (log.turns.length > 1 && (log.turns.length > MAX_TURNS || text.length > MAX_LOG_BYTES)) {
        log.turns.shift()
        dropped++
        text = JSON.stringify(log)
      }
      if (dropped > 0) {
        log.truncated += dropped
        console.warn(`[session-log] 日志超限，丢弃最早的 ${dropped} 轮（会话 ${convId}）`)
        writeLog(convId, log)
        return true
      }
    }
    writeLog(convId, log)
    return true
  } catch (e) {
    // 日志写失败绝不影响本轮对话：它只是"事后可复盘"，不是运行时依赖
    console.warn('[session-log] 写入会话日志失败:', e && e.message)
    return false
  }
}

function clearLog(convId) {
  if (!convId) return false
  try {
    const p = getLogPath(convId)
    if (!fs.existsSync(p)) return false
    fs.unlinkSync(p)
    return true
  } catch (e) {
    console.warn('[session-log] 删除会话日志失败:', e && e.message)
    return false
  }
}

// ============================================================
//  两个方向的投影
// ============================================================

/** 日志 / 轮次列表 → 完整消息序列（含工具调用与工具结果，按轮次顺序拼接）。 */
function fullSequence(logOrTurns) {
  const turns = Array.isArray(logOrTurns) ? logOrTurns : (logOrTurns && logOrTurns.turns) || []
  const out = []
  for (const turn of turns) {
    if (!turn || !Array.isArray(turn.messages)) continue
    for (const m of turn.messages) if (m && typeof m === 'object') out.push(m)
  }
  return out
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n\n')
  }
  return ''
}

/**
 * 完整序列 → 渲染层 history。
 * 只保留用户 / AI 的文本：tool 消息与 assistant.tool_calls 不进历史（渲染层不认识它们），
 * content 为空的 assistant 消息（纯工具调用轮）同样跳过 —— 否则会出现空泡。
 *
 * @param {Array|object} messagesOrLog 完整序列，或日志对象 / 轮次列表
 * @returns {Array<{role: string, content: string}>}
 */
function deriveMessages(messagesOrLog) {
  const seq = Array.isArray(messagesOrLog) && messagesOrLog.some((m) => m && m.messages)
    ? fullSequence(messagesOrLog)
    : (Array.isArray(messagesOrLog) ? messagesOrLog : fullSequence(messagesOrLog))
  const out = []
  for (const m of seq) {
    if (!m || typeof m !== 'object') continue
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text = contentText(m.content)
    if (m.role === 'assistant' && !text) continue
    const item = { role: m.role, content: text }
    if (m.role === 'assistant' && m.partial === true) item.partial = true
    out.push(item)
  }
  return out
}

/**
 * 用日志判断这次「继续」能不能接上断点（快照不存在时的兜底）。
 *
 * 与 turn-snapshot.loadResumableTurn 同一套一致性要求，只是数据来源换成日志：
 *   ① 日志最后一轮**没有正常完成**（完成过的轮次没有可续跑的东西）；
 *   ② 该轮确实调过工具（纯文本的半截回答渲染层已经按 partial 落盘了，不需要回放）；
 *   ③ 渲染层这次发来的 history（去掉末尾「继续」指令与半截 assistant）与日志投影完全一致。
 *
 * @param {string} convId
 * @param {object} input
 * @param {Array} input.messages 渲染层本次发来的 history
 * @returns {{messages: Array, abortedBy: string|null, endReason: string, turnSeq: number}|null}
 */
function matchResumableTurn(convId, { messages } = {}) {
  const log = readLog(convId)
  if (!log || !log.turns.length) return null
  const last = log.turns[log.turns.length - 1]
  if (!last || !Array.isArray(last.messages) || last.messages.length === 0) return null
  // 正常完成的轮次不留续跑入口（与快照口径一致）
  if (last.endReason === 'complete' || last.endReason === 'text_tool_call') return null
  const hasToolActivity = last.messages.some(
    (m) => m && (m.role === 'tool' || (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length)),
  )
  if (!hasToolActivity) return null

  const list = Array.isArray(messages) ? messages : []
  if (list.length === 0 || !list[list.length - 1] || list[list.length - 1].role !== 'user') return null
  // 渲染层在中断后会把半截 assistant 回答补进历史，跳过它再比对
  let end = list.length - 1
  while (end > 0 && list[end - 1] && list[end - 1].role === 'assistant') end--
  const head = list.slice(0, end)

  const derived = deriveMessages(log)
  // 两种形状都接受，且都要求**整段哈希严格相等**（不做模糊匹配，避免回放到别的上下文里）：
  //   ① 日志里记了那段半截回答（中断发生在 push assistant 之后）→ 直接比
  //   ② 渲染层自己补了半截回答、日志里没有 → 两边都去掉尾部 assistant 再比
  const stripTrailingAssistant = (arr) => (
    arr.length && arr[arr.length - 1].role === 'assistant' ? arr.slice(0, -1) : arr
  )
  const matched =
    hashHistory(head) === hashHistory(derived) ||
    hashHistory(stripTrailingAssistant(head)) === hashHistory(stripTrailingAssistant(derived))
  if (!matched) return null

  return {
    messages: fullSequence(log),
    abortedBy: last.abortedBy || null,
    endReason: last.endReason || '',
    turnSeq: last.seq,
  }
}

module.exports = {
  LOG_VERSION,
  MAX_LOG_BYTES,
  MAX_TURNS,
  getLogPath,
  readLog,
  appendTurn,
  clearLog,
  fullSequence,
  deriveMessages,
  matchResumableTurn,
}
