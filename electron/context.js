// ============================================================
//  Context —— 会话上下文压缩 / token 估算 / 摘要持久化
//  拥有:轻量 token 估算、压缩切分边界计算、模型摘要生成、
//  摘要 sidecar 读写、上下文压缩总入口。
// ============================================================
const path = require('path')
const fs = require('fs')
const { app } = require('electron')
const state = require('./state')
const { callJson } = require('./ai')
const { MIN_CONTEXT_WINDOW, MODEL_CONTEXT_WINDOWS, DEFAULT_CONTEXT_WINDOW } = require('./settings')
const { TOOLS_DEFINITION } = require('./tool-schemas')
const { readToolActivity, renderToolActivity } = require('./tool-activity')

// ============================================================
//  会话上下文压缩：超阈值时保留最近几轮完整对话，更早历史压缩成摘要。
//  摘要以"单变量覆盖"持久化（每次压缩整体替换旧版），System Prompt 长度保持稳定。
// ============================================================
const LAST_ROUNDS_KEPT = 3            // 保留的最近完整轮次（用户回合）
const CONTEXT_BUDGET_FACTOR = 0.6     // 触发压缩的总上下文预算占比（给输出与工具循环留余量）
const RECENT_BUDGET_FACTOR = 0.4      // "最近N轮"单独最多占窗口的比例（防单轮超大）
const SUMMARY_MAX_TOKENS = 1200       // 摘要生成 max_tokens
// 摘要长度：超过 ACCEPT_MAX 视为异常（模型跑飞），截断保留而不是整份丢弃 ——
// 丢弃会退化成「最初诉求 200 字 + 最近结论 300 字」的启发式摘要，信息损失大得多。
const SUMMARY_ACCEPT_MAX = 8000
const SUMMARY_TRUNCATE_TO = 4000

// ============================================================
//  轻量估算与窗口
// ============================================================

// 轻量 token 估算（不联网）：CJK 字符 ≈1 token/字、ASCII ≈3 字符/token，偏保守。
// 只用于判断"是否需要压缩"，够用即可，不追求精确。
function estimateTokens(text) {
  if (!text) return 0
  const str = String(text)
  const cjkChars = (str.match(/[㐀-鿿぀-ヿ가-힯豈-﫿]/g) || []).length
  const asciiChars = str.length - cjkChars
  return Math.ceil(cjkChars * 1.0 + asciiChars / 3.0)
}

// 视觉载荷按"真实成本"计：图片 ≈ 宽×高/750。这里拿不到尺寸（part 里只有 base64），
// 就按 1280px 降采样的经验值 1.5k 计。
// ⚠️ 绝不能对 image_url part 走 estimateTokens —— 那会把 base64 当普通 ASCII 按
// 3 字符/token 算：一张 200KB 的降采样图 ≈ 7 万"token"，1MB 的载荷直接虚高到 35 万，
// 输入区的「上下文占用」会显示成爆窗（实际只有几 k）。用户会以为出了故障。
const IMAGE_PART_TOKENS = 1500

function estimateContentTokens(content) {
  if (typeof content === 'string') return estimateTokens(content)
  // 数组 content = 多模态消息（text part + image_url part）
  if (Array.isArray(content)) {
    let total = 0
    for (const part of content) {
      if (!part) continue
      if (part.type === 'text') total += estimateTokens(part.text)
      else if (part.type === 'image_url') total += IMAGE_PART_TOKENS
    }
    return total
  }
  return estimateTokens(content)
}

function estimateMessagesTokens(messages) {
  let total = 0
  for (const m of messages) {
    if (!m) continue
    total += estimateContentTokens(m.content)
    if (Array.isArray(m.tool_calls)) total += estimateTokens(JSON.stringify(m.tool_calls))
  }
  return total
}

