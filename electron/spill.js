// ============================================================
//  spill —— 超大工具结果落盘 + 首尾预览（2026-10-19）
//
//  与「工具结果窗口化折叠」（chat.js 的 foldOldToolResults）的分工：
//    · 折叠 —— 就地压掉本轮更早的结果，省 prefill。代价是内容真的没了：模型只能重跑工具，
//              或者看到 `[已折叠 · 原 X 字符]` 以为信息丢了，改成每次只读 15 行
//              （事故记录见 chat.js 的 LARGE_CONTEXT_THRESHOLD 注释）。
//    · spill —— 单份结果超出内联预算时**原文落盘**，请求里换成
//              「首尾预览 + 落盘路径 + 检索提示」。模型要全文就 read_file / grep_code 自己取，
//              信息一条不丢，也不再用"拆成小段重读"来绕开截断。
//
//  设计取舍（对应 deepseek-harness 的 dsh-spill-policy：挂 tools/post-execute 的策略）：
//    · 落盘失败一律**降级为原文内联** —— 存不下文件，不能把一次成功的工具调用变成报错；
//    · 触发阈值给得很大（默认 300K 字符），它是安全阀不是压缩手段：
//      正常源码 / 页面正文碰不到，只有巨型日志、整目录 dump、超长 JSON 才会落盘，
//      因此不与既有的折叠窗口、前缀缓存调优（见 chat.js 的 MID_CONTEXT_THRESHOLD）打架；
//    · 目录布局 <userData>/spill/session-<sha256(convId) 前 16 位>/<随机>-<安全名>，
//      与 tools/ 的 ai-created 不同，这里是纯缓存，删了只是让模型重跑一次工具。
//      会话删除时由 conversations.js 整目录清理（clearSession）。
//
//  ⚠️ 顶层不 require('electron')：单测在纯 node 下 require 本模块，惰性取 app.getPath。
// ============================================================
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

// 单份结果超过这个字符数才落盘。300K ≈ 75K tokens，远大于任何正常源码/正文，
// 又明显小于 1M 上下文窗口 —— 它拦的是"一次工具调用把窗口吃掉一大半"那种极端情况。
const DEFAULT_MAX_INLINE_CHARS = 300 * 1024
const PREVIEW_HEAD_CHARS = 2000
const PREVIEW_TAIL_CHARS = 1000
// 落盘文件名的可读前缀上限（路径太长的文件在 Windows 上会难处理）
const MAX_NAME_CHARS = 48

function getSpillRoot() {
  if (!global.__localAiSpillRoot) {
    const { app } = require('electron')
    global.__localAiSpillRoot = path.join(app.getPath('userData'), 'spill')
  }
  return global.__localAiSpillRoot
}

// 会话命名空间：幂等 + 不泄漏原始 id（会话 id 会出现在文件名里，但 hash 后不可反推目录归属之外的任何东西）
function sessionSegment(sessionId) {
  const raw = String(sessionId || 'unsaved')
  return 'session-' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

function sessionDir(sessionId) {
  return path.join(getSpillRoot(), sessionSegment(sessionId))
}

// suggestedName 只是命名提示，绝不是路径：一律收窄成单个安全路径段
function safeSegment(name) {
  const base = path.basename(String(name || 'result'))
  const cleaned = base
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_')
    .replace(/\s+/g, '_')
    // 首尾的点 / 下划线 / 空白都去掉：`..` 与 `   ` 这类输入不能变成可用的路径段
    .replace(/^[._\s]+|[._\s]+$/g, '')
    .slice(0, MAX_NAME_CHARS)
    .replace(/^[._\s]+|[._\s]+$/g, '')
  return cleaned || 'result'
}

/** 当前生效的内联预算（字符）。settings.spillMaxInlineChars 可覆盖，null/0 表示关闭 spill。 */
function maxInlineChars() {
  let configured
  try {
    // 惰性 require：state 会反过来 require 一堆模块，测试里也常被桩掉
    configured = require('./state').settings.spillMaxInlineChars
  } catch {
    configured = undefined
  }
  if (configured === 0 || configured === false) return Infinity
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) return configured
  return DEFAULT_MAX_INLINE_CHARS
}

function previewOf(content, headChars = PREVIEW_HEAD_CHARS, tailChars = PREVIEW_TAIL_CHARS) {
  const text = String(content || '')
  if (text.length <= headChars + tailChars) return { head: text, tail: '', elided: 0 }
  return {
    head: text.slice(0, headChars),
    tail: text.slice(text.length - tailChars),
    elided: text.length - headChars - tailChars,
  }
}

