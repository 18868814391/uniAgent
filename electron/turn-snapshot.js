// ============================================================
//  Turn Snapshot —— 中断续跑快照（sidecar）
//  拥有:「被中断的那一轮」完整消息序列（含 assistant.tool_calls 与 tool 结果）
//  的落盘 / 校验 / 读取 / 清理，以及回放前的工具序列修复。
//
//  为什么需要它：渲染层 history 只带 { role, content }（工具调用与结果从不落盘），
//  主进程的工具结果只活在单次请求的局部变量 currentMessages 里。中断即丢，
//  用户点「继续」只能拿纯文本历史重建请求 → 已跑过的工具全部重跑一遍。
//  这里把那一轮的消息序列落成 <convId>.turn.json，续跑时直接回放。
// ============================================================
const path = require('path')
const fs = require('fs')
const { app } = require('electron')
// 消息归一化与历史指纹：与 session-log.js 共用同一份实现（见 turn-messages.js 头部）
const { normalizeTurnMessages, hashHistory } = require('./turn-messages')

const SNAPSHOT_VERSION = 1
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000   // 超期快照不再参与续跑（防陈旧命中）
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024    // 单份快照上限，防异常会话写爆磁盘

// 被中断的工具在回放时补的占位结果：真实结果没拿到，必须让模型知道"这个没跑成"，
// 而不是让它以为成功（旧行为就是结果整段消失，模型只能重跑一遍来确认）。
const INTERRUPTED_TOOL_RESULT = JSON.stringify({
  success: false,
  interrupted: true,
  error: '该工具在上一次执行中被中断，没有取得结果。需要时请重新调用。',
})

function getSnapshotPath(convId) {
  return path.join(app.getPath('userData'), 'conversations', `${convId}.turn.json`)
}

// ============================================================
//  历史一致性校验
// ============================================================

// hashHistory / normalizeTurnMessages 都在 turn-messages.js（与 session-log 共用同一份口径）。
// 这里保留同名引用，调用方与测试无需改路径。

// ============================================================
//  落盘 / 读取 / 清理
// ============================================================

/**
 * 落盘一份续跑快照。
 * @param {string} convId
 * @param {object} payload
 * @param {Array}  payload.messages     本轮（从用户消息起）的完整消息序列
 * @param {number} payload.historyCount 中断时渲染层发来的 history 长度
 * @param {string} payload.inputHash    该 history 的指纹
 * @param {string} [payload.abortedBy]  中断原因：user / idle / null
 * @param {string} [payload.endReason]
 * @returns {boolean} 是否写入成功
 */
function saveTurnSnapshot(convId, { messages, historyCount, inputHash, abortedBy = null, endReason = '' }) {
  if (!convId) return false
  const list = normalizeTurnMessages(messages)
  if (list.length === 0) return false
  const payload = {
    v: SNAPSHOT_VERSION,
    convId,
    savedAt: Date.now(),
    historyCount: Number.isInteger(historyCount) ? historyCount : 0,
    inputHash: typeof inputHash === 'string' ? inputHash : '',
    abortedBy: abortedBy || null,
    endReason: endReason || '',
    messages: list,
  }
  try {
    const text = JSON.stringify(payload)
    if (text.length > MAX_SNAPSHOT_BYTES) {
      console.warn(`[turn] 快照过大（${text.length} 字符），跳过落盘，续跑将退回重建历史`)
      return false
    }
    const p = getSnapshotPath(convId)
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(p, text, 'utf-8')
    return true
  } catch (e) {
    console.error('[turn] 保存续跑快照失败:', e.message)
    return false
  }
}

// 读取并做形状校验；任何异常/版本不符/缺关键字段都返回 null（调用方自然退回普通流程）
function loadTurnSnapshot(convId) {
  if (!convId) return null
  try {
    const p = getSnapshotPath(convId)
    if (!fs.existsSync(p)) return null
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (!data || data.v !== SNAPSHOT_VERSION) return null
    if (!Array.isArray(data.messages) || data.messages.length === 0) return null
    if (!Number.isFinite(data.savedAt)) return null
    if (!Number.isInteger(data.historyCount) || data.historyCount <= 0) return null
    if (typeof data.inputHash !== 'string' || !data.inputHash) return null
    return data
  } catch (e) {
    console.error('[turn] 读取续跑快照失败:', e.message)
    return null
  }
}