// 取生效的上下文窗口。优先级：
//   ① 调用方显式传入的窗口（= 本次请求所用 profile 的窗口）—— 多模型配置下，
//      state.settings.contextWindow 记的是「当前激活 profile」，未必是发请求的那个；
//   ② 用户配置的窗口（接非 deepseek 模型时必须手动设置，否则压缩阈值会失准）；
//   ③ 内置模型表 → 默认值。
function getModelContextWindow(model, requestedWindow) {
  if (typeof requestedWindow === 'number' && requestedWindow >= MIN_CONTEXT_WINDOW) return requestedWindow
  if (state.settings && typeof state.settings.contextWindow === 'number' && state.settings.contextWindow >= MIN_CONTEXT_WINDOW) {
    return state.settings.contextWindow
  }
  return MODEL_CONTEXT_WINDOWS[model] || DEFAULT_CONTEXT_WINDOW
}

// ============================================================
//  压缩切分与摘要生成
// ============================================================

// 计算压缩切分点：只允许切在"用户消息"处（保证轮次完整，且不会把 tool 消息与它
// 依赖的 assistant tool_calls 拆开）。返回切分下标（该下标起保留），0 表示无需切分。
function findCompactionBoundary(messages, recentBudgetTokens) {
  const userPositions = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') userPositions.push(i)
  }
  const lastKeptUserIdx = userPositions.length - LAST_ROUNDS_KEPT
  let boundary = lastKeptUserIdx > 0 ? userPositions[lastKeptUserIdx] : 0
  // 双约束："最近 N 轮"若仍超预算，从旧到新再切整轮（至少保留 1 轮）
  while (boundary > 0) {
    if (estimateMessagesTokens(messages.slice(boundary)) <= recentBudgetTokens) break
    let uCount = 0
    let secondUser = -1
    for (let j = boundary; j < messages.length; j++) {
      if (messages[j].role === 'user') {
        uCount++
        if (uCount === 2) { secondUser = j; break }
      }
    }
    if (secondUser <= boundary) break   // 只剩 1 个回合，不再切
    boundary = secondUser
  }
  return boundary
}

// 把一段历史序列化成紧凑文本供摘要模型阅读：每条限长 + 总量截断，防单条/整段爆炸
function serializeMessagesForSummary(msgs) {
  const parts = []
  for (const m of msgs) {
    if (!m || !m.role || m.role === 'system') continue
    const label = { user: '用户', assistant: 'AI', tool: '工具结果' }[m.role] || m.role
    let content = m.content ? String(m.content) : ''
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls
        .map((tc) => `${tc.function && tc.function.name}(${String((tc.function && tc.function.arguments) || '').slice(0, 300)})`)
        .join('; ')
      content = content ? `${content}\n[调用工具] ${calls}` : `[调用工具] ${calls}`
    }
    if (content.length > 4000) {
      content = content.slice(0, 4000) + '…'
    }
    parts.push(`【${label}】${content}`)
  }
  // 总量截断，防止更早历史巨大时把摘要请求体撑爆
  const MAX_TOTAL = 60000
  let total = 0
  const out = []
  for (const p of parts) {
    if (total + p.length > MAX_TOTAL) {
      out.push(`……（其余 ${parts.length - out.length} 条已省略，仅保留最近内容）`)
      break
    }
    out.push(p)
    total += p.length
  }
  return out.join('\n\n')
}