/**
 * 把一段文本原样落盘，返回面向模型的定位符与检索提示。
 * 与 harness 的 SpillStore.saveText 同语义：存不下就 reject，由调用方决定怎么降级。
 * @param {object} input
 * @param {string} input.sessionId 会话 id（只作存储命名空间，不是访问控制）
 * @param {string} [input.suggestedName] 命名提示（会收窄成单个安全路径段）
 * @param {string} input.content 完整文本
 * @returns {{locator: string, bytes: number, retrievalHint: string}}
 */
function saveText({ sessionId, suggestedName, content }) {
  const dir = sessionDir(sessionId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}-${safeSegment(suggestedName)}`
  const locator = path.join(dir, name)
  // wx + 0600：文件必须由本次调用新建，且只有当前用户可读（防预置软链把写入引到别处）
  fs.writeFileSync(locator, String(content), { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
  return {
    locator,
    bytes: Buffer.byteLength(String(content), 'utf-8'),
    retrievalHint: `用 read_file 读取 ${locator}（超大文件建议配 offset/limit 分段读）；要定位具体内容用 grep_code 把 path 指到该文件或其所在目录。`,
  }
}

// 替换文本的措辞就是这条机制的全部：必须让模型知道「信息没丢、去哪取、别凭预览猜」。
function renderReplacement({ toolName, content, ref }) {
  const { head, tail, elided } = previewOf(content)
  const lines = [
    `【超大结果已落盘】${toolName} 的结果共 ${content.length} 字符，超过单次内联预算（${maxInlineChars()} 字符），原文已保存到本地文件。`,
    `落盘路径：${ref.locator}`,
    '',
    `【首部预览 · 前 ${head.length} 字符】`,
    head,
    '',
    `…（中间省略 ${elided} 字符）…`,
    '',
    `【尾部预览 · 后 ${tail.length} 字符】`,
    tail,
    '',
    `【取回完整内容】${ref.retrievalHint}`,
    '需要中间的具体内容时就去读文件，不要凭这两段预览推测，也不要为了绕开截断而把同一份材料拆成很多小段反复读。',
  ]
  return lines.join('\n')
}

/**
 * 工具结果进入**请求体之前**的策略：超过预算就落盘并换成预览，否则原样返回 null。
 *
 * 刻意不叫 spill（会把"是否触发"和"落盘"两件事混在一起），也让调用方一眼看出
 * 返回 null 的含义是「保持内联」。
 *
 * @param {object} input
 * @param {string} input.conversationId 会话 id（存储命名空间）
 * @param {string} input.toolName 产出该结果的工具
 * @param {string} [input.callId] 对应的 tool_call id（命名提示用）
 * @param {*} input.content 工具结果原文
 * @returns {string|null} 替换后的文本；null = 保持原文内联
 */
function maybeSpillToolResult({ conversationId, toolName, callId, content }) {
  if (typeof content !== 'string') return null
  const budget = maxInlineChars()
  if (!Number.isFinite(budget)) return null
  if (content.length <= budget) return null
  try {
    const ref = saveText({
      sessionId: conversationId,
      suggestedName: `${toolName || 'tool'}-${callId || ''}.txt`,
      content,
    })
    return renderReplacement({ toolName: toolName || '工具', content, ref })
  } catch (e) {
    // 尽力而为：权限 / ENOSPC / 后端不可用时保留原文内联（不把成功调用变成失败）
    console.warn('[spill] 落盘失败，保留原文内联:', e && e.message)
    return null
  }
}

/** 删除某个会话的全部 spill 文件（会话删除 / 过期清理时调用）。 */
function clearSession(sessionId) {
  if (!sessionId) return false
  try {
    const dir = sessionDir(sessionId)
    if (!fs.existsSync(dir)) return false
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } catch (e) {
    console.warn('[spill] 清理会话落盘目录失败:', e && e.message)
    return false
  }
}

module.exports = {
  DEFAULT_MAX_INLINE_CHARS,
  PREVIEW_HEAD_CHARS,
  PREVIEW_TAIL_CHARS,
  getSpillRoot,
  sessionDir,
  safeSegment,
  maxInlineChars,
  previewOf,
  saveText,
  renderReplacement,
  maybeSpillToolResult,
  clearSession,
}
