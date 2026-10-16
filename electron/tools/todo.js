// ============================================================
//  tools/todo —— 结构化任务清单（update_todos 工具）
//
//  背景（对照 opencode 的 tool/todo.ts + prompt/todowrite.txt）：
//  dev 角色的「改码目标 15 轮以内」原先只是**系统提示词里的一段正文** ——
//  不持久、UI 不渲染、模型自己跑几轮之后也看不见。结果是它一边"计划"一边漂移，
//  跑到第 20 轮还没开始 edit_file（见 chat.js 顶部轮次预算那段记录的事故）。
//  本模块把「计划」变成一份模型可读写的结构化清单：
//    · 模型调 update_todos **整表覆盖**；
//    · chat.js 在**每一轮**请求末尾（所有 tool 消息之后）把当前清单追加成一条 user 消息，
//      模型因此每轮都能看到「还剩几项没做」；
//    · 渲染层从 chat:tool 事件里取最后一次 update_todos 的参数渲染成清单。
//
//  ⚠️ 注入必须走「追加新消息」，**不要改 system prompt** —— 改 system 会击穿服务端的
//     前缀缓存（见 chat.js 顶部 LARGE_CONTEXT_THRESHOLD 的实测：折叠中间位置
//     命中率 99.5% → 69.4%）。追加在末尾时，上一轮的整段请求恰好是本轮的前缀，缓存友好。
//
//  ⚠️ 只依赖 ../state（不 require electron、不 require 项目内其它模块），与 tools/guard.js
//     同款 —— 这样才能在纯 node 下单测，也不会卷进 tools/index.js 的循环依赖（技能 §12）。
// ============================================================
const state = require('../state')

// 单次清单最多几条：清单每轮都要重发，防止模型把整个改造方案拆成几十条塞进来
const MAX_TODOS = 20
// 单条文本上限：清单是「给自己看的进度条」，不是任务书
const MAX_TODO_TEXT = 120
// 每个会话最多保留几份清单（防 Map 无限增长，按插入顺序淘汰最旧的）
const MAX_CONV_TODOS = 50

const STATUSES = ['pending', 'in_progress', 'completed']
const STATUS_MARK = { pending: '[ ]', in_progress: '[~]', completed: '[x]' }

/**
 * 清单存储：key = conversationId。
 * getter 里惰性创建 —— 测试里塞进 require.cache 的 state 桩可能只有部分字段，
 * 直接 state.todos.get(...) 会炸。
 */
function todoStore() {
  if (!(state.todos instanceof Map)) state.todos = new Map()
  return state.todos
}

/** 取某会话当前清单（无则空数组）。 */
function getTodos(conversationId) {
  if (!conversationId) return []
  const list = todoStore().get(conversationId)
  return Array.isArray(list) ? list : []
}

/**
 * 归一化 + 校验。返回 { ok:true, todos } 或 { ok:false, error }。
 * 校验失败一律**返回结构化错误**（由 handler 交给模型自纠错），不要 throw ——
 * 与 tools/index.js 的「参数校验失败喂回模型」是同一套口径。
 */
function normalizeTodos(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: 'todos 必须是数组（整表覆盖，不是增量）。' }
  if (raw.length > MAX_TODOS) {
    return { ok: false, error: `任务清单最多 ${MAX_TODOS} 条，当前 ${raw.length} 条。请合并同类项后重试。` }
  }

  const todos = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (!item || typeof item !== 'object') return { ok: false, error: `第 ${i + 1} 项不是对象。` }
    const text = String(item.text == null ? '' : item.text).trim()
    if (!text) return { ok: false, error: `第 ${i + 1} 项缺少 text。` }
    if (text.length > MAX_TODO_TEXT) {
      return { ok: false, error: `第 ${i + 1} 项文本超过 ${MAX_TODO_TEXT} 字符，请压缩成一句话。` }
    }
    const status = item.status == null ? 'pending' : String(item.status)
    if (!STATUSES.includes(status)) {
      return { ok: false, error: `第 ${i + 1} 项的 status 非法（"${status}"），只能是 pending / in_progress / completed。` }
    }
    todos.push({ text, status })
  }

  const doing = todos.filter((t) => t.status === 'in_progress').length
  if (doing > 1) {
    return { ok: false, error: `同时只能有 1 项处于 in_progress，当前有 ${doing} 项。请把其余的改回 pending。` }
  }
  return { ok: true, todos }
}