// 用模型把更早历史 + 上一版摘要 + 工具活动台账压缩成一份新摘要（JSON mode）。
// 失败返回 null，调用方走启发式兜底。
async function summarizeHistory({ key, model, oldSummary, crossed, activityText, signal, onRetry }) {
  const oldPart = oldSummary ? `【上一版摘要（请继承其要点，不要遗漏既有结论）】\n${oldSummary}\n\n` : ''
  // 工具活动台账：历史 messages 里**没有**工具调用与结果（渲染层只落 { role, content }），
  // 不带上这一段，摘要出来的就是「聊了什么」而不是「做了什么」—— 压缩后模型会重复读同一个文件、
  // 甚至覆盖已完成的改动。详见 electron/tool-activity.js 头部。
  const activityPart = activityText
    ? `【本次要压缩的这段时间里，AI 实际执行过的工具操作（按时间顺序，✗ 表示失败）】\n${activityText}\n\n`
    : ''
  const data = await callJson({
    key,
    model,
    maxTokens: SUMMARY_MAX_TOKENS,
    signal,
    onRetry,
    messages: [
      {
        role: 'system',
        content:
          '你是对话历史摘要器。把用户提供的旧摘要、工具活动台账和新增对话历史合并压缩成一份信息完整的中文要点摘要。\n' +
          '**必须按下面这个固定骨架输出**（小节标题原样保留，没有内容的小节写「无」）：\n' +
          '## 用户诉求（当前任务的整体目标与约束）\n' +
          '## 已完成（含改了哪些文件的**绝对路径**、关键改动内容）\n' +
          '## 未完成（明确的待办与卡点）\n' +
          '## 关键文件与位置（绝对路径 / 函数名 / 类名 / 字段名，逐字保留，不要概括）\n' +
          '## 关键结论与决策（已确认的事实、口径、参数）\n' +
          '## 已试过且不成立的做法（避免后面重复尝试）\n' +
          '## 下一步\n' +
          '硬性要求：文件路径、函数名、命令、字段名、数字必须**逐字保留**，不要改写成同义词、不要省略；' +
          '工具台账里「改过/删过哪些文件」必须落进「已完成」，失败的尝试必须落进「已试过且不成立的做法」。' +
          '省略寒暄与重复内容。请用 json 格式输出，只输出一个 JSON 对象：{"summary":"摘要文本"}。',
      },
      {
        role: 'user',
        content: `${oldPart}${activityPart}【新增的历史对话】\n${serializeMessagesForSummary(crossed)}`,
      },
    ],
  })
  let summary = typeof data?.summary === 'string' ? data.summary.trim() : ''
  if (!summary) return null
  // 超长不整份丢弃（丢弃会退化成 3 行启发式摘要，信息损失远大于截断），截断保留。
  if (summary.length > SUMMARY_ACCEPT_MAX) {
    console.warn(`[compact] 摘要异常超长（${summary.length} 字符），已截断保留前 ${SUMMARY_TRUNCATE_TO}`)
    summary = summary.slice(0, SUMMARY_TRUNCATE_TO) + '…（摘要过长已截断）'
  }
  return summary
}

// 摘要生成的启发式兜底：模型压缩失败时，保留上一版摘要 + 最初诉求 + 最近结论
function heuristicFallbackSummary(oldSummary, crossed) {
  const parts = []
  if (oldSummary) parts.push(`上一版摘要：${oldSummary}`)
  const firstUser = crossed.find((m) => m.role === 'user' && m.content)
  if (firstUser) parts.push(`最初诉求：${String(firstUser.content).slice(0, 200)}`)
  const lastAssistant = [...crossed].reverse().find((m) => m.role === 'assistant' && m.content)
  if (lastAssistant) parts.push(`最近结论：${String(lastAssistant.content).slice(0, 300)}`)
  if (parts.length === 0) return ''
  return `（模型压缩失败，以下为启发式摘要，信息可能不完整）${parts.join('；')}`
}