function clearTurnSnapshot(convId) {
  if (!convId) return false
  try {
    const p = getSnapshotPath(convId)
    if (!fs.existsSync(p)) return false
    fs.unlinkSync(p)
    return true
  } catch (e) {
    console.error('[turn] 删除续跑快照失败:', e.message)
    return false
  }
}

/**
 * 判断这份快照还能不能用于本次「继续」。
 * 要求：未超期 + 渲染层这次发来的 history 严格等于中断那一刻的 history，
 * 只是末尾多出「继续」指令（以及渲染层补进历史的半截 assistant 回答）。
 */
function loadResumableTurn(convId, { messages } = {}) {
  const snap = loadTurnSnapshot(convId)
  if (!snap) return null
  if (Date.now() - snap.savedAt > SNAPSHOT_TTL_MS) {
    clearTurnSnapshot(convId)   // 超期即清理，不留孤儿
    return null
  }
  const list = Array.isArray(messages) ? messages : []
  if (list.length === 0) return null
  // 末尾必须是本次「继续」指令
  if (!list[list.length - 1] || list[list.length - 1].role !== 'user') return null
  // 跳过渲染层在中断后补进历史的半截 assistant 回答，回到中断时的 history 长度
  let end = list.length - 1
  while (end > 0 && list[end - 1] && list[end - 1].role === 'assistant') end--
  if (end !== snap.historyCount) return null
  if (hashHistory(list.slice(0, end)) !== snap.inputHash) return null
  return snap
}

/**
 * 是否存在"未超期"的续跑快照（只判断存在性，不校验 history 一致性）。
 * 渲染层在用户主动中断后据此决定要不要给一个中性的「继续」入口 ——
 * 真正的续跑仍由 loadResumableTurn 严格校验，这里宽松一点不会出错。
 */
function hasResumableTurn(convId) {
  const snap = loadTurnSnapshot(convId)
  if (!snap) return false
  return Date.now() - snap.savedAt <= SNAPSHOT_TTL_MS
}

// ============================================================
//  回放前的工具序列修复
// ============================================================

/**
 * OpenAI 兼容接口要求：assistant.tool_calls 里每个 id 都必须有紧随其后的 tool 结果消息。
 * 中断会截断这个序列（批量工具只跑了一半、或最后一个工具被杀），原样回放会被服务端 400。
 * 这里按 tool_calls 的顺序重建：有真实结果就用真实结果，缺的补一条 interrupted 占位，
 * 同时丢弃所有孤儿 tool 消息（没有对应 tool_calls 的残留）。
 * @returns {{messages: Array, total: number, repaired: number}}
 */
function repairToolSequence(messages) {
  const byCallId = new Map()
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m && m.role === 'tool' && typeof m.tool_call_id === 'string' && !byCallId.has(m.tool_call_id)) {
      byCallId.set(m.tool_call_id, m)
    }
  }
  const out = []
  let total = 0
  let repaired = 0
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue
    if (m.role === 'system') continue            // system 由调用方按当前开关重新构建
    if (m.role === 'tool') continue              // 只在对应 tool_calls 处回填，避免孤儿
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.push({ role: 'assistant', content: m.content || null, tool_calls: m.tool_calls })
      for (const tc of m.tool_calls) {
        total++
        const hit = tc && tc.id ? byCallId.get(tc.id) : null
        if (hit) {
          out.push({ role: 'tool', tool_call_id: tc.id, content: typeof hit.content === 'string' ? hit.content : '' })
        } else {
          out.push({ role: 'tool', tool_call_id: tc.id, content: INTERRUPTED_TOOL_RESULT })
          repaired++
        }
      }
      continue
    }
    out.push({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })
  }
  return { messages: out, total, repaired }
}

module.exports = {
  SNAPSHOT_TTL_MS,
  INTERRUPTED_TOOL_RESULT,
  getSnapshotPath,
  hashHistory,
  // 消息归一化：session-log.js 复用同一份实现，避免「快照收窄的字段」与「日志收窄的字段」漂移
  normalizeTurnMessages,
  saveTurnSnapshot,
  loadTurnSnapshot,
  loadResumableTurn,
  hasResumableTurn,
  clearTurnSnapshot,
  repairToolSequence,
}
