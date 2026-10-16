// ============================================================
//  文本形态工具调用 —— 识别 + 还原
//
//  背景：部分网关/模型（典型如 opencode zen 转发的 mimo 系）**不稳定地**走
//  原生 function calling：同一轮对话里，前几轮正常返回结构化 tool_calls，
//  某一轮却把调用当成正文吐出来，形如：
//
//      <tool_call>
//      <function=list_directory>
//      <parameter=path>C:\work\repo\src\pages\xxx</parameter>
//      </function>
//      </tool_call>
//
//  旧行为：识别到就结束本轮（endReason='text_tool_call'），工具一次都不执行 ——
//  用户看到的是「模型说要干活，然后就没了」，即本轮会话无声结束。
//
//  新行为：把正文里的调用**还原成结构化 tool_calls**，清理正文，交给 chat.js
//  原有的工具循环继续执行（走同一套守卫：execute_command 确认、ask_user 挂起、
//  进度播报）。只有还原失败时才退回旧的“结束本轮”行为。
//
//  支持的写法（都实测/按同类模型归纳）：
//    A) <tool_call><function=NAME><parameter=K>V</parameter></function></tool_call>
//    B) <tool_call>{"name":"NAME","arguments":{...}}</tool_call>
//    C) <function=NAME><parameter=K>V</parameter></function>        （无 tool_call 包裹）
//    D) <antml:invoke name="NAME"><antml:parameter name="K">V</antml:parameter></antml:invoke>
//    E) <parameter name="K">V</parameter>                          （参数带 name= 属性）
//  同一个正文里可能混着多个调用，全部还原。
// ============================================================
const { TOOLS, zodToJsonSchema } = require('./tool-schemas')

// 任一标记出现即认为「正文里疑似写了工具调用」。
// 注意 <function= 与 <function name= 都要覆盖（不同模型的写法不一致）。
const TEXT_TOOL_CALL_RE =
  /<tool_call>|<\/tool_call>|<function\s*=|<\/function>|antml:invoke|antml:parameter/

function looksLikeTextToolCall(text) {
  if (!text || typeof text !== 'string') return false
  return TEXT_TOOL_CALL_RE.test(text)
}

// ---------------- 参数值类型还原 ----------------
// 正文里所有值都是「字符串」，而工具 schema 可能要 number / boolean / object / array。
// 这里按目标工具的 JSON schema 逐字段决定怎么转：
//   - 期望 number  且字符串是数字 → Number
//   - 期望 boolean 且字符串是 true/false → Boolean
//   - 期望 object/array 且字符串是 JSON → JSON.parse
//   - 其余保持字符串（避免把 "123" 这样的字符串参数、或 C:\ 开头的路径误转）
// 查不到 schema（工具名不存在 / 字段不在 schema 里）时保持字符串，交给 zod 校验报错。
const schemaTypeCache = new Map()
function paramTypesOf(toolName) {
  if (schemaTypeCache.has(toolName)) return schemaTypeCache.get(toolName)
  let types = null
  const tool = TOOLS.find((t) => t.name === toolName)
  if (tool) {
    try {
      const js = zodToJsonSchema(tool.schema)
      if (js && js.properties && typeof js.properties === 'object') {
        types = {}
        for (const [k, v] of Object.entries(js.properties)) {
          if (v && typeof v.type === 'string') types[k] = v.type
        }
      }
    } catch {
      types = null
    }
  }
  schemaTypeCache.set(toolName, types)
  return types
}

function coerceValue(raw, expectedType) {
  const s = typeof raw === 'string' ? raw.trim() : raw
  if (typeof s !== 'string') return s
  if (s === '') return ''
  switch (expectedType) {
    case 'number': {
      if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
      return s
    }
    case 'integer': {
      if (/^-?\d+$/.test(s)) return Number(s)
      return s
    }
    case 'boolean': {
      if (s === 'true') return true
      if (s === 'false') return false
      return s
    }
    case 'object':
    case 'array': {
      try {
        const v = JSON.parse(s)
        if (v && typeof v === 'object') return v
      } catch {
        /* 不是合法 JSON，原样退回 */
      }
      return s
    }
    default:
      // 期望 string（或字段未知）：保持原样。
      // 唯一例外：整段就是被 JSON 编码过的字符串（模型有时会加引号），解一层。
      if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
        try {
          const v = JSON.parse(s)
          if (typeof v === 'string') return v
        } catch {
          /* ignore */
        }
      }
      return s
  }
}

// ---------------- 片段解析 ----------------