/**
 * 整表覆盖写入。todos 传空数组 = 清空（之后不再注入）。
 * 返回值 { ok:true, todos, cleared? } 或 { ok:false, error }。
 */
function updateTodos(conversationId, rawTodos) {
  if (!conversationId) return { ok: false, error: '内部错误：缺少会话标识，任务清单无法归属会话。' }
  const norm = normalizeTodos(rawTodos)
  if (!norm.ok) return norm

  const store = todoStore()
  store.delete(conversationId) // 先删再插，让它排到队尾（淘汰最旧那份时按此顺序）
  if (norm.todos.length === 0) return { ok: true, todos: [], cleared: true }

  store.set(conversationId, norm.todos)
  while (store.size > MAX_CONV_TODOS) {
    const oldest = store.keys().next().value
    store.delete(oldest)
  }
  // 返回浅拷贝：存进去的那份归本模块所有，调用方（含单测）改返回值不会污染清单
  return { ok: true, todos: norm.todos.map((t) => ({ ...t })) }
}

/** 清掉某会话的清单（删除会话时调用）。 */
function clearTodos(conversationId) {
  if (conversationId) todoStore().delete(conversationId)
}

/** 清单 → 文本（`[x] 文本`）。空清单返回 ''。 */
function formatTodoList(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return ''
  return todos.map((t) => `${STATUS_MARK[t.status] || '[ ]'} ${t.text}`).join('\n')
}

/**
 * 生成注入用的「任务清单」提醒段（chat.js 每轮追加成一条 user 消息）。
 * 无清单 → 返回 ''，调用方跳过，零开销。
 * 只列未完成项 + 一行统计：已完成的条目每轮重发纯属白占 token。
 */
function renderTodoSection(conversationId) {
  const todos = getTodos(conversationId)
  if (todos.length === 0) return ''

  const done = todos.filter((t) => t.status === 'completed').length
  const doing = todos.find((t) => t.status === 'in_progress')
  const open = todos.filter((t) => t.status !== 'completed')

  return [
    `【任务清单】共 ${todos.length} 项，已完成 ${done} 项${doing ? `，当前进行中：${doing.text}` : ''}。`,
    '未完成项：',
    ...(open.length ? open.map((t) => `- ${STATUS_MARK[t.status]} ${t.text}`) : ['- （无）']),
    '要求：按清单推进，不要跳到清单外的探索性检索；某项**真正做完（含验证）**之后再调 update_todos 标成 completed，' +
      '不要凭"打算做"就标完成；清单需要调整时用 update_todos 整表覆盖。' +
      '全部完成后直接给出最终回答 —— **不要为了"收尾"把清单清空**，它是用户核对结果的进度记录，保留它。',
  ].join('\n')
}

/** update_todos 的工具返回体：让模型看到清单确实被接受（而不是靠猜）。 */
function todoResultText(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return '任务清单已清空。'
  const done = todos.filter((t) => t.status === 'completed').length
  const doing = todos.filter((t) => t.status === 'in_progress').length
  return (
    `任务清单已更新（共 ${todos.length} 项：已完成 ${done}，进行中 ${doing}，待办 ${todos.length - done - doing}）。` +
    `当前清单：\n${formatTodoList(todos)}`
  )
}

module.exports = {
  getTodos,
  updateTodos,
  clearTodos,
  normalizeTodos,
  renderTodoSection,
  formatTodoList,
  todoResultText,
  MAX_TODOS,
  MAX_TODO_TEXT,
  STATUSES,
}
