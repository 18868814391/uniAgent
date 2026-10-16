// ============================================================
//  tool-activity —— 工具活动台账（上下文压缩的「另一半」）
// ------------------------------------------------------------
//  背景（第三轮评估实测确认的 P1-1）：
//  会话历史在渲染层只以 { role, content } 落盘（工具调用与结果从不进 messages，
//  见 turn-snapshot.js 头部说明）。于是 maybeCompactHistory 拿到的历史里
//  **只有用户问句和 AI 的聊天文本**，AI 实际读过哪些文件、改过哪些文件、跑过什么命令
//  全都不在里面 —— 压缩成摘要之后，模型完全不知道代码已经改到哪一步：
//  它会重复 read_file 已改过的文件、重新分析已得出的结论，甚至把已完成的改动覆盖掉。
//  压缩省下的 token，远少于「失忆后重来一遍」的代价。
//
//  修法（刻意**不**把工具结果塞进 messages 数组）：
//  另开一条 sidecar 台账，压缩时作为**独立文本段**喂给摘要器。
//  这样 completely 绕开了「切分点把 assistant.tool_calls 与 tool 结果拆散 → 网关 400」
//  的整类风险 —— findCompactionBoundary 的前提（只在 user 处切）因此依然成立。
//
//  生命周期与摘要 sidecar 对齐：userData/conversations/<convId>.activity.json
//  （会话删除时一并清理；会话目录是按文件名显式寻址的，多一个 sidecar 不影响列表）。
// ============================================================
const path = require('path')
const fs = require('fs')
const { app } = require('electron')

// 台账上限：只留最近的 N 条。更早的条目在压缩时已被写进摘要，不必无限留。
const MAX_ENTRIES = 80
// 单条 note / target 的展示上限，防止一条 command 把台账撑爆
const NOTE_MAX = 200
const TARGET_MAX = 160
// 渲染给摘要器的整段上限（摘要请求体本身也要省着用）
const RENDER_MAX_CHARS = 8000

function getActivityPath(convId) {
  return path.join(app.getPath('userData'), 'conversations', `${convId}.activity.json`)
}

