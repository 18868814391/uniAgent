// ============================================================
//  收口闸门 —— 模型给出"最终回答"时，核对它到底干完了没有（2026-10-18）
//
//  【事故】真实会话 mvb0y3nlk4ru（Unity 3D 素材接线，deepseek-v4.1-flash）：
//  39 次工具调用、时间线 21:29→21:35，其中 **write_file / edit_file 一次都没有落到工程目录**；
//  然后模型在 21:38 输出一条 4600 字的"完工报告"，声称新增了 ModelLib.cs / ModelBounds.cs、
//  改了 SpriteLib / ModelFactory / PlayerWeapon，正文最后还问「要我接着把编译自检跑掉吗？
//  这是我下一步唯一还欠的验证」。
//  磁盘实况：那两个 .cs 根本不存在，其余三个文件的 mtime 都停在本轮开始之前。
//  而 UI 的任务清单是 1/8（模型自己 21:34 提交的最后一份），**清单是对的、正文是错的**。
//
//  为什么内核会放行：工具循环唯一的常规出口就是「finish_reason=stop 且没有 tool_calls」，
//  见 chat.js 的 `if (toolCalls.length === 0) break`。这条路径此前不检查任何状态 ——
//  于是 endReason 记成 complete，右下角通知还弹「任务完成」。task-notify 与渲染层都跟着说谎。
//
//  本模块只做**纯决策**（不 require electron、不 require 项目内其它模块），副作用全在 chat.js：
//    · decideFinalGate —— 这一次"最终回答"要不要拒收、以及拒收时说什么
//    · buildEndDetail  —— 闸门用尽仍没做完时，结束原因里给用户看的明细
//
//  两类核对（都可经 chat.js 的计数器限次，避免把用户锁在循环里）：
//    ① 任务清单还有未完成项      → 2 次机会
//    ② 正文声称改了文件、但本次运行 0 次写盘 → 1 次机会
//  两类同时命中会**合并成一条** user 消息：连续两条 user 部分网关直接 400。
// ============================================================

/** 写盘类工具：只有这三个会真正改动磁盘（execute_command 里的脚本不算，无法可靠识别）。 */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file'])

/** 清单未完成最多回推几次。2 次之后放行（记 unfinished_todos），不再和用户耗 token。 */
const MAX_TODO_GATES = 2
/** 「声称改动但没写盘」最多回推几次。1 次足够 —— 模型要么补写、要么改口。 */
const MAX_CLAIM_GATES = 1

/** 清单里未完成的项（pending / in_progress）。 */
function openTodos(todos) {
  if (!Array.isArray(todos)) return []
  return todos.filter((t) => t && t.status !== 'completed')
}

function isWriteTool(name) {
  return WRITE_TOOLS.has(name)
}

/**
 * 写盘是否成功。规则与 tool-activity.js 保持一致：只有**显式** success:false 才算失败，
 * 结果不是 JSON（纯文本）时按成功算。写失败的调用不能算"改过了" ——
 * 真实事故里模型最容易在"写了但报错"之后把结果说成"已改好"。
 */
function writeSucceeded(resultText) {
  if (typeof resultText !== 'string' || !resultText) return true
  let res = null
  try {
    res = JSON.parse(resultText)
  } catch {
    return true
  }
  return !res || res.success !== false
}

// 「正文在声称改动」的判据。刻意保守：**必须同时**出现「已完成态」的改动说法与文件名后缀，
// 或者出现报告里常用的改动标记 emoji —— 否则「我没有修改任何文件」「把 foo.cs 里的 X 改成 Y」
// 这类如实说明/教学式回答会被误判成虚报，白烧一轮请求。
// ⚠️ 只认完成态（已… / …了 / added / created…），不认裸动词「改」「修改」：
//    用户在问"怎么改"时模型会用指令语气写，那不是声称。
const WRITE_MARK_RE = /[🆕✏️📝]/
const WRITE_VERB_RE = /(已(经)?\s*(新增|新建|创建|修改|改写|重写|替换|删除|删掉|改动|更新)|新增了|新建了|创建了|修改了|改写了|重写了|替换了|删除了|改动了|写好了|改好了|added|created|updated|modified|rewrote|deleted)/i
const FILE_EXT_RE = /[\w-]+\.(cs|js|mjs|cjs|ts|tsx|jsx|vue|py|json|css|scss|html|md|java|kt|go|rs|php|xml|yml|yaml|sh|sql|csproj|prefab)\b/i