// <function=NAME ...> ... </function>  或  <function name="NAME"> ... </function>
const FUNC_OPEN_RE = /<function\s*(?:=\s*([A-Za-z_][\w.-]*)|name\s*=\s*["']([^"']+)["'])\s*>/i
const FUNC_BLOCK_RE = /<function\s*(?:=\s*([A-Za-z_][\w.-]*)|name\s*=\s*["']([^"']+)["'])\s*>[\s\S]*?<\/function>/gi
// 参数标签四种写法都要吃下：<parameter=path> / <parameter name="path"> / <parameter path>
// / <antml:parameter name="path">
const PARAM_RE =
  /<(?:antml:)?parameter\s*(?:=\s*|name\s*=\s*)?(?:"([^"]+)"|'([^']+)'|([\w.-]+))\s*>([\s\S]*?)<\/(?:antml:)?parameter>/gi

function parseParams(body, toolName) {
  const types = paramTypesOf(toolName)
  const args = {}
  let m
  PARAM_RE.lastIndex = 0
  while ((m = PARAM_RE.exec(body)) !== null) {
    const key = m[1] || m[2] || m[3]
    if (!key) continue
    args[key] = coerceValue(m[4], types ? types[key] : undefined)
  }
  return args
}

// 从 <tool_call> 内层解析（可能是 <function=…>、antml:invoke、或裸 JSON）
function parseInner(inner, out) {
  const text = String(inner || '').trim()
  if (!text) return

  // B) 裸 JSON：{"name":"x","arguments":{...}} / {"tool":"x","parameters":{...}}
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text)
      const name = obj.name || obj.tool || (obj.function && obj.function.name)
      let args = obj.arguments ?? obj.parameters ?? (obj.function && obj.function.arguments) ?? obj.args
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          args = {}
        }
      }
      if (name && args && typeof args === 'object') {
        out.push({ name: String(name), args })
        return
      }
    } catch {
      /* 不是合法 JSON，继续按标签解析 */
    }
  }

  // A/E) <function=…> 块（可能多个）
  let found = false
  FUNC_BLOCK_RE.lastIndex = 0
  let fm
  while ((fm = FUNC_BLOCK_RE.exec(text)) !== null) {
    const name = fm[1] || fm[2]
    if (!name) continue
    const body = fm[0].replace(FUNC_OPEN_RE, '').replace(/<\/function>\s*$/i, '')
    out.push({ name, args: parseParams(body, name) })
    found = true
  }
  if (found) return

  // D) antml:invoke / antml:parameter
  const invRe = /<antml:invoke\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/antml:invoke>/gi
  let im
  while ((im = invRe.exec(text)) !== null) {
    out.push({ name: im[1], args: parseParams(im[2], im[1]) })
    found = true
  }
  if (found) return

  // 兜底：整段没有 </function> 闭合（比如被 max_tokens 截断），尝试从开标签起手工切参数。
  // 只解析出「已经完整闭合的参数」，剩下的一律丢弃 —— 半截参数比不执行更危险。
  const openOnly = text.match(FUNC_OPEN_RE)
  if (openOnly && openOnly.index !== undefined) {
    const name = openOnly[1] || openOnly[2]
    if (name) {
      const rest = text.slice(openOnly.index + openOnly[0].length)
      const args = parseParams(rest, name)
      if (Object.keys(args).length > 0) out.push({ name, args })
    }
  }
}

/**
 * 把正文里的文本形态工具调用还原成结构化调用。
 * @returns {{calls: Array<{name:string,args:object}>, cleaned: string}}
 *          calls 为空表示未识别到可执行的调用（调用方退回旧的“结束本轮”行为）
 */
function parseTextToolCalls(text) {
  if (!looksLikeTextToolCall(text)) return { calls: [], cleaned: text }

  const calls = []
  let work = String(text)

  // ① <tool_call>…</tool_call> 块
  work = work.replace(/<tool_call>([\s\S]*?)<\/tool_call>/gi, (_m, inner) => {
    parseInner(inner, calls)
    return ''
  })

  // ② 裸露的 <function=…>…</function>（有些模型不套 tool_call 外壳）。
  //    ① 已经把 tool_call 块整段删掉，所以这里剩下的函数块必然是裸露的，直接解析。
  work = work.replace(FUNC_BLOCK_RE, (m) => {
    parseInner(m, calls)
    return ''
  })

  // ③ 裸露的 antml:invoke
  work = work.replace(/<antml:invoke\s+name\s*=\s*["'][^"']+["']\s*>[\s\S]*?<\/antml:invoke>/gi, (m) => {
    parseInner(m, calls)
    return ''
  })

  // ④ 收尾：去掉残留的孤立标记（如只有开标签的 `<tool_call>`），压缩多余空行
  work = work
    .replace(/<\/?(?:tool_call|function|parameter|antml:invoke|antml:parameter)\b[^>]*>/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // 去重：同一 (name, args) 只保留一次（模型偶尔把同一个调用写两遍）
  const seen = new Set()
  const uniq = []
  for (const c of calls) {
    if (!c || !c.name) continue
    const key = c.name + '|' + JSON.stringify(c.args || {})
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(c)
  }

  return { calls: uniq, cleaned: work }
}

module.exports = { looksLikeTextToolCall, parseTextToolCalls, TEXT_TOOL_CALL_RE }