function clip(s, max) {
  const str = s == null ? '' : String(s)
  return str.length > max ? str.slice(0, max) + '…' : str
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function firstStringArg(args, keys) {
  for (const k of keys) {
    const v = args && args[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * 把一个工具调用 + 它的结果压成台账的一行。
 * 纯函数，便于单测。字段刻意取得很少：给摘要器看的是「做了什么、对象是谁、成没成」，
 * 细节（diff、完整输出）在摘要里没有价值，反而会把摘要请求撑大。
 *
 * @returns {{tool: string, target: string, ok: boolean, note: string, ts: number}}
 */
function describeToolActivity(name, args, resultText, now = Date.now()) {
  const res = safeJson(resultText)
  // 只有**显式** success:false 才算失败；结果不是 JSON（或不含该字段）时不打失败标记
  const ok = !res || res.success !== false
  const a = args || {}
  let target = ''
  let note = ''

  switch (name) {
    case 'read_file': {
      target = firstStringArg(a, ['path'])
      if (!res || !res.truncated) {
        note = '读取'
      } else if (res.lineTruncated) {
        note = '读取（超长单行被硬截断）'
      } else {
        // 带上「本次拿了几行 / 全文几行」—— 光看“被截断”分不清是撞了单次上限，
        // 还是模型自己传了 offset/limit 的分段读（2026-10-04 排查真实事故时踩过这个坑）。
        note = `读取 ${res.limit || '?'}/${res.totalLines || '?'} 行（续读 offset=${res.nextOffset || '?'}）`
      }
      break
    }
    case 'write_file':
      target = firstStringArg(a, ['path'])
      note = res && res.result && res.result.created ? '新建文件' : `写入 ${(res && res.result && res.result.size) || '?'} 字节`
      break
    case 'edit_file':
      target = firstStringArg(a, ['path'])
      note = res && res.result
        ? `替换 ${res.result.replacedCount || 1} 处${res.result.eolAdjusted ? '（行尾差异兜底）' : ''}`
        : '编辑'
      break
    case 'delete_file':
      target = firstStringArg(a, ['path'])
      note = res && res.result && res.result.deleted === false ? '未删除（文件不存在）' : '已删除'
      break
    case 'list_directory':
      target = firstStringArg(a, ['path'])
      note = res && res.result && Array.isArray(res.result.files)
        ? `列出 ${res.result.files.length} 个文件`
        : '列目录'
      break
    case 'grep_code':
      target = firstStringArg(a, ['pattern'])
      note = res && Array.isArray(res.results)
        ? `命中 ${res.results.length} 处${res.incomplete ? '（结果不完整）' : ''}`
        : '检索内容'
      break
    case 'glob_files':
      target = firstStringArg(a, ['pattern'])
      note = res && Array.isArray(res.files) ? `命中 ${res.files.length} 个文件` : '按名检索'
      break
    case 'execute_command': {
      target = firstStringArg(a, ['command'])
      const bits = []
      if (res && res.timedOut) bits.push('超时被中止')
      if (res && typeof res.exitCode === 'number') bits.push(`exitCode=${res.exitCode}`)
      if (res && res.stdoutTruncated) bits.push(`输出已截断（完整见 ${res.stdoutPath || '日志文件'}）`)
      note = bits.join('，') || '执行'
      // 失败时把首行错误带上 —— 这是「试过什么、为什么不成」里最关键的一句
      if (res && res.success === false) {
        const err = String((res.stderr || res.error || '') || '').trim().split('\n')[0]
        if (err) note += `｜${clip(err, 120)}`
      }
      break
    }
    case 'update_todos':
      note = res && typeof res.count === 'number' ? `更新任务清单（${res.count} 项）` : '更新任务清单'
      break
    case 'spawn_sub_agent':
      target = firstStringArg(a, ['task'])
      note = '派发子代理'
      break
    case 'get_sub_agent_results':
      note = res && Array.isArray(res.results) ? `汇总 ${res.results.length} 个子代理结果` : '汇总子代理结果'
      break
    case 'search_web':
      target = firstStringArg(a, ['query'])
      note = '联网搜索'
      break
    case 'read_skill':
    case 'write_skill':
      target = firstStringArg(a, ['name'])
      note = name === 'read_skill' ? '读取技能' : '写入技能'
      break
    case 'read_memory':
    case 'write_memory':
      target = firstStringArg(a, ['name'])
      note = name === 'read_memory' ? '读取记忆' : '写入记忆'
      break
    default:
      // browser_* / erp / 法务 等：取第一个像"目标"的字符串参数，够摘要器定位即可
      target = firstStringArg(a, ['url', 'selector', 'query', 'ref', 'name', 'path'])
      note = ok ? '执行' : '失败'
      break
  }

  if (!ok && !note.includes('失败')) note += '｜失败'
  return {
    tool: name,
    target: clip(target, TARGET_MAX),
    ok,
    note: clip(note, NOTE_MAX),
    ts: now,
  }
}

/** 读台账（失败一律返回空数组：台账是"锦上添花"，绝不能影响压缩主流程）。 */
function readToolActivity(convId) {
  try {
    const p = getActivityPath(convId)
    if (!fs.existsSync(p)) return []
    const data = safeJson(fs.readFileSync(p, 'utf-8'))
    return data && Array.isArray(data.entries) ? data.entries : []
  } catch {
    return []
  }
}

function writeToolActivity(convId, entries) {
  try {
    const p = getActivityPath(convId)
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ updatedAt: Date.now(), entries }, null, 0), 'utf-8')
  } catch (e) {
    console.error('[tool-activity] 保存失败:', e.message)
  }
}

/**
 * 追加一批台账条目（一轮工具循环调一次）。
 * 连续完全相同的条目（同工具/同目标/同说明）只累加计数，避免「反复读同一个文件」
 * 把 80 条上限吃光。超出上限时丢**最早**的（那些通常已被写进摘要）。
 */
function appendToolActivity(convId, entries) {
  if (!convId || !Array.isArray(entries) || entries.length === 0) return
  const all = readToolActivity(convId)
  for (const e of entries) {
    if (!e || !e.tool) continue
    const last = all[all.length - 1]
    if (last && last.tool === e.tool && last.target === e.target && last.note === e.note) {
      last.n = (last.n || 1) + 1
      last.ts = e.ts
      continue
    }
    all.push({ ...e })
  }
  writeToolActivity(convId, all.slice(-MAX_ENTRIES))
}

/** 把台账渲染成给摘要器的紧凑文本（超长时保留**最近**的部分）。 */
function renderToolActivity(entries, maxChars = RENDER_MAX_CHARS) {
  if (!Array.isArray(entries) || entries.length === 0) return ''
  const lines = entries.map((e) => {
    const times = e.n > 1 ? ` ×${e.n}` : ''
    const mark = e.ok ? '' : ' ✗'
    return `- ${e.tool}${e.target ? ` 「${e.target}」` : ''} → ${e.note}${mark}${times}`
  })
  let text = lines.join('\n')
  if (text.length > maxChars) {
    // 从最早的开始丢：最近的活动对"当前走到哪一步"更关键
    let start = 0
    while (start < lines.length && text.length > maxChars) {
      start++
      text = `- （更早的 ${start} 条工具活动已省略）\n` + lines.slice(start).join('\n')
    }
  }
  return text
}

/** 删除台账 sidecar（会话被删除时调用，与 deleteConvSummary 同一位点）。 */
function deleteToolActivity(convId) {
  try {
    const p = getActivityPath(convId)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch (e) {
    console.error('[tool-activity] 清理失败:', e.message)
  }
}

module.exports = {
  MAX_ENTRIES,
  RENDER_MAX_CHARS,
  describeToolActivity,
  readToolActivity,
  writeToolActivity,
  appendToolActivity,
  renderToolActivity,
  deleteToolActivity,
}