function looksLikeWriteClaim(text) {
  if (typeof text !== 'string' || !text) return false
  if (WRITE_MARK_RE.test(text)) return true
  return WRITE_VERB_RE.test(text) && FILE_EXT_RE.test(text)
}

/** 清单未完成的提醒文本。最多列 10 项，避免把长清单整份再抄一遍。 */
function todoGateText(open) {
  const items = open.slice(0, 10).map((t) => `- ${t.status === 'in_progress' ? '[~]' : '[ ]'} ${t.text}`)
  const more = open.length > items.length ? `\n- …另有 ${open.length - items.length} 项未列出` : ''
  return [
    `【收口核对 · 任务清单还有 ${open.length} 项未完成】`,
    '你刚才输出的是「最终回答」，但清单里这些项还没做完：',
    ...items,
    more,
    '先别收尾，二选一：',
    '① 继续调用工具把剩下的项做完 —— 每项**真正做完（含验证）**之后再用 update_todos 标 completed，不要凭"打算做"标完成；',
    '② 如果你判断某项确实做不了或不必做，就在回答里逐项说明原因，并用 update_todos 把它从清单里去掉。',
    '在清单仍有未完成项时直接结束本轮，用户会认为任务完成了 —— 这正是要避免的。',
  ].filter(Boolean).join('\n')
}

const CLAIM_GATE_TEXT = [
  '【收口核对 · 本次运行没有任何写盘调用】',
  '你的回答里描述了文件改动，但本次运行一次 write_file / edit_file / delete_file 都没有成功执行过（0 条写盘记录）。',
  '不要把"计划""打算做"写成"已完成"。请立刻二选一：',
  '① 真的把文件写出来（新建用 write_file、修改用 edit_file），再逐项验证；',
  '② 如实改口：明确说明哪些只是方案、哪些已经落地。',
].join('\n')

/**
 * 决定这一次"最终回答"是否拒收。
 * @param {object} o
 * @param {Array<{text:string,status:string}>} [o.todos] 当前会话的任务清单（chat.js 从 tools/todo 取）
 * @param {number} [o.wroteFiles]  本次运行成功的写盘工具次数
 * @param {string} [o.answerText]  模型这次给出的正文（responseContent，不是跨轮累加的 fullContent）
 * @param {number} [o.gatesPushed] 清单闸门已回推次数
 * @param {number} [o.claimPushed] 写盘核对已回推次数
 * @returns {{text:string, todoGate:boolean, claimGate:boolean, open:Array, openCount:number}}
 */
function decideFinalGate({ todos, wroteFiles = 0, answerText = '', gatesPushed = 0, claimPushed = 0 } = {}) {
  const open = openTodos(todos)
  const todoGate = open.length > 0 && Number(gatesPushed) < MAX_TODO_GATES
  const claimGate =
    Number(claimPushed) < MAX_CLAIM_GATES &&
    Number(wroteFiles) === 0 &&
    looksLikeWriteClaim(answerText)

  const parts = []
  if (todoGate) parts.push(todoGateText(open))
  if (claimGate) parts.push(CLAIM_GATE_TEXT)

  return { text: parts.join('\n\n'), todoGate, claimGate, open, openCount: open.length }
}

/**
 * 闸门用尽仍没做完 → endReason='unfinished_todos' 时给用户的明细。
 * 只点前 3 项 + 总数：这段进 ChatView 的 turn-issue 横幅，太长会把横幅撑成一堵墙。
 */
function buildEndDetail(open) {
  const items = (open || []).map((t) => (t && t.text ? String(t.text) : '')).filter(Boolean)
  if (items.length === 0) return '任务清单还有未完成项，AI 提前结束了本轮。'
  const shown = items.slice(0, 3).join('、')
  const tail = items.length > 3 ? `${shown} 等 ${items.length} 项` : shown
  return `任务清单还有 ${items.length} 项未完成：${tail}。AI 在清单未完成时结束了本轮，可以点「继续」让它接着做。`
}

module.exports = {
  WRITE_TOOLS,
  MAX_TODO_GATES,
  MAX_CLAIM_GATES,
  CLAIM_GATE_TEXT,
  isWriteTool,
  writeSucceeded,
  looksLikeWriteClaim,
  openTodos,
  todoGateText,
  decideFinalGate,
  buildEndDetail,
}