// ============================================================
//  历史摘要持久化：独立 sidecar 文件 <convId>.summary.json
// ============================================================
function getConvSummaryPath(id) {
  return path.join(app.getPath('userData'), 'conversations', `${id}.summary.json`)
}
function readConvSummary(id) {
  try {
    const p = getConvSummaryPath(id)
    if (!fs.existsSync(p)) return ''
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return typeof data?.summary === 'string' ? data.summary : ''
  } catch {
    return ''
  }
}
function writeConvSummary(id, summary) {
  try {
    const p = getConvSummaryPath(id)
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ summary, updatedAt: Date.now() }, null, 2), 'utf-8')
  } catch (e) {
    console.error('[compact] 保存历史摘要失败:', e.message)
  }
}
function deleteConvSummary(id) {
  try {
    const p = getConvSummaryPath(id)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch (e) {
    console.error('[compact] 删除历史摘要失败:', e.message)
  }
}

// 上下文压缩入口：仅在超阈值时执行，返回压缩后的 currentMessages（system + 最近轮次）；
// 未超阈值返回 null，调用方用原始 messages 组装。signal 用于支持压缩期间被"停止"中断。
async function maybeCompactHistory({ event, conversationId, messages, apiKey, model, systemContent, contextWindow, signal }) {
  // ⚠️ 必须用调用方传来的 contextWindow（= 本次请求所用 profile 的窗口），不能读全局
  // state.settings.contextWindow —— 那是「当前激活 profile」的窗口，多模型配置下两者不同 →
  // 折叠用对了窗口、压缩用错了窗口，阈值失配。
  const windowTokens = getModelContextWindow(model, contextWindow)
  const triggerBudget = Math.floor(windowTokens * CONTEXT_BUDGET_FACTOR)
  const recentBudget = Math.floor(windowTokens * RECENT_BUDGET_FACTOR)
  const existingSummary = readConvSummary(conversationId)
  // 工具定义随每次请求发送，固定占用一部分预算，计入触发判断
  const toolsTokens = estimateTokens(JSON.stringify(TOOLS_DEFINITION))
  const totalTokens =
    estimateTokens(systemContent) + estimateMessagesTokens(messages) + toolsTokens + estimateTokens(existingSummary)

  if (totalTokens <= triggerBudget) return null

  const boundary = findCompactionBoundary(messages, recentBudget)
  if (boundary <= 0) return null   // 历史不够"旧"（或全在最近窗口内），无法压缩

  event.sender.send('chat:status', {
    convId: conversationId,
    type: 'compacting',
    message: '对话历史较长，正在把更早的内容压缩为摘要...',
  })

  const crossed = messages.slice(0, boundary)
  const recent = messages.slice(boundary)
  // 工具活动台账：历史里没有工具调用与结果，只有这份 sidecar 记着「实际做过什么」。
  // 读失败一律退化为空（台账是锦上添花，绝不能影响压缩主流程）。
  const activityText = renderToolActivity(readToolActivity(conversationId))
  let newSummary = null
  try {
    newSummary = await summarizeHistory({
      key: apiKey,
      model,
      oldSummary: existingSummary,
      crossed,
      activityText,
      signal,
      onRetry: (attempt, delayMs, status) => {
        event.sender.send('chat:status', {
          convId: conversationId,
          type: 'retrying',
          message: `摘要生成${status ? `遇到 HTTP ${status}` : '连接失败'}，${Math.round(delayMs / 1000)}s 后重试（第 ${attempt} 次）...`,
        })
      },
    })
  } catch (e) {
    console.error('[compact] 摘要生成失败，走启发式兜底:', e.message)
    newSummary = null
  }
  if (!newSummary) newSummary = heuristicFallbackSummary(existingSummary, crossed)
  // ⚠️ 写盘前必须查 signal：本运行可能已被新请求 abort（chat.js 的 abortRun('superseded')）。
  // 否则这条被中断的运行会走到下一行、把**退化成启发式**的摘要覆盖掉新运行刚写好的好摘要，
  // 且这个退化版本会一直留在 sidecar 里参与后续所有压缩。
  if (signal && signal.aborted) {
    console.log('[compact] 本次压缩已被中止，跳过摘要写盘（避免覆盖更好的版本）')
    return null
  }
  if (newSummary && newSummary !== existingSummary) writeConvSummary(conversationId, newSummary)

  const finalSystem = systemContent + (newSummary ? `\n\n【更早对话摘要】\n${newSummary}` : '')
  return [
    { role: 'system', content: finalSystem },
    ...recent,
  ]
}

module.exports = {
  estimateTokens,
  estimateMessagesTokens,
  getModelContextWindow,
  maybeCompactHistory,
  readConvSummary,
  writeConvSummary,
  deleteConvSummary,
}