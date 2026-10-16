// ============================================================
//  Chat —— 流式对话循环 / 工具循环 / ask_user / 中断
//  拥有:DeepSeek 流式对话 + tool calling 主循环、空闲超时判定、
//  兜底最终答案、ask_user 挂起等待,以及 chat 域的 IPC 注册。
// ============================================================
const { ipcMain, BrowserWindow } = require('electron')
const crypto = require('crypto')
const state = require('./state')
const { TOOLS_DEFINITION } = require('./tool-schemas')
const { fetchWithRetry, describeFetchError } = require('./net-retry')
const settings = require('./settings')
const context = require('./context')
const fsSafe = require('./tools/fs-safe')
const { executeToolCall, killAllChildren } = require('./tools')
const guard = require('./tools/guard')
const todo = require('./tools/todo')
const { abortSubAgentsForConversation } = require('./sub-agent')
const { newRunWorkDir, scheduleCleanup, pruneRootLeftovers } = require('./xl-work')
const orphanCleanup = require('./tools/orphan-cleanup')
const turnSnapshot = require('./turn-snapshot')
// 工具循环的收口策略（无最大步数 · 按进展收口）：纯函数状态机，与子代理共用。
// 阈值/文案/判据都在 electron/tool-loop-policy.js，本文件只负责调用与注入。
const loopPolicy = require('./tool-loop-policy')
// 网络健康：本轮真实失败时上报给右上角状态点（见 noteChatNetworkFailure 的注释）
const netHealth = require('./net-health')
const toolActivity = require('./tool-activity')
// 工具产出图片的侧通道（browser_read_images 抓到的图 → 下一轮 user 消息）。
// 见 electron/tool-images.js 头部：Chat Completions 的 tool 消息只能放字符串，
// 所以图片只能借道 user 消息，且**必须与提醒文本合并成同一条**。
const toolImages = require('./tool-images')
const { looksLikeTextToolCall, parseTextToolCalls } = require('./text-tool-call')
const agentsMd = require('./agents-md')
const taskNotify = require('./task-notify')

const { getActiveProfile, getApiBaseUrl, buildSystemPrompt } = settings
const { estimateTokens, estimateMessagesTokens, getModelContextWindow, maybeCompactHistory } = context
const { buildImageParts, addImagePartsToLatestUser, imageMimeForPath } = fsSafe

// ============================================================
//  工具结果窗口化（黑盒测试提速 · A1）
//  工具循环里每一步的结果（网页快照/页面正文等）都会永久留在 currentMessages 里，
//  而 maybeCompactHistory 只在轮次开头跑一次 —— 于是第 k 步要重发前 k-1 份完整结果，
//  prefill 呈 O(n²) 增长（实测：单份快照 ≈2,500 tokens，20 步累积 ≈5 万 tokens）。
//  这里在每次 push 工具结果后，把**本轮**更早的结果折叠成一行摘要。
//
//  两条硬约束（改这段前先读 tests/turn-resume.test.js）：
//   1. 只能压 content，role:'tool' 与 tool_call_id 必须原样保留 ——
//      缺 tool_call_id 或被改 role，OpenAI 兼容接口会直接 400。
//   2. 折叠只作用于**发给 API 的请求体**。断点续跑快照落盘时用原文还原
//      （见 toolResultOriginals），否则「继续」回放出来的是摘要而不是工具结果。
//
//  2026-09-29 补：**按工具类型分流**。原先所有工具共用一个窗口，导致读源码被误伤——
//  模型读了 4 个文件后，第 1 个的正文已被压成一行摘要，于是「读到的是折叠态，没看全」，
//  只能回来问用户（实测发生于 your-frontend 的 ht-table-page/index.vue，440 行 ≈3.7K tokens，
//  一读就超 FOLD_MIN）。现在分两类，各自独立保留最近 N 条，互不挤占：
//   · 事实原文类（read_file / read_skill / read_memory）：改码要同时对照多份，给大窗口；
//   · 其余（browser_* / search_web / execute_command 输出…）：体积大且可随时重取，
//     维持小窗口 —— 这才是 A1 的初衷（单份网页快照 ≈2,500 tokens）。
// ============================================================
const TOOL_RESULT_WINDOW = 3        // 保留最近 N 条工具结果全文（K 可调）
const TOOL_RESULT_FOLD_MIN = 800    // 短于该长度的结果不折叠：小结果折叠没收益、还白丢信息
// 「事实原文」型工具：返回的是源码/技能/记忆正文，被折叠后模型就没法照着改代码。
// 与上面的默认窗口独立计数 —— 浏览器结果再多也不会挤掉这 8 份原文。
const FACT_TOOL_RESULT_WINDOW = 8
const FACT_TOOLS = new Set(['read_file', 'read_skill', 'read_memory'])
// 视觉类工具（需要"当前模型能收图片"这一前提）。集中一处，避免下发给纯文本模型 → 400。
// 注意 browser_screenshot 不在这里：它本身只是落盘，视觉载荷是"顺手"给的（配置关着也不报错）。
const VISION_TOOL_NAMES = new Set(['read_image', 'browser_read_images'])

// 请求里带了图片、而服务端拒收时的**可执行诊断**。
// 为什么需要：勾了「支持读图」但配的其实是纯文本模型（用户实测就出现过：勾在
// `deepseek-flash` 上），服务端会回一句语焉不详的 400（invalid content type / image_url
// not supported 之类），用户看到的是"AI 突然报错"，完全不知道跟自己勾的那个开关有关。
// 只在「请求体里真的含 image_url part」+「错误文本像是不认图片」时才追加，避免误导。
function visionErrorHint(messages, errText) {
  try {
    const hasImage = (Array.isArray(messages) ? messages : []).some(
      (m) => m && Array.isArray(m.content) && m.content.some((p) => p && p.type === 'image_url'),
    )
    if (!hasImage) return ''
    if (!/image|vision|multimodal|content[_\s-]?type|invalid.*type/i.test(String(errText || ''))) return ''
    return '\n\n[本地提示] 本次请求里带了图片（image_url），而服务端拒绝接收 —— 说明当前模型配置'
      + '虽然勾了「支持读图（多模态）」，但配的模型实际不是多模态模型。'
      + '请到 设置 → 模型配置 改用/切换到真正支持图片的模型（例如 gpt-5.6-luna / mimo 这类），'
      + '或取消勾选「该模型支持读图」后重试。'
  } catch {
    return ''
  }
}

// 上下文窗口够大时，事实原文类**完全不折叠**。
// 起因（2026-09-29 实测聊天记录）：用户用 1M 窗口的模型（日志里是 94.8K/1.0M = 9%），
// 却被 8 条窗口折掉大部分正文 → 模型看到 `[已折叠 · 原 X 字符]` 以为"信息丢了"，
// 于是自己改成「每次只读 15 行」（模型原话：the tool folds large outputs, so I'll go
// ~15 lines at a time），读一条 440 行的 .vue 要 30 次工具调用，并反复重读同一文件 ——
// 49 次工具调用、4509K 累积输入、最后连一行代码都没改。
// 折叠本来是给小窗口模型省 token 的，窗口够大时它就是纯粹的有害行为。
const LARGE_CONTEXT_THRESHOLD = 256 * 1024   // ≥256K 视为"窗口够大"，fact 类不再折叠

/** 按上下文窗口决定事实原文类保留几条：窗口够大 → 不折叠（Infinity）。 */
function factKeepForContext(contextWindow) {
  if (typeof contextWindow === 'number' && contextWindow >= LARGE_CONTEXT_THRESHOLD) return Infinity
  return FACT_TOOL_RESULT_WINDOW
}

// ============================================================
//  「其他类」工具结果的保留窗口同样按上下文窗口自适应（2026-09-30）
//
//  背景：折叠是**就地改写本轮历史里更早的工具结果**，而服务端前缀缓存是「某处一变、
//  从该点往后全部失效」。实测（23.8K 前缀，opencode 网关 / deepseek-v4.1-flash）：
//    不改写 → 命中 99.5%；折叠**中间**位置 → 命中 69.4%；折叠**末尾** → 98.9%。
//  而滑窗被折掉的永远是**本轮最早的那条**（位置最靠前），所以每折一次都会让本轮后面
//  一大截缓存失效。1M 窗口下折叠省下的那点 token，远不抵它带来的重算与计费损失；
//  窗口不大时才保留原来的小窗口（那种情况下 prefill 预算才是真紧的）。
//
//  注意：事实原文类的**同一目标去重**（`[已省略 · 同一目标后面有更新的读取]`）不受这里影响，
//  它只处理"同参数重读"，本身就是幂等且有益的，保留。
// ============================================================
const MID_CONTEXT_THRESHOLD = 128 * 1024      // ≥128K 视为"中等窗口"
const OTHER_TOOL_RESULT_WINDOW_MID = 12       // 中等窗口下"其他类"保留的条数

/** 按上下文窗口决定"其他类"工具结果保留几条：≥256K 不折叠；≥128K 放宽；否则维持 3 条。 */
function otherKeepForContext(contextWindow) {
  if (typeof contextWindow !== 'number') return TOOL_RESULT_WINDOW
  if (contextWindow >= LARGE_CONTEXT_THRESHOLD) return Infinity
  if (contextWindow >= MID_CONTEXT_THRESHOLD) return OTHER_TOOL_RESULT_WINDOW_MID
  return TOOL_RESULT_WINDOW
}

// ============================================================
//  工具循环收口：**没有最大步数**，按进展收口（2026-10-05 重构）
//
//  旧实现是「60 轮硬上限 + 跑满后兜底逼答」，再靠第 40/45/50/55 轮的提醒替上限擦屁股。
//  问题：步数与「有没有干成事」无关 —— 长任务被平白截断，而模型只能抢在提醒点之前收敛。
//
//  现在工具循环是 `for(;;)`，**内核不设最大步数**，只在两种情况下收口：
//   ① **进展停滞**：连续多轮没拿到任何新信息（本轮调用的 (工具名, 参数) 组合以前全都用过，
//      且任务清单也没变化）→ warn（提醒自查）→ wrapup（要求停止工具、立即作答）
//      → stop（跳出循环，交给下方「不带工具的兜底请求」逼出最终回答）；
//   ② **绝对刹车**（ABSOLUTE_STEP_CEILING）：防死循环的保险丝，不是预算，正常任务碰不到。
//  软预算提醒（第 20/35/50… 轮）只报「已用多少轮」请模型自查工作量，**不附带任何上限**。
//
//  判据、文案、状态机都在 electron/tool-loop-policy.js（纯函数，与子代理共用同一套）。
//  本文件只负责：decideRound → 注入提醒 / 跳出循环 / 走兜底。
//  回归测试：tests/tool-loop-policy.test.js + tests/tool-loop-budget.test.js。
// ============================================================
//  （重复调用检测「第 2 次附警告、第 3 次拦下」不变，见下方 trackRepeatCall 段）

// 跑到第几轮工具还没有任务清单 → 提醒一次（见下面 planNudgeText 的注释）。
const PLAN_NUDGE_FROM = 3

/**
 * 「你还没列计划」的就地提醒（2026-10-04 补）。
 * 触发条件：工具循环已跑 PLAN_NUDGE_FROM 轮，且该会话的清单仍为空。
 * 目的：把「多步任务先列计划」这条纪律从系统提示词中间**挪到请求末尾再说一遍** ——
 *      弱模型/转发网关会忽略前者，但对后者（与轮次预算提醒同一位置）反应明显。
 */
function planNudgeText() {
  return '【提醒 · 你还没有列任务清单】你已经连续调用了工具，但还没用 update_todos 列过计划。' +
    '如果这是一件多步任务（读多个文件 / 改多处 / 查多个来源 / 做完要自检），' +
    '请**现在**调一次 update_todos，把完整步骤列成 3~8 条（已完成的标 completed、当前那项标 in_progress），' +
    '之后每真正完成一项就更新一次 —— 用户界面上会显示这份清单，它是你和用户共同核对进度的唯一依据。' +
    '一句话就能做完的琐碎任务请忽略本条。'
}

/**
 * 追踪「同一工具 + 完全相同参数」的连续重复调用。
 * 就地更新传入的状态对象（便于单测注入），返回当前连续重复次数：
 *   0 = 首次（或与上次不同）→ 正常执行
 *   1 = 第 2 次完全相同      → 照常执行，但在结果里附一条警告
 *  ≥2 = 第 3 次及以后       → 调用方应拦下不执行
 * 连续的语义是「跨轮次、紧邻」，中间夹一次不同调用即清零。
 */
function trackRepeatCall(state, name, args) {
  const sig = `${name}\u0000${typeof args === 'string' ? args : JSON.stringify(args ?? null)}`
  if (state && state.lastSig === sig) {
    state.streak = (state.streak || 0) + 1
  } else if (state) {
    state.lastSig = sig
    state.streak = 0
  }
  return state ? state.streak : 0
}

/** 第 2 次重复时附在工具结果后的警告（不改变原结果，仅追加文本）。 */
function repeatWarnText(name) {
  return `\n\n【注意】你刚刚用**完全相同的参数**重复调用了 ${name}。` +
    '同样的输入不会得到不同的结果 —— 若上次结果没满足需求，请改用不同参数（换 path / 调整 offset+limit / 换关键词），或基于已有信息继续推进。'
}

/** 第 3 次及以后：拦下不执行，直接回一段说明。 */
function repeatBlockText(name, streak) {
  return JSON.stringify({
    success: false,
    blocked: true,
    error: `重复调用被拦截：${name} 使用完全相同的参数已连续调用 ${streak + 1} 次。` +
      '相同输入不会产生不同结果 —— 请改用不同参数或其它工具；若信息已经够用，请直接给出最终回答。',
  })
}

/**
 * 事实原文类工具的「同一目标」去重键。
 *
 * 模型有个高频习惯：同一个文件反复读（"最后确认一下"），每次都是几百行全文。
 * 读 N 次就占 N 份 token，还把别的内容挤出窗口 —— 这些副本内容完全一样，全是浪费。
 * 同键的多次读取只该保留最后一次全文。
 *
 * 只有**参数完全相同**的调用才同键：用 offset/limit 分块读的区段内容不同，不能去重；
 * 不同文件当然也不同键。拿不到参数（JSON 解析失败）时返回 null，即不参与去重。
 *
 * ⚠️ 标识字段为空时必须返回 null 而不是拼一个空 key —— 否则模型偶尔发来的空参数
 * （`arguments: '{}'`）会让所有同类调用撞成同一个 key，把不同文件的读取误判成重复而删掉。
 * 宁可不去重，也不能误删。
 */
function factKeyOf(name, rawArgs) {
  let args = rawArgs
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return null
    }
  }
  if (!args || typeof args !== 'object') return null
  const p = args.path || args.file_path || args.filePath || args.file || ''
  if (name === 'read_file') {
    if (!p) return null
    return `read_file\u0000${p}\u0000${args.offset || 0}\u0000${args.limit || 0}`
  }
  if (name === 'read_skill') {
    if (!args.name) return null
    return `read_skill\u0000${args.name}`
  }
  if (name === 'read_memory') {
    const f = args.filename || args.name
    if (!f) return null
    return `read_memory\u0000${f}`
  }
  return null
}

/**
 * 建 tool_call_id → { name, key } 的映射。
 * 工具结果消息（role:'tool'）本身既不带工具名、也不带调用参数，
 * 两者都只出现在 assistant 的 tool_calls 里 —— 折叠时要靠它区分工具类型、判断是否同一目标。
 * 找不到映射的结果按默认窗口处理（保守）。
 */
function mapToolCalls(messages, from = 0) {
  const map = new Map()
  if (!Array.isArray(messages)) return map
  for (let i = Math.max(0, from); i < messages.length; i++) {
    const m = messages[i]
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
    for (const tc of m.tool_calls) {
      const id = tc && tc.id
      const fn = tc && tc.function
      const name = fn && fn.name
      if (id && name) map.set(id, { name, key: factKeyOf(name, fn.arguments) })
    }
  }
  return map
}

/**
 * 就地折叠 [startIndex, end) 区间内的工具结果 content，**按工具类型分两个队列**：
 * 事实原文类保留最近 `factKeep` 条，其余保留最近 `keep` 条，各自独立计数。
 * 纯函数（不依赖闭包状态），便于单测。
 *
 * 事实原文类在按窗口截断**之前**还会先做一次「同一目标去重」：同键的多次读取只留最后一次全文。
 *
 * @param {object} [opts]
 * @param {number} [opts.factKeep]  事实原文类保留条数（默认按 opts.contextWindow 自适应）
 * @param {number} [opts.contextWindow] 当前模型的上下文窗口，够大时 fact 类不折叠
 * @param {Set<string>} [opts.factTools] 事实原文类工具名集合（默认 FACT_TOOLS）
 * @param {Map<string,{name:string,key:string|null}>} [opts.toolCalls] 预建的 id→调用信息 映射
 * @returns {number} 本次实际折叠的条数
 */
function foldOldToolResults(messages, startIndex = 0, keep = TOOL_RESULT_WINDOW, minLen = TOOL_RESULT_FOLD_MIN, opts = {}) {
  if (!Array.isArray(messages)) return 0
  const from = Math.max(0, startIndex)
  const factKeep = Number.isInteger(opts.factKeep) ? opts.factKeep : factKeepForContext(opts.contextWindow)
  const factTools = opts.factTools instanceof Set ? opts.factTools : FACT_TOOLS
  const calls = opts.toolCalls instanceof Map ? opts.toolCalls : mapToolCalls(messages, from)

  const factIdx = []
  const otherIdx = []
  for (let i = from; i < messages.length; i++) {
    const m = messages[i]
    if (!m || m.role !== 'tool' || typeof m.content !== 'string') continue
    const info = calls.get(m.tool_call_id)
    if (info && factTools.has(info.name)) factIdx.push(i)
    else otherIdx.push(i)
  }

  let folded = 0
  // 队列内保留最近 keepN 条：更早的、且够长的压成一行摘要
  const foldQueue = (idx, keepN) => {
    const count = idx.length - Math.max(0, keepN)
    for (let k = 0; k < count; k++) {
      const m = messages[idx[k]]
      // 已折叠过的 content 会短于 minLen，因此天然不会重复折叠
      if (m.content.length < minLen) continue
      const head = m.content.slice(0, 160).replace(/\s+/g, ' ').trim()
      m.content = `[已折叠 · 原 ${m.content.length} 字符] ${head}…（需要完整内容请重新调用该工具）`
      folded++
    }
  }

  // ① 事实原文类先去重：同一目标读了多次 → 只保留最后一次全文，更早的换成一行标记。
  //    比"压成摘要"更彻底 —— 关键是模型不会再看到"原 X 字符"而以为信息丢了、回头重读。
  const lastIdxByKey = new Map()
  for (const i of factIdx) {
    const key = (calls.get(messages[i].tool_call_id) || {}).key
    if (key) lastIdxByKey.set(key, i)
  }
  const survivingFact = []
  for (const i of factIdx) {
    const key = (calls.get(messages[i].tool_call_id) || {}).key
    if (key && lastIdxByKey.get(key) !== i) {
      const m = messages[i]
      if (m.content.length >= minLen) {
        m.content = `[已省略 · 同一目标后面有更新的读取，内容见那次结果]（原 ${m.content.length} 字符）`
        folded++
      }
    } else {
      survivingFact.push(i)
    }
  }

  // ② 两个队列各自按窗口截断（fact 类窗口够大时 keepN = Infinity → 一条都不折）
  foldQueue(otherIdx, keep)
  foldQueue(survivingFact, factKeep)
  return folded
}

/**
 * 把窗口化折叠过的工具结果还原成原文（断点续跑快照落盘用）。
 * 没被折叠过的消息原样返回 —— 只在确实压过时才建新对象。
 */
function restoreToolResults(messages, originals) {
  if (!Array.isArray(messages)) return messages
  if (!originals || typeof originals.has !== 'function' || originals.size === 0) return messages
  let changed = false
  const out = messages.map((m) => {
    if (m && m.role === 'tool' && originals.has(m.tool_call_id)) {
      const original = originals.get(m.tool_call_id)
      if (original !== m.content) {
        changed = true
        return { ...m, content: original }
      }
    }
    return m
  })
  // 一条都没还原时返回原数组：map 无论如何都会新建数组，白复制一遍没用
  return changed ? out : messages
}

/**
 * 从服务端 usage 里取「缓存命中的输入 token」（各家的字段名不一样）：
 *   · OpenAI 兼容 / opencode 网关：usage.prompt_tokens_details.cached_tokens
 *   · DeepSeek 官方：usage.prompt_cache_hit_tokens
 * 两处都取不到就返回 0。
 *
 * 为什么要采集它：DeepSeek 系是**自动前缀缓存**，命中部分按 ~0.1x 计费 —— 这个数字直接反映
 * 「省了多少钱」；而它此前在 cumulativeUsage 里被整段丢弃（只留了 prompt/completion/total），
 * 界面上完全看不见命中情况，也就无从判断某项改动（例如工具结果折叠）有没有把缓存打掉。
 */
function cachedTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return 0
  const a = usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens
  if (typeof a === 'number') return a
  if (typeof usage.prompt_cache_hit_tokens === 'number') return usage.prompt_cache_hit_tokens
  return 0
}

// 思考过程字段的厂商兼容提取：
//  - reasoning_content：DeepSeek R1 等（OpenAI 兼容 reasoner）
//  - reasoning：部分网关/模型（如 opencode.ai 转发的 mimo 系）直接把思考放 string 字段
//  - reasoning_details：OpenAI o 系列风格的数组（元素 { type, text, ... }，type 多为 content/summary）
// 返回 '' 表示该 chunk 无思考内容（普通正文流），上层据此跳过转发。
function extractReasoningText(delta) {
  if (!delta || typeof delta !== 'object') return ''
  if (typeof delta.reasoning_content === 'string') return delta.reasoning_content
  if (typeof delta.reasoning === 'string') return delta.reasoning
  const rd = delta.reasoning_details
  if (Array.isArray(rd)) {
    let out = ''
    for (const it of rd) {
      if (!it || typeof it.text !== 'string') continue
      if (it.type === 'summary') continue // 摘要只是给前端占位用的概述，有 content 正文时跳过避免重复
      out += it.text
    }
    return out
  }
  return ''
}

// 空闲超时（180s 无数据）给用户看的统一文案：主循环收尾、工具循环收尾、catch 三处共用
const IDLE_TIMEOUT_DETAIL =
  '超过 180 秒没有收到 AI 的任何数据，网络连接可能已断开。可点击“继续”接着处理。'

// 文本形态工具调用的识别与还原都在 text-tool-call.js（含多种标签写法解析 + 参数类型还原）。
// 这里只需知道：parsed.calls 非空 = 已还原成可执行的结构化调用，塞进 toolCalls 走原有工具循环；
// 为空 = 还原失败，才退回旧的「结束本轮」行为（endReason='text_tool_call'）。
// 顶部已 require：looksLikeTextToolCall / parseTextToolCalls。

// 一次对话内最多还原几轮文本形态工具调用。模型如果根本不支持 function calling，
// 每轮都会吐文本；上限兜住"修一次跑一次、跑完又吐文本"的死循环。
const MAX_TEXT_TOOL_CALL_REPAIRS = 3

// 断点续跑时注入的说明：告诉模型"上面这些是中断那次真实留下的执行记录"，
// 并点明哪几个工具没跑成。没有这句，模型看到一串没有结果的工具调用，
// 只能靠重跑一遍来确认状态 —— 那正是「继续等于白跑」的根源。
function buildResumeHint(snap, { total = 0, repaired = 0 } = {}) {
  const why =
    snap.abortedBy === 'user'
      ? '用户主动停止了执行'
      : snap.abortedBy === 'idle'
        ? '连接空闲超时（超过 180 秒没有收到数据）'
        : '上一次请求异常结束'
  const lines = [
    '【上一次执行被中断，现在从断点继续】',
    `中断原因：${why}。`,
    '上面这些消息是那次执行真实留下的记录：已经成功完成的步骤、工具调用与工具结果都可以直接采信，不要再重新执行一遍。',
  ]
  if (repaired > 0) {
    lines.push(
      `其中有 ${repaired} 个工具（本轮共调用 ${total} 个）在被中断时没有取得结果，其结果里标记为 interrupted，这些需要你判断是否重新调用。`,
    )
  }
  lines.push('请直接从断点继续完成任务，不要重复已完成的步骤，最后给出完整回答。')
  return lines.join('\n')
}

// 「带补充说明的继续」里，用户那句要求前面的标记。
// ⚠️ 渲染层 `src/stores/app.js` 的 continueTurn() 里有一份同样的字面量（跨进程无法共享），
//    改这里必须同步改那里，否则 extractResumeNote 的兜底解析会失配。
const RESUME_NOTE_MARKER = '【本次补充说明】'

// 「带补充说明的继续」里，取出用户写的那句要求（2026-10-04）。
// 背景：命中续跑快照时，末尾那条 user 消息会被整条替换成 buildResumeHint 的文本，
// 于是用户跟着「继续」一起写的补充说明会被**静默丢弃** —— 模型完全看不到，用户以为提了要求。
// 优先用渲染层显式传来的 resumeNote（权威）；拿不到时退回解析正文里 `【本次补充说明】`
// 之后的内容，防的是「渲染层/主进程版本错配」这类情况下补充说明被整段丢掉。
function extractResumeNote(messages, resumeNote) {
  const explicit = typeof resumeNote === 'string' ? resumeNote.trim() : ''
  if (explicit) return explicit
  const last = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null
  const text = last && last.role === 'user' && typeof last.content === 'string' ? last.content : ''
  const at = text.indexOf(RESUME_NOTE_MARKER)
  return at >= 0 ? text.slice(at + RESUME_NOTE_MARKER.length).trim() : ''
}

// ============================================================
//  ask_user —— 工具循环中向用户提问 / 给选择框
//  主进程向渲染层推送 chat:ask 事件，渲染层弹出选择卡片，
//  用户点选 / 输入后经 chat:askUserAnswer 回传，作为工具结果继续循环。
// ============================================================

// 登记一个待回答的问题，返回 Promise；渲染层回答 / 新请求取代 / 中断 / 关窗时 resolve
// 挂起槽挂在对应会话的 chatRuns 槽上，实现多会话各自独立等待
function askUser(sender, conversationId, { question, options = [] }) {
  return new Promise((resolve) => {
    const run = conversationId ? state.chatRuns.get(conversationId) : null
    // 单槽兜底：同一会话上一问题还没回答就发起新问题（正常不会发生）
    if (run && run.pendingAsk) {
      const prev = run.pendingAsk
      run.pendingAsk = null
      prev.resolve(JSON.stringify({ success: false, cancelled: true, error: '上一个问题已被新的问题取代' }))
    }
    const id = ++state.askSeq
    const pending = { id, resolve, sender }
    if (run) run.pendingAsk = pending
    try {
      sender.send('chat:ask', { convId: conversationId, id, question, options })
    } catch (e) {
      if (run && run.pendingAsk === pending) run.pendingAsk = null
      resolve(JSON.stringify({ success: false, error: '渲染层不可用，无法向用户提问' }))
      return
    }
    // 系统通知兜底：ask_user 是**真正的阻塞挂起**——用户不回来点这张卡片，整轮对话就停在这里。
    // 提问卡片只在应用窗口里，用户切走后完全看不见，于是会以为"任务还在跑"而白等。
    // 所以这里不设耗时门槛（提问随时可能来），只要窗口不在前台就提醒。
    notifyAskPending(sender, conversationId, question)
  })
}

// 把「AI 在等你作答」推到屏幕右下角。与收尾通知共用 settings.notifyOnTaskEnd 开关。
// 通知失败绝不能影响提问本身（挂起已经生效了），故整段 try/catch。
function notifyAskPending(sender, conversationId, question) {
  try {
    const win = BrowserWindow.fromWebContents(sender)
    const run = conversationId ? state.chatRuns.get(conversationId) : null
    if (taskNotify.notifyAskUser({
      win,
      question,
      task: run && run.taskLabel,
      enabled: state.settings.notifyOnTaskEnd !== false,
    })) {
      console.log(`[chat] ask-user notification sent (conversation ${conversationId})`)
    }
  } catch (e) {
    console.warn('[chat] ask-user notification failed:', e && e.message)
  }
}

// 与 Abort 竞速：用户点"中断"/关窗/新请求时立即解除挂起，避免工具循环永久等待
function askUserWithAbort(sender, conversationId, question, options, controller) {
  const answerPromise = askUser(sender, conversationId, { question, options })
  if (!controller) return answerPromise
  return new Promise((resolve, reject) => {
    const run = conversationId ? state.chatRuns.get(conversationId) : null
    const onAbort = () => {
      if (run && run.pendingAsk) run.pendingAsk = null
      reject(new DOMException('aborted', 'AbortError'))
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    answerPromise.then(
      (v) => { controller.signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { controller.signal.removeEventListener('abort', onAbort); reject(e) }
    )
  })
}

// 外部（关窗 / 退出 / 新请求）主动解除所有会话的挂起
function resolvePendingAskAsCancelled() {
  for (const run of state.chatRuns.values()) {
    if (run.pendingAsk) {
      const p = run.pendingAsk
      run.pendingAsk = null
      p.resolve(JSON.stringify({ success: false, cancelled: true, error: '提问已取消' }))
    }
  }
}

// ============================================================
//  流式对话 + 工具调用循环
// ============================================================

/**
 *  Call DeepSeek with streaming + tool calling loop
 *  Sends events to renderer via webContents
 */
async function handleChatSend(event, { conversationId, messages, profileId, enableWebSearch, autoExecute, attachedFiles, resumeTurn, resumeNote }) {
  const profile = getActiveProfile(profileId)
  const key = profile.apiKey
  const requestBaseUrl = profile.baseUrl || settings.DEFAULT_BASE_URL
  const requestModel = profile.model || settings.DEFAULT_MODEL_ID
  const requestContextWindow = profile.contextWindow || settings.DEFAULT_CONTEXT_WINDOW
  if (!key) {
    event.sender.send('chat:error', { convId: conversationId, message: 'API Key 未设置，请在设置中配置 API Key' })
    return
  }

  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return

  // 新一轮开始 → 清空上一轮的任务清单（2026-09-30）。
  // 清单按会话存、原本跨轮次保留，于是上个任务做完后那份"已完成"的清单会一直挂在界面上，
  // 而且**每一轮还会被回显给模型** —— 在新任务里它只是噪音：模型会照着一份不属于当前任务的
  // 计划走，用户也在界面底部看到一份过期的清单。
  // 判定只看 resumeTurn：用户**新发一条消息 = 新任务 → 清空**（模型会按提示词重新列清单）；
  // 「继续」（resumeTurn=true）是同一任务的断点续跑，**必须保留**。
  // 渲染层同样会清一次（st.todos），那是为了界面即时消失、不必等这轮请求回来。
  if (!resumeTurn) todo.clearTodos(conversationId)

  // 同理清空「工具产出图片」的待注入队列：它只在一次 run 的生命周期内有效。
  // 上一次 run 被中断时可能留下没来得及注入的图，留着会让新任务莫名其妙多出几张图
  // （而且是要按 token 计费的）。**无条件下清**，不看 resumeTurn ——
  // 续跑回放的是快照里的消息序列，图片本来就不在快照里（见 tool-images.js 头部说明）。
  toolImages.clearImages(conversationId)

  // 当前配置是否支持读图（多模态）。一个 profile 级开关：勾了才下发 browser_read_images、
  // 才把工具抓到的图注入请求。没勾时行为与改动前完全一致（一条图片通道都不多）。
  const visionCapable = profile.vision === true

  const mod = requestModel
  console.log('[chat] enableWebSearch:', enableWebSearch, 'autoExecute:', autoExecute, 'model:', mod)
  // Build system prompt — append hints for enabled features
  // 传入本轮用户消息：项目级上下文（AGENTS.md）靠它提取「用户提到的路径」来推断当前项目。
  // 传 profile：提示词里「你能不能看图」这一段必须按**本次请求用的**配置判定，
  // 而不是 state.settings 里那个「当前激活配置」（多模型配置下两者可能不同步）。
  let systemContent = buildSystemPrompt(state.settings.allowedDirs || [], messages, profile)
  if (enableWebSearch) {
    systemContent += '\n\n【联网搜索已开启】你已获得 search_web 工具！当用户询问天气、新闻、实时信息等需要最新数据的问题时，请使用 search_web 工具搜索互联网获取实时信息。搜索到结果后，基于搜索内容回答用户，并告知用户你已联网搜索。'
  }
  if (autoExecute) {
    systemContent += '\n\n【自动执行已开启】你可以直接使用 execute_command 工具执行命令行操作（运行脚本、安装包、启动服务、文件操作等），无需询问用户。操作前先简要说明你要做什么，然后直接执行。'
  } else {
    systemContent += '\n\n【执行前询问已开启】你有 execute_command 工具可用，但每次执行前系统会弹出确认框询问用户是否批准。当你认为需要执行命令行操作时，先简要说明你要做什么及命令内容，然后调用 execute_command 执行，系统会提示用户确认。'
  }
  // 文本附件仍可由 AI 按需通过 read_file 读取；图片会在请求边界转换为视觉输入。
  if (Array.isArray(attachedFiles) && attachedFiles.some((f) => !imageMimeForPath(f && f.path))) {
    const fileLines = attachedFiles
      .filter((f) => !imageMimeForPath(f && f.path))
      .map(f => `- ${f.path}${f.name && f.path !== f.name ? `（文件名：${f.name}）` : ''}`)
      .join('\n')
    systemContent += `\n\n【用户文本附件】\n用户附加了以下文本文件（路径已授权，可用 read_file 工具读取）：\n${fileLines}\n当用户的问题与这些文件相关时，先使用 read_file 工具读取对应文件内容，再基于内容回答。`
  }
  // 子 Agent 使用指南：教会 AI 何时以及如何拆分子任务
  systemContent += `\n\n【并行子任务 — spawn_sub_agent + get_sub_agent_results】
当你的任务可以明确拆分为 2 个以上相互独立的子任务时，使用 spawn_sub_agent 并行派发，再用 get_sub_agent_results 收取结果。
- 最多 2 个子代理并行
- 每个子代理拥有相同工具能力（文件/搜索/命令行/ERP等），但不能再派生子代理，也不能向用户提问
- 子代理**不继承**你的完整角色约定，只带"本角色仓库根目录 + 检索纪律"；所以任务描述里务必写清具体仓库/模块路径（如 his/your-backend-module、your-frontend/src/pages/order/lossBill），不要派"去大仓库找某接口实现"这类宽泛任务 —— 那样它只会全库乱搜直到超时
- 适合：分别搜索/研究两个独立话题、同时读取多个文件对比分析、分别执行两个独立操作
- 不适合：有严格先后依赖、太简单不值得并行、只需要一次简单工具调用、以及单个子任务本身就需要在大仓库里做宽泛检索
- 使用模式：spawn_sub_agent × 1~2 → get_sub_agent_results → 综合所有结果回答
- 注意：spawn_sub_agent 立即返回任务 ID，get_sub_agent_results 会阻塞等待所有子代理完成（最长 10 分钟），期间你也无法与用户交互 —— 调用前先告诉用户你在等子代理
- 子代理超时或被中止时，结果里会一并带回它中止前已完成的部分成果（可能不完整）。请基于这些线索自己继续推进，不要把同一个子任务原样重新派发一次`
  let fullContent = ''
  let totalToolCalls = 0          // 本轮对话累计工具调用次数
  let lastFinishReason = null     // 上一次 API 响应的 finish_reason
  let hasRealAnswer = false       // 是否已产生"真正的最终回答"（模型以 stop 结束且无工具调用）
  let brokeEarly = false          // 工具循环是否通过 break 结束（false = 触达绝对刹车，属异常长跑）
  let endReason = 'complete'      // 本轮结束原因：complete / timeout / max_iterations / no_answer / error
  let endDetail = ''              // 结束原因的补充说明（用于前端提示用户）
  let askPending = false          // 是否正挂起等待用户回答 ask_user
  let consecutiveAskCount = 0     // 连续 ask_user 次数（防 AI 反复反问）
  let repeatState = { lastSig: '', streak: 0 }  // 重复调用检测状态（见 trackRepeatCall）
  // 本轮对话累计 token 用量（累加每轮工具循环的真实 usage，最终随 chat:done 发送）
  // cached_tokens = 缓存命中的输入 token（服务端自动前缀缓存，命中部分按 ~0.1x 计费）
  const cumulativeUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 }

  // 本请求的取消控制器：点击"中断"或连接空闲超时时，真正中止 fetch 与工具循环
  const controller = new AbortController()
  // startedAt：本轮开始的墙钟时间。收尾时用它剪掉 .xl-work 根下"早于本轮"的散落脚本
  // （mtime >= 本轮开始时间的文件属于本轮或并发会话，不碰）。见 xl-work.pruneRootLeftovers。
  // taskLabel：本轮用户诉求（最后一条 user 消息，已折叠空白+截断）。存进 run 是因为
  // ask_user 的挂起发生在模块级的 askUser() 里、拿不到本函数的 messages 局部变量，
  // 而系统通知需要它来告诉用户「是哪个任务在等你作答」。收尾通知也复用这一份。
  const run = {
    controller,
    stopRequested: false,
    pendingAsk: null,
    startedAt: Date.now(),
    usedShell: false,
    taskLabel: taskNotify.extractTaskText(messages),
  }

  // 本轮"为什么结束"的唯一事实来源：'user'（点中断）/ 'idle'（空闲超时）/ 'superseded'（被新请求取代）。
  // 旧版只靠 run.stopRequested + controller.signal.aborted 反推，导致"空闲超时"与"用户中断"
  // 命中同一收尾分支，也让 4 处 return 只能静默返回、不发任何终态事件。
  let abortedBy = null
  let textToolCallDetected = false   // 本轮正文里出现文本形态工具调用、且**还原失败**（网关不支持原生 function calling）
  let textToolCallRepairs = 0        // 已触发还原的轮次数（上限 MAX_TEXT_TOOL_CALL_REPAIRS）
  let textToolCallRepaired = 0       // 累计还原并真正执行的调用数（收尾时汇报给用户）
  // 工具循环的收口状态（政策模块持有）：见 electron/tool-loop-policy.js
  const loopState = loopPolicy.newState()

  // ---- 断点续跑：本次请求 history 的指纹 + 本轮 currentMessages 的起始下标 ----
  // currentMessages 要等上下文压缩之后才组装，而 endAbortedTurn 可能在压缩期就被调用，
  // 故这里提前声明为 null（避免闭包引用踩 TDZ），落盘时做空值保护。
  const turnInputCount = Array.isArray(messages) ? messages.length : 0
  const turnInputHash = turnSnapshot.hashHistory(messages)
  let currentMessages = null
  let turnStartIndex = 0
  // 工具结果原文（tool_call_id → 原始 content）。A1 的窗口化会把 currentMessages 里
  // 较早的结果压成摘要，但断点续跑快照必须落**原文**，否则「继续」回放出来的是摘要、
  // 模型拿不到真实结果。这里保存一份原文，落盘时还原。
  const toolResultOriginals = new Map()

  // 把"被中断的那一轮"完整落盘（含工具调用与工具结果），供用户点「继续」时回放。
  // complete 收尾时反向清理：正常完成的回合没有可续跑的东西，留着会让下次「继续」误命中。
  const persistTurnSnapshot = (reason, by) => {
    if (!conversationId) return false
    if (reason === 'complete' || reason === 'text_tool_call') {
      turnSnapshot.clearTurnSnapshot(conversationId)
      return false
    }
    if (!currentMessages || turnStartIndex <= 0) return false
    // 被 A1 折叠过的结果先还原成原文再落盘 —— 快照的用途是"回放真实工具结果"，
    // 存摘要会让「继续」的模型看不到实际内容（见 tests/tool-result-window.test.js）。
    const turnMessages = restoreToolResults(currentMessages.slice(turnStartIndex), toolResultOriginals)
    // 只有"本轮真的调过工具"才值得存：纯文本的半截回答，渲染层已经作为 partial 消息落盘了
    const hasToolActivity = turnMessages.some(
      (m) => m.role === 'tool' || (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length),
    )
    if (!hasToolActivity) {
      turnSnapshot.clearTurnSnapshot(conversationId)
      return false
    }
    return turnSnapshot.saveTurnSnapshot(conversationId, {
      messages: turnMessages,
      historyCount: turnInputCount,
      inputHash: turnInputHash,
      abortedBy: by || null,
      endReason: reason,
    })
  }

  // 统一的终态事件出口。刻意做"本运行仍是该会话当前运行"校验：
  // 被新请求取代的旧运行若仍把 done/error 发出去，会串到新回合的监听上（同会话同 convId），
  // 把新回合的 isStreaming 复位、监听清空 —— 所以陈旧运行一律不发事件。
  // resumable：本轮留下了可续跑的快照 → 渲染层据此在"用户主动中断"（不出错误横幅）时
  // 也给一个中性的「继续」入口，否则用户中途停下就再也接不回断点了。
  // 任务结束的系统通知（屏幕右下角，Windows 通知中心横幅）：**正常完成与异常结束都发**，
  // 只有「用户自己点中断」不发（他就在旁边，再弹通知是废话）—— 名单与文案都在 task-notify.js。
  // 为什么必须有这个：用户切去别的应用后，界面停了他看不见；尤其是异常静默结束时，
  // 除了错误横幅（也在那个看不见的窗口里）之外没有任何外部信号。
  // 整段包 try/catch：通知只是锦上添花，绝不能影响对话收尾。
  const notifyRunEnd = (reason) => {
    try {
      if (taskNotify.notifyTaskEnd({
        win,
        reason,
        elapsedMs: Date.now() - run.startedAt,
        task: run.taskLabel,
        enabled: state.settings.notifyOnTaskEnd !== false,
      })) {
        console.log(`[chat] task-end notification sent (reason=${reason}, conversation ${conversationId})`)
      }
    } catch (e) {
      console.warn('[chat] task-end notification failed:', e && e.message)
    }
  }

  const emitDone = (reason, detail, by) => {
    if (state.chatRuns.get(conversationId) !== run) return
    const resumable = persistTurnSnapshot(reason, by)
    event.sender.send('chat:done', {
      convId: conversationId,
      fullContent,
      endReason: reason,
      endDetail: detail || '',
      abortedBy: by || null,
      resumable,
      usage: cumulativeUsage,
      // 本轮一共从正文里还原并真正执行了多少个工具调用（网关间歇性不走原生 function calling）。
      // 渲染层目前不消费，留在事件里便于排查"模型是不是一直在吐文本"。
      textToolCallRepaired,
    })
    notifyRunEnd(reason)
  }
  const emitError = (reason, detail, by) => {
    if (state.chatRuns.get(conversationId) !== run) return
    const resumable = persistTurnSnapshot(reason, by)
    event.sender.send('chat:error', {
      convId: conversationId,
      message: detail,
      endReason: reason,
      abortedBy: by || null,
      resumable,
    })
    notifyRunEnd(reason)
  }
  // 中断类收尾：用户中断 → done('aborted')（只让渲染层复位/落盘，不出横幅）；
  // 空闲超时 → error('timeout')（出"重试 / 继续"横幅）
  const endAbortedTurn = () => {
    const by = abortedBy || (controller.signal.aborted ? 'idle' : 'user')
    if (by === 'idle') {
      // 180s 一个字节都没来：可能是网络卡住，也可能是模型真的想太久，所以只判轻一档
      netHealth.noteChatNetworkFailure({ message: IDLE_TIMEOUT_DETAIL, kind: 'timeout' })
      emitError('timeout', IDLE_TIMEOUT_DETAIL, 'idle')
    }
    else emitDone('aborted', '', by)
  }

  // 中止本运行：登记原因 → abort → 清理子进程 / 子 Agent。
  // 空闲超时同样要 killAllChildren：旧版只有用户点"中断"的 IPC 会杀子进程，
  // 于是超时结束的会话会在后台留下还在跑的 Python 脚本（"界面停了但脚本还在动"）。
  const abortRun = (cause) => {
    if (abortedBy) return
    abortedBy = cause
    if (cause === 'user') run.stopRequested = true
    console.log(`[chat] abort run (${cause}) for conversation ${conversationId}`)
    // 先落快照、再中止：chat:stop 与随后渲染层发来的 chat:canResume 走同一条 IPC 队列，
    // 主进程在这里同步写完文件，问的时候一定看得到 —— 用户主动中断（按约定不出错误横幅）
    // 因此也能拿到一个中性的「继续」入口，否则中途停下就再也接不回断点。
    // 被新请求取代的运行不写：会话运行槽已易主，留着会被下一回合误认成"可续跑"。
    if (cause !== 'superseded') persistTurnSnapshot('aborted', cause)
    try { controller.abort() } catch (e) { /* 已中止 */ }
    killAllChildren()
    abortSubAgentsForConversation(conversationId)
  }
  run.abortRun = abortRun

  // 会话级临时工作目录：当角色提示词声明了 {{EXCEL_WORK_DIR}}（Excel专家等表格角色）时，
  // 为本轮对话建一个 <授权目录>/.xl-work/<runKey>/ 专属目录并替换占位符。AI 的过程脚本与
  // 中间文件只写这里；本轮结束（下方 finally）由 scheduleCleanup 延迟自动删除——不再往
  // 授权目录根部堆积 temp_excel_task.py 之类的脚本，也不依赖 AI 记得删除。
  if (systemContent.includes('{{EXCEL_WORK_DIR}}')) {
    run.workDir = newRunWorkDir(conversationId)
    systemContent = systemContent.replaceAll('{{EXCEL_WORK_DIR}}', run.workDir)
    console.log(`[chat] excel work dir for ${conversationId}: ${run.workDir}`)
  }

  // 同一会话被重复发起（理论上前端已禁用发送，此处兜底）：先中止旧运行，避免同会话双流
  const prevRun = state.chatRuns.get(conversationId)
  if (prevRun) {
    // 走统一中止口登记 'superseded'：旧运行据此不发终态事件，避免串掉新回合的 UI 状态
    if (prevRun.abortRun) {
      prevRun.abortRun('superseded')
    } else {
      prevRun.stopRequested = true
      prevRun.controller.abort()
    }
    if (prevRun.pendingAsk) {
      const p = prevRun.pendingAsk
      prevRun.pendingAsk = null
      p.resolve(JSON.stringify({ success: false, cancelled: true, error: '已开始新的会话请求' }))
    }
  }
  state.chatRuns.set(conversationId, run)

  // ---- 断点续跑：命中上一次中断留下的快照时，直接回放那一轮的真实消息序列 ----
  // 渲染层 history 只带 role/content（工具调用与结果从不落盘），用它重建 =
  // 已跑过的工具全部重跑。快照命中要求 history 与中断那一刻完全一致
  // （只多出末尾的「继续」指令），否则退回普通流程。
  const resumedSnap =
    resumeTurn && conversationId ? turnSnapshot.loadResumableTurn(conversationId, { messages }) : null

  if (resumedSnap) {
    // 回放前先修工具序列：补齐被中断、没拿到结果的 tool_call，
    // 否则服务端会因"assistant.tool_calls 缺少对应 tool 结果"直接 400。
    const repairedSequence = turnSnapshot.repairToolSequence(resumedSnap.messages)
    // 「带补充说明的继续」：回放会把末尾那条 user 消息整条换成下面的续跑提示，于是用户写的
    // 补充说明（`messages` 的最后一条正文）**在快照命中时会被静默丢弃** —— 模型完全看不到，
    // 用户以为提了要求其实没提。所以把正文里的补充说明摘出来，拼进续跑提示同一条消息。
    // ⚠️ 不能另开一条 user 消息：连续两条 user 部分网关直接 400（见上面 reminders 合并的注释）。
    const userNote = extractResumeNote(messages, resumeNote)
    const hint = buildResumeHint(resumedSnap, repairedSequence)
    currentMessages = [
      { role: 'system', content: systemContent },
      ...repairedSequence.messages,
      {
        role: 'user',
        content: userNote
          ? `${hint}\n\n【用户本次补充说明（在断点继续时必须一并满足）】\n${userNote}`
          : hint,
      },
    ]
    turnStartIndex = 1
    const executed = repairedSequence.total - repairedSequence.repaired
    console.log(
      `[chat] 断点续跑：回放 ${repairedSequence.messages.length} 条消息（保留 ${executed} 个工具结果，补 ${repairedSequence.repaired} 条中断占位${userNote ? '，含用户补充说明' : ''}）`,
    )
    event.sender.send('chat:status', {
      convId: conversationId,
      type: 'resumed',
      message: `已接续上一次被中断的执行（${executed} 个工具结果已保留，不会重复执行）...`,
      executed,
      interrupted: repairedSequence.repaired,
    })
  } else {
    // 上下文压缩：超阈值时保留最近几轮完整对话，更早历史压缩成摘要注入 system prompt。
    // 提前注册 run 并传入 controller.signal，让"停止"在压缩期间也能中止摘要请求。
    const compactedMessages = await maybeCompactHistory({
      event,
      conversationId,
      messages,
      apiKey: key,
      model: mod,
      systemContent,
      signal: controller.signal,
      contextWindow: requestContextWindow,
    })
    // 压缩期间被中断：必须发终态事件（不再静默 return），否则渲染层会永远停在"生成中"
    if (abortedBy || run.stopRequested || controller.signal.aborted) {
      endAbortedTurn()
      if (run.workDir) scheduleCleanup(run.workDir)
      if (state.chatRuns.get(conversationId) === run) state.chatRuns.delete(conversationId)
      return
    }
    currentMessages = compactedMessages || [
      { role: 'system', content: systemContent },
      ...messages,
    ]
    // 本轮的起点 = 最后一条 user 消息（渲染层刚推入的那条）；压缩与否都成立
    turnStartIndex = currentMessages.length - 1
  }
  // Ofox/OpenAI 兼容视觉格式：图片作为 user content part 发送，不能作为文件路径或 UTF-8 文本发送。
  try {
    const imageParts = await buildImageParts(messages, attachedFiles)
    currentMessages = addImagePartsToLatestUser(currentMessages, imageParts)
  } catch (err) {
    if (run.workDir) scheduleCleanup(run.workDir)
    if (state.chatRuns.get(conversationId) === run) state.chatRuns.delete(conversationId)
    event.sender.send('chat:error', { convId: conversationId, message: err.message || '图片处理失败' })
    return
  }

  // 上报"上下文占用"给渲染层（本地估算，非真实 tokenizer 结果）：
  // = system 内容 + 本轮消息 + 工具定义，仅反映发送时的请求规模
  const contextTokens = estimateTokens(currentMessages[0].content) + estimateMessagesTokens(currentMessages.slice(1)) + estimateTokens(JSON.stringify(TOOLS_DEFINITION))
  event.sender.send('chat:context', {
    convId: conversationId,
    contextTokens,
    windowTokens: getModelContextWindow(mod, requestContextWindow),
  })

  // 空闲超时：流式接口在 180 秒内没有任何数据 → 判定连接已断开并中止
  // waitingForApiResponse：标记正在等待 API 响应（fetch 已发出，尚未收到第一个 chunk），
  //   此期间不触发空闲超时 —— 工具执行时间和 API 响应等待时间都不应被误判为"空闲"。
  // toolRunning：标记正在执行工具（execute_command 最长可合法跑 300s，由 shell 自带超时兜底），
  //   执行期间同样豁免 —— idle timer 只应守护"API 流是否还活着"，不能把长工具误判为断线。
  const IDLE_TIMEOUT_MS = 180 * 1000
  let lastActivity = Date.now()
  let waitingForApiResponse = false
  let toolRunning = false
  const idleTimer = setInterval(() => {
    if (askPending) return                    // 等待用户回答时不判定空闲
    if (waitingForApiResponse) return         // API 请求进行中，不判定空闲
    if (toolRunning) return                   // 工具执行中，不判定空闲（工具自带超时兜底）
    if (state.subAgentsPending && state.subAgentsPending.get(conversationId)) return  // 子 Agent 运行中
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      if (controller.signal.aborted) return   // 已 abort 过：不再每 5s 重复打日志/重复 abort
      console.log('[chat] idle timeout: no data for ' + IDLE_TIMEOUT_MS + 'ms, aborting')
      abortRun('idle')   // 统一走 abortRun：登记 abortedBy 并强杀遗留子进程
    }
  }, 5000)

  try {
    // Tool calling loop —— **内核没有最大步数**（2026-10-05 重构）。
    // 收口只由两件事触发：① 收口中间件（loopPolicy）判定「进展停滞」；② 绝对刹车
    // ABSOLUTE_STEP_CEILING（防死循环的保险丝，正常任务碰不到，见 tool-loop-policy.js）。
    // 循环的常规退出路径仍是「模型返回不带工具调用的回答」。
    for (let loop = 0; ; loop++) {
      if (loop >= loopPolicy.ABSOLUTE_STEP_CEILING) {
        console.warn(`[chat] 触达绝对刹车 ${loopPolicy.ABSOLUTE_STEP_CEILING} 轮，强制结束工具循环`)
        break
      }
      lastActivity = Date.now()   // 新一轮请求开始前刷新：工具执行时间不计入"空闲"
      // 本轮附加提醒（收口提醒 + 任务清单），**合并成一条消息**推送：
      //  - 收口提醒（loopPolicy.decideRound）：无步数上限，只在「连续多轮没拿到新信息」时
      //    逐级升级（warn 自查 → wrapup 要求作答）；软预算点（20/35/50…）也只报已用轮数。
      //  - 任务清单（update_todos）：把模型自己写的清单在每轮回显一次，它就看得见
      //    「还剩几项没做」，不会跑着跑着漂到清单外的探索性检索上。清单为空则整段跳过。
      // 位置必须在所有 tool 消息之后，符合「assistant(tool_calls) → tool*」的序列约束；
      // 两条分开推会形成连续两条 user 消息，故合并。
      // ⚠️ 本轮**第一轮**时末尾正好是用户刚发的那条 user 消息（或续跑提示）：此时并入该条，
      //    不新开一条 —— 否则会造出连续两条 user 消息（原代码从不在工具消息前插 user，
      //    轮次提醒最早也只在第 40 轮触发，所以这是本机制新引入的风险）。
      //    用「替换数组元素为新对象」而不是就地改 content：currentMessages 里的消息对象与
      //    渲染层传来的 messages 是同一批引用，就地改会污染 turnInputHash 的输入。
      // 追加在**末尾**而非改写 system：上轮整段请求恰好是本周的前缀，前缀缓存友好。
      const reminders = []
      // 收口中间件：无步数上限，只看「有没有进展」。stop = 不再发请求、直接跳出工具循环。
      const decision = loopPolicy.decideRound(loopState, { loop })
      if (decision.action === 'stop') {
        console.log(`[chat] 收口：连续 ${loopState.stall} 轮未取得新信息，停止工具循环（第 ${loop} 轮）`)
        break
      }
      if (decision.text) {
        reminders.push(decision.text)
        console.log(`[chat] 收口提醒（${decision.action}）：第 ${loop} 轮`)
      }
      const todoSection = todo.renderTodoSection(conversationId)
      if (todoSection) {
        reminders.push(todoSection)
      } else if (loop === PLAN_NUDGE_FROM && state.settings.todosEnabled !== false) {
        // 跑了 3 轮工具、清单还是空的 → 就地提醒一次，让模型补列计划。
        // 为什么需要这一条：纪律写在系统提示词的【任务清单】公共段里，但**弱模型 / 转发网关**
        // 会整段忽略它 —— 2026-10-04 实测用户真实会话台账（userData/conversations/<id>.activity.json）
        // 48 次工具调用、update_todos 0 次，于是界面上的任务清单面板始终不出现，
        // 用户反馈「任务清单改没了」。轮次提醒（shouldWarnBudget）之所以有效，正是因为它
        // 在**请求末尾**出现而不是埋在 1.7 万字系统提示词中间，这里沿用同一机制。
        // 只在 loop === PLAN_NUDGE_FROM 那一轮提醒一次，避免变成每轮的噪声。
        reminders.push(planNudgeText())
        console.log(`[chat] 已提醒模型补列任务清单（已跑 ${PLAN_NUDGE_FROM} 轮工具但清单仍为空）`)
      }
      // 工具产出的图片（browser_read_images）在这里并入本条消息。
      // ⚠️ 三条硬约束（改这段前先读 tests/chat-tool-images.test.js）：
      //   ① 必须与 reminders **合并成同一条** user 消息 —— 工具结果之后推一条 user、
      //      紧接着 reminders 再推一条，就是连续两条 user 消息，部分网关直接 400；
      //   ② 图片只能走 user 消息的 content 数组（image_url part），tool 消息装不下；
      //   ③ 数组 content 只活在本次请求的内存里 —— 落续跑快照时图片被丢掉、文字保留
      //      （turn-snapshot.js 的 normalizeTurnMessages），否则 base64 会顶穿快照体积上限。
      const toolImageParts = visionCapable ? toolImages.takeImages(conversationId) : []
      if (!visionCapable) toolImages.clearImages(conversationId)  // 文本形态工具调用绕过下发过滤时，别把图留着
      const imageParts = toolImageParts.map((it) => it.part)
      const imageNote = toolImageParts.length ? toolImages.renderImageNote(toolImageParts) : ''
      if (reminders.length > 0 || imageParts.length > 0) {
        const text = reminders.join('\n\n')
        const lastIdx = currentMessages.length - 1
        const last = currentMessages[lastIdx]
        const isUserText = last && last.role === 'user' && typeof last.content === 'string'
        const isUserArray = last && last.role === 'user' && Array.isArray(last.content)
        if (imageParts.length === 0) {
          // 无图路径：与加图片通道之前逐字节一致（提醒并进用户刚发的那条消息）
          if (isUserText) {
            currentMessages[lastIdx] = { ...last, content: `${last.content}\n\n${text}` }
          } else if (isUserArray) {
            // 用户那条消息本身就是数组 content（自己带了图片附件）→ 把提醒追加到它的
            // text part 上，**不能新开一条 user 消息**：连着两条 user 部分网关直接 400。
            // （旧实现在这里会踩：它的判断是 typeof content === 'string'，数组一律落到 push 分支。）
            const textIdx = last.content.map((p) => p && p.type).lastIndexOf('text')
            const content = [...last.content]
            if (textIdx >= 0) content[textIdx] = { ...content[textIdx], text: `${content[textIdx].text}\n\n${text}` }
            else content.push({ type: 'text', text })
            currentMessages[lastIdx] = { ...last, content }
          } else {
            currentMessages.push({ role: 'user', content: text })
          }
        } else if (isUserArray) {
          // 用户那条消息本身就是数组（自己带了图/附件）→ 往同一条里追加，绝不新开
          currentMessages[lastIdx] = {
            ...last,
            content: [...last.content, { type: 'text', text: [text, imageNote].filter(Boolean).join('\n\n') }, ...imageParts],
          }
        } else if (isUserText) {
          currentMessages[lastIdx] = {
            ...last,
            content: [{ type: 'text', text: [last.content, text, imageNote].filter(Boolean).join('\n\n') }, ...imageParts],
          }
        } else {
          currentMessages.push({
            role: 'user',
            content: [{ type: 'text', text: [text, imageNote].filter(Boolean).join('\n\n') }, ...imageParts],
          })
        }
      }
      // Build tools list based on enabled features
      let availableTools = TOOLS_DEFINITION
      if (!enableWebSearch) {
        availableTools = availableTools.filter(t => t.function.name !== 'search_web')
      }
      // 截图工具默认禁用：AI 无法看图，常规测试里每步截图纯属浪费一次往返。
      // 仅当本轮用户消息明确提到"截图/screenshot"时才开放给模型。
      const wantsScreenshot = messages
        .filter((m) => m.role === 'user')
        .map((m) => String(m.content || ''))
        .some((s) => /截图|screenshot/i.test(s))
      if (!wantsScreenshot) {
        availableTools = availableTools.filter(t => t.function.name !== 'browser_screenshot')
      }
      // 视觉类工具（网页取图 / 本机图片 / 截图回流）：只有当前配置标记了「支持读图」才下发。
      // 不勾时连工具都不给 —— 否则模型会把图片回灌进请求，而服务端对纯文本模型
      // 会直接 400（image_url part 不被接受），表现为"这轮突然报错"。
      // ⚠️ 与 tools/index.js 的 isVisionCapable（执行层兜底）、settings.js 的提示词段三处同源。
      if (!visionCapable) {
        availableTools = availableTools.filter(t => !VISION_TOOL_NAMES.has(t.function.name))
      }
      // 子 Agent 工具：默认启用，可通过 settings.subAgentsEnabled = false 关闭
      if (state.settings.subAgentsEnabled === false) {
        availableTools = availableTools.filter(t => !['spawn_sub_agent', 'get_sub_agent_results'].includes(t.function.name))
      }
      // 任务清单工具：默认全角色启用，可通过 settings.todosEnabled = false 关闭
      // （与 subAgentsEnabled 同款模式：undefined 视为开启，只认显式 false，无 UI 开关）
      // 2026-09-30 起对所有角色下发 —— 多步任务不是开发角色独有的，原先只给 dev 是过度收窄；
      // 使用纪律写在 settings.js 的【任务清单】公共段（全角色生效），不依赖各角色 harness 提示词。
      if (state.settings.todosEnabled === false) {
        availableTools = availableTools.filter(t => t.function.name !== 'update_todos')
      }
      // 开源版：不做工具收窄 —— 默认助手拥有全部工具（含浏览器 / 联网 / 文件格式处理）。
      // 开源版说明：企业版这里还有一段「平台能力收敛」——MES 平台不下发
      // read_file / grep_code / read_file / 确认用户权限 四个企业专属工具。
      // 开源版这些工具与平台概念一并移除，无需过滤。
      // 标记"正在等待 API 响应"，防止工具执行时间和 API 响应等待被误判为空闲超时
      waitingForApiResponse = true
      const response = await fetchWithRetry(`${requestBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'x-opencode-session': conversationId || crypto.randomUUID(),
        },
        body: JSON.stringify({
          model: mod,
          messages: currentMessages,
          tools: availableTools,
          tool_choice: 'auto',
          stream: true,
          stream_options: { include_usage: true },
          // 思考模式恒为开启（不带 thinking 参数 = 用模型默认行为，即推理模型先思考再作答）。
          // 曾经有个「思考」开关会带 thinking:{type:'disabled'} 压掉思考阶段（单轮 −59% 耗时），
          // 但用户会手误关掉而不知情，然后反馈"AI 错误变多" —— 已整体删除，不再提供关闭入口。
          // ⚠️ 不要再往请求体里加 thinking 参数。
        }),
        signal: controller.signal,
      }, {
        // 429/5xx/连接错误 → 指数退避重试；重试前给前端一条可见的状态提示
        onRetry: (attempt, delayMs, status) => {
          event.sender.send('chat:status', {
            convId: conversationId,
            type: 'retrying',
            message: `请求${status ? `遇到 HTTP ${status}` : '连接失败'}，${Math.round(delayMs / 1000)}s 后重试（第 ${attempt} 次）...`,
          })
        },
      })
      waitingForApiResponse = false  // fetch 完成（成功或失败），清除等待标记

      if (!response.ok) {
        const errText = await response.text().catch(() => 'Unknown error')
        throw new Error(`API error ${response.status}: ${errText}${visionErrorHint(currentMessages, errText)}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let toolCalls = []
      let currentToolIndex = -1
      let responseContent = ''
      // 本轮开始时 fullContent 的长度：文本形态工具调用被还原时要用它回退
      // （fullContent 跨轮累加，本轮那段带 XML 的正文必须一并撤掉）
      const turnStartContentLen = fullContent.length
      let streamFinished = false  // 标记流式响应是否已结束
      let lastUsage = null        // 服务端真实用量（OpenAI 兼容 usage chunk）
      let lastReasoningAt = 0     // 思考过程转发节流时间戳
      let reasoningAcc = ''       // 思考过程累积文本（节流发送完整内容，避免截断）

      // Parse SSE stream —— 读到流结束(done)才退出；finish_reason 仅标记本轮内容结束，
      // 仍需继续读取紧随其后的 usage chunk（OpenAI 兼容：usage 在 finish_reason 之后单独返回）。
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        lastActivity = Date.now()   // 收到任何数据都视为连接存活
        waitingForApiResponse = false  // 收到数据，API 响应已到达

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') continue

          try {
            const chunk = JSON.parse(data)
            const delta = chunk.choices?.[0]?.delta
            const finishReason = chunk.choices?.[0]?.finish_reason
            // 捕获服务端真实用量（usage 常与 finish_reason 同块，或在其后单独返回）
            if (chunk.usage) lastUsage = chunk.usage

            if (delta?.content) {
              // 正文开始前先把节流未发完的思考内容刷给前端，否则前端清空 thinking 后这部分就丢了
              if (reasoningAcc) {
                event.sender.send('chat:reasoning', { convId: conversationId, content: reasoningAcc })
                reasoningAcc = ''
              }
              responseContent += delta.content
              fullContent += delta.content
              event.sender.send('chat:chunk', { convId: conversationId, content: delta.content })
            }

            // 转发思考过程（节流 400ms）——让用户能看到模型仍在工作，避免"假死"误判
            const reasoningDelta = extractReasoningText(delta)
            if (reasoningDelta) {
              reasoningAcc += reasoningDelta
              const now = Date.now()
              if (now - lastReasoningAt > 400) {
                event.sender.send('chat:reasoning', { convId: conversationId, content: reasoningAcc })
                lastReasoningAt = now
              }
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index
                if (!toolCalls[idx]) {
                  toolCalls[idx] = {
                    id: tc.id || `call_${idx}`,
                    type: 'function',
                    function: { name: '', arguments: '' },
                  }
                  if (idx > currentToolIndex) currentToolIndex = idx
                }
                if (tc.id) toolCalls[idx].id = tc.id
                if (tc.function?.name) toolCalls[idx].function.name += tc.function.name
                if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments
              }
            }

            if (finishReason === 'stop' || finishReason === 'tool_calls') {
              lastFinishReason = finishReason
              streamFinished = true
              // 不再 break：继续读取后续可能的 usage chunk，读到 done 时由外层 while 自然结束
            }
          } catch (e) {
            // skip parse errors on partial lines
          }
        }
      }

      // 流结束后兜底：把节流期间未发完的思考内容一次性刷给前端
      if (reasoningAcc) {
        event.sender.send('chat:reasoning', { convId: conversationId, content: reasoningAcc })
        reasoningAcc = ''
      }

      // 真实上下文占用回填：用服务端 usage.prompt_tokens 替换发送前的本地估算值。
      // 每轮工具循环结束都刷新一次，最终停在最后一轮（含全部历史+工具结果）的真实输入 token。
      if (lastUsage && typeof lastUsage.prompt_tokens === 'number') {
        event.sender.send('chat:context', {
          convId: conversationId,
          contextTokens: lastUsage.prompt_tokens,
          windowTokens: getModelContextWindow(mod, requestContextWindow),
        })
        // 累加本轮用量到总用量（工具循环可能跑多轮，每轮的 prompt/completion 都要算进去）
        cumulativeUsage.prompt_tokens += lastUsage.prompt_tokens || 0
        cumulativeUsage.completion_tokens += lastUsage.completion_tokens || 0
        cumulativeUsage.total_tokens += lastUsage.total_tokens || 0
        cumulativeUsage.cached_tokens += cachedTokensOf(lastUsage)
      }

      // ---- 文本形态工具调用：先尝试**还原**，还原不了才判失败 ----
      // 网关（典型：opencode zen 转发的 mimo 系）会**间歇性**不走原生 function calling，
      // 把调用当正文吐出来（<tool_call><function=list_directory><parameter=path>…）。
      // 旧行为：识别到就结束本轮 —— 用户看到"模型说要干活，然后就没了"，会话无声结束。
      // 新行为：能还原就还原成结构化调用、塞进 toolCalls，走**原有工具循环**
      // （因此 execute_command 确认、ask_user 挂起、进度播报等守卫一个都不缺），
      // 并把正文里那坨 XML 从已流出的内容中撤回。
      if (toolCalls.length === 0 && looksLikeTextToolCall(responseContent)) {
        const parsed = parseTextToolCalls(responseContent)
        if (parsed.calls.length > 0 && textToolCallRepairs < MAX_TEXT_TOOL_CALL_REPAIRS) {
          textToolCallRepairs++
          textToolCallRepaired += parsed.calls.length
          // 正文的 XML 已经流式推给渲染层了，必须显式撤回，否则界面上会留一大坨标签
          responseContent = parsed.cleaned
          // fullContent 是**跨轮累加**的（chat:done / 落库都读它），只重置 responseContent
          // 是不够的 —— 不撤掉的话，本轮那句"好的，我先加载…<tool_call>…"会一直留在
          // 最终正文与消息历史里，模型下一轮读自己的历史时也会看到这坨 XML。
          // 用本轮开始时的游标回退，再接上清理后的正文。
          fullContent = fullContent.slice(0, turnStartContentLen) + parsed.cleaned
          event.sender.send('chat:content_reset', { convId: conversationId, content: responseContent })
          parsed.calls.forEach((c, i) => {
            toolCalls.push({
              id: `txtcall_${Date.now().toString(36)}_${i}`,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
            })
          })
          const names = parsed.calls.map((c) => c.name).join('、')
          console.warn(`[chat] 已还原 ${parsed.calls.length} 个文本形态工具调用：${names}`)
          // 用 tool_wait 类型：渲染层已有这套显示逻辑（输入框上方一行），
          // 生命周期也对 —— 工具跑完即被清掉，不会一直挂着。
          event.sender.send('chat:status', {
            convId: conversationId,
            type: 'tool_wait',
            repaired: true,
            message: `模型把工具调用写成了正文，已自动还原 ${parsed.calls.length} 个调用（${names}）并继续执行…`,
          })
        } else {
          textToolCallDetected = true
          console.warn(
            parsed.calls.length > 0
              ? `[chat] 文本形态工具调用还原次数已达上限（${MAX_TEXT_TOOL_CALL_REPAIRS}），本轮结束`
              : '[chat] 检测到文本形态工具调用但无法还原（模型未走原生 function calling），本轮不计为最终回答',
          )
          event.sender.send('chat:status', {
            convId: conversationId,
            type: 'text_tool_call',
            message: '模型把工具调用写成了正文（当前网关不支持原生 function calling）…',
          })
        }
      }

      // If there's response content, add assistant message
      // 注意顺序：必须放在上面「还原」之后 —— 还原会把 XML 从正文里抹掉，
      // 这里落库的才是清理过的正文（否则消息历史里会留着一段工具调用 XML）。
      if (responseContent) {
        currentMessages.push({ role: 'assistant', content: responseContent })
      }

      // 判断本轮是否已是"真正的最终回答"：模型以 stop 结束、没有工具调用、有实际内容
      if (lastFinishReason === 'stop' && toolCalls.length === 0 && responseContent.length > 0 && !textToolCallDetected) {
        hasRealAnswer = true
      }

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        brokeEarly = true
        break
      }

      totalToolCalls += toolCalls.length

      // Add assistant message with tool calls
      const assistantMsg = { role: 'assistant', content: responseContent || null }
      assistantMsg.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }))
      // Remove the last assistant message we already pushed if we have tool calls
      // Actually we need to replace it with the one that has tool_calls
      if (responseContent) {
        currentMessages.pop() // remove the plain content one
      }
      currentMessages.push(assistantMsg)

      // Execute each tool call and add results
      // 整段工具执行都豁免 idle 判定：execute_command 里的 Python 脚本可能合法跑几十秒~300s
      // （shell 自带 300s 超时 + 超时杀进程树），idle timer 只负责 API 流存活性。
      // 多工具执行期间（并发组与串行组）一并豁免，避免"并发的那批还没回、串行的还在排队"被误判为空闲。
      toolRunning = true
      // 工具上下文：所有工具统一携带（此前只有 ask_user / 子 Agent 两个分支才传）。
      // grep_code / glob_files 等长耗时工具靠 convId + event.sender 向渲染层播报进度，
      // 让"正在扫大仓库"这件事有可见反馈，而不是看起来像界面卡死。
      const toolCtx = { event, controller, convId: conversationId, profileId }
      // ------------------------------------------------------------
      //  工具执行编排（2026-09-30）：能并发的并发跑，必须串行的按原顺序跑
      //
      //  原实现是纯串行 for-of —— 模型一轮里要读 5 个文件就得排队 5 次
      //  （grep_code 单次 1.6~2.3s，这段墙钟时间与模型无关，纯属白等）。
      //  但有些调用**不能**并发：
      //    · ask_user               —— 会挂起等用户，多个提问卡片同时弹会乱
      //    · spawn/get_sub_agent    —— get 依赖 spawn 先完成登记
      //    · 需要弹原生确认框的命令 —— 多个确认框同时弹同样会乱
      //    · browser_*              —— 操作同一个测试 BrowserWindow，有状态依赖
      //  其余（读文件 / 检索 / 写文件…）一律并发。
      //  ⚠️ execute_command 单独成组、排在最后（见下方三波执行说明）：
      //     它必须在本轮所有写盘之后跑，否则会验证到改动前的旧代码。
      //  结果按 toolCalls 原下标回填，tool 消息顺序与 tool_calls 严格一致。
      // ------------------------------------------------------------
      // 预判阶段只做同步判定，不产生副作用。trackRepeatCall 是顺序敏感的
      //（就地累加"连续重复"计数），所以必须在预判里按原顺序调用。
      const steps = toolCalls.map((tc) => {
        const name = tc.function.name
        const repeatStreak = trackRepeatCall(repeatState, name, tc.function.arguments)
        let parsedArgs = null
        try {
          parsedArgs = JSON.parse(tc.function.arguments || '{}')
        } catch {
          // 参数解析失败（多半是模型吐了半截 JSON）时不走守卫，交给 executeToolCall
          // 返回结构化的参数错误 —— 与旧行为一致。
          parsedArgs = null
        }
        const isSubAgentTool = name === 'spawn_sub_agent' || name === 'get_sub_agent_results'
        // 开发角色的操作守卫（tools/guard.js）判定提前到这里（纯同步、无副作用）：
        //   项目（git 仓库）内的写 / 改 / 删 → 免打扰；
        //   系统级路径、未跟踪文件的删除、高风险命令 → 弹确认框（归入串行）；
        //   毁机级命令 → 直接拒绝（连"确认执行"都不给）。
        const gate = (name !== 'ask_user' && !isSubAgentTool && parsedArgs)
          ? guard.evaluateToolCall(name, parsedArgs)
          : { action: 'allow' }
        // 需要确认的两种情况：
        //   ① 守卫判定的高风险操作（仅开发角色）
        //   ② 用户关掉了"自动执行"——此时每条 execute_command 都要点头
        // 使用 state.settings.autoExecute 而非局部变量，确保用户中途切换开关后立即生效
        const needConfirm = !!parsedArgs && (
          gate.action === 'confirm'
          || (!state.settings.autoExecute && name === 'execute_command')
        )
        const serial = name === 'ask_user'
          || isSubAgentTool
          || needConfirm
          || name.startsWith('browser_')
        return { tc, name, repeatStreak, parsedArgs, gate, needConfirm, serial, result: null }
      })

      // 本轮跑过 shell 命令 → 收尾时顺手清一次「上次运行遗留的孤儿脚本进程」
      // （bash → py.exe → python.exe 整条链，应用异常退出时 execFile 的超时定时器随之消失，
      //   那些脚本会一直跑到占满内存。详见 tools/orphan-cleanup.js 头部）
      if (steps.some((s) => s.name === 'execute_command')) run.usedShell = true

      // 执行前统一播报，让 UI 先看到"执行中"
      for (const s of steps) {
        event.sender.send('chat:tool', {
          convId: conversationId,
          name: s.name,
          args: s.tc.function.arguments,
          result: null,
          status: 'executing',
        })
      }

      // 单个工具的执行（原 for 循环体，改成"返回结果"而不是"写 result 变量"）
      const runOneTool = async (s) => {
        const { tc, name, repeatStreak } = s
        // 重复调用检测：同一 (工具名, 参数) 连续重复 → 第 2 次照常执行但附警告，
        // 第 3 次起直接拦下不执行。相同输入不会产生不同结果，反复执行只是白烧一轮
        // —— 60 轮上限正是这样耗尽的（见文件顶部「轮次预算与重复调用检测」小节）。
        if (repeatStreak >= 2) {
          console.log(`[chat] 重复调用已拦截：${name} 连续第 ${repeatStreak + 1} 次（参数完全相同）`)
          return repeatBlockText(name, repeatStreak)
        }
        try {
          if (name === 'ask_user') {
            // ask_user：连续反问保护 + 挂起等待用户回答（中断时随 Abort 竞速解除）
            consecutiveAskCount++
            if (consecutiveAskCount > settings.MAX_CONSECUTIVE_ASKS) {
              return JSON.stringify({
                success: false,
                error: `已连续反问 ${settings.MAX_CONSECUTIVE_ASKS} 次，请停止反问，基于已有信息直接推进；尚未确认的项统一标记为"待确认"。`,
              })
            }
            askPending = true
            try {
              return await executeToolCall(tc, toolCtx)
            } finally {
              askPending = false
            }
          }
          if (name === 'spawn_sub_agent' || name === 'get_sub_agent_results') {
            // 子 Agent 工具：需要完整上下文（event/controller/convId/profileId），
            // 且 get 依赖 spawn 先完成登记 —— 预判阶段已把它们标为串行。
            return await executeToolCall(tc, toolCtx)
          }
          consecutiveAskCount = 0
          if (s.gate.action === 'block') {
            console.log(`[guard] blocked ${name}: ${s.gate.reason}`)
            return JSON.stringify({
              success: false,
              blocked: true,
              error: `该操作已被应用拦截：${s.gate.reason}。${s.gate.detail || ''}`
                + '请不要重复尝试同类命令；如确需执行，请由用户自己在终端里操作。'
                + '你可以改用范围更小、可逆的做法（例如只清理明确的项目内子目录）。',
            })
          }
          if (!s.needConfirm) {
            return await executeToolCall(tc, toolCtx)
          }
          // 轮不到守卫判定时的兜底文案（关掉自动执行后的普通命令）
          let cmd = ''
          if (name === 'execute_command') {
            cmd = String(s.parsedArgs.command || '').trim()
          }
          const win = BrowserWindow.fromWebContents(event.sender)
          const allowed = await guard.confirmWithDialog(win, {
            reason: s.gate.reason || 'AI 请求执行命令',
            detail: s.gate.detail || (cmd ? `命令：${cmd}` : ''),
          })
          if (allowed) {
            return await executeToolCall(tc, toolCtx)
          }
          return JSON.stringify({
            success: false,
            cancelled: true,
            error: '用户取消了该操作。请换用更安全、范围更小的做法，不要原样重试。',
          })
        } catch (err) {
          return JSON.stringify({ success: false, error: err.message })
        }
      }
      // 先并发跑"无副作用、互不依赖"的那批，再按原顺序跑必须串行的那批 ——
      // 串行组要么会和用户交互（ask_user / 原生确认框），要么有内部先后依赖
      // （子 Agent）或共享状态（browser_* 同一个测试窗口），让它们独占执行。
      //
      // ⚠️ 三波执行，第三波（命令）的顺序是硬约束，不能并回第一波：
      //   模型在一轮里发 `edit_file(A)` + `execute_command("npm test")` 时，
      //   若两者同属并发组，命令完全可能在编辑**落盘之前**跑完 —— 测到的是旧代码，
      //   而 exitCode:0 会被模型当成「我的改动验证通过」。这是最隐蔽的一类错误归因：
      //   工具没错、模型也没报错，只是「验证」这件事本身是假的。
      //   所以 execute_command 一律排到本轮所有写盘（write_file/edit_file/delete_file）之后。
      const isCommand = (s) => s.name === 'execute_command'
      await Promise.all(
        steps.filter((s) => !s.serial && !isCommand(s)).map(async (s) => {
          s.result = await runOneTool(s)
        }),
      )
      for (const s of steps) {
        if (s.serial && !isCommand(s)) s.result = await runOneTool(s)
      }
      await Promise.all(
        steps.filter(isCommand).map(async (s) => {
          s.result = await runOneTool(s)
        }),
      )

      // 结果按 tool_calls 原下标回填。并发执行但顺序必须稳定：tool 消息顺序若与
      // assistant 的 tool_calls 顺序不一致，部分 OpenAI 兼容网关会直接 400。
      let foldedTotal = 0
      for (const s of steps) {
        // 第 2 次完全相同调用：结果后附一条警告（只影响发给 API 的内容；
        // 前端展示与快照还原仍用 result 原文，见下一行的 toolResultOriginals）。
        const toolContent = s.repeatStreak === 1 ? s.result + repeatWarnText(s.name) : s.result
        currentMessages.push({
          role: 'tool',
          tool_call_id: s.tc.id,
          content: toolContent,
        })
        // 先留原文（供续跑快照还原），再把本轮更早的结果窗口化。只压 content，
        // role 与 tool_call_id 保持原样 —— 这是接口不 400 的前提。
        // 传入 contextWindow：窗口够大时事实原文类完全不折叠（1M 窗口下折叠纯属有害，
        // 详见文件顶部 LARGE_CONTEXT_THRESHOLD 的注释）。
        toolResultOriginals.set(s.tc.id, s.result)
        foldedTotal += foldOldToolResults(
          currentMessages,
          turnStartIndex,
          otherKeepForContext(requestContextWindow),   // 其他类：窗口够大时不折（保前缀缓存）
          TOOL_RESULT_FOLD_MIN,
          { contextWindow: requestContextWindow },
        )
        // Notify renderer about completed tool execution
        event.sender.send('chat:tool', {
          convId: conversationId,
          name: s.name,
          args: s.tc.function.arguments,
          result: s.result,
          status: 'done',
        })
      }
      if (foldedTotal > 0) {
        const fk = factKeepForContext(requestContextWindow)
        const ok = otherKeepForContext(requestContextWindow)
        console.log(`[chat] 工具结果窗口化：折叠 ${foldedTotal} 条较早结果（原文类窗口=${fk === Infinity ? '不折叠' : fk}，其他类窗口=${ok === Infinity ? '不折叠' : ok}）`)
      }
      // 工具活动台账：渲染层落盘的 history 只有 { role, content }，工具调用与结果不进 messages，
      // 于是压缩时摘要器只看得见「聊了什么」、看不见「做了什么」—— 长任务一压缩，
      // 模型就会重复读已改过的文件、甚至覆盖已完成的改动。这里把本轮实际执行过的操作
      // 追加进 sidecar（userData/conversations/<id>.activity.json），压缩时作为独立文本段喂给摘要器。
      // 一轮写一次（不是一次调用写一次），且台账读写全部 best-effort，绝不影响工具结果回填。
      try {
        toolActivity.appendToolActivity(
          conversationId,
          steps.map((s) => toolActivity.describeToolActivity(s.name, s.parsedArgs, s.result)),
        )
      } catch (e) {
        console.log('[chat] 记录工具活动台账失败（不影响本轮）:', e.message)
      }
      toolRunning = false

      // 执行期间被中断（含正在跑的工具被 abort）：结果已全部回填，统一走中止收尾
      if (abortedBy || run.stopRequested || controller.signal.aborted) {
        abortSubAgentsForConversation(conversationId)
        endAbortedTurn()
        return
      }

      // 收口中间件：记下本轮产出，更新「连续多少轮没拿到新信息」的计数。
      // 判据只用 (工具名, 参数) 是否首次出现 + 任务清单有没有变 —— 正常的长任务 stall 恒为 0，
      // 只有真在原地打转才会逐级升级到 stop（见 electron/tool-loop-policy.js）。
      // 被重复调用拦下的调用本来就在 seen 里，天然计为「无进展」。
      loopPolicy.noteRound(loopState, {
        calls: steps.map((s) => ({ name: s.name, args: s.tc.function.arguments })),
        todoSignature: todo.renderTodoSection(conversationId),
      })

      lastActivity = Date.now()   // 工具执行完刷新：执行时间不计入"空闲"判定

      // If the finish reason was 'stop' (not tool_calls), we're done
      // Otherwise continue the loop
    }

    // ================================================================
    //  Safety net: 工具循环结束后仍没有"真正的最终回答"（模型被轮次上限
    //  截断、或中途断开、或只输出了思考过程），强制发起一次不含工具的
    //  API 调用，让模型基于已有工具执行结果直接给出回答。
    // ================================================================
    const loopExhausted = !brokeEarly
    if (!hasRealAnswer && (totalToolCalls > 0 || loopExhausted)) {
      lastActivity = Date.now()   // 兜底请求前刷新：兜底耗时不计入"空闲"
      // 通知前端：正在整理答案
      event.sender.send('chat:status', {
        convId: conversationId,
        type: 'generating_answer',
        message: '正在整理最终回答...',
      })

      try {
        const fallbackResponse = await fetchWithRetry(`${getApiBaseUrl()}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
            'x-opencode-session': conversationId || crypto.randomUUID(),
          },
          body: JSON.stringify({
            model: mod,
            messages: [
              ...currentMessages,
              {
                role: 'user',
                content: '根据以上所有搜索结果和工具执行结果，请用中文直接、完整地回答用户最初的问题。不要使用任何工具。',
              },
            ],
            max_tokens: 4096,
          }),
          signal: controller.signal,
        })

        if (fallbackResponse.ok) {
          const data = await fallbackResponse.json()
          const text = data.choices?.[0]?.message?.content || ''
          // 累加兜底请求的 token 用量（非流式，usage 在响应体中）
          if (data.usage) {
            cumulativeUsage.prompt_tokens += data.usage.prompt_tokens || 0
            cumulativeUsage.completion_tokens += data.usage.completion_tokens || 0
            cumulativeUsage.total_tokens += data.usage.total_tokens || 0
            cumulativeUsage.cached_tokens += cachedTokensOf(data.usage)
          }
          if (text) {
            fullContent += text
            // 以较小的块发送给前端，让用户看到"正在输出"的效果
            const chunkSize = 200
            for (let i = 0; i < text.length; i += chunkSize) {
              event.sender.send('chat:chunk', { convId: conversationId, content: text.slice(i, i + chunkSize) })
            }
            currentMessages.push({ role: 'assistant', content: text })
            hasRealAnswer = true
          }
        }
      } catch (e) {
        console.error('[fallback] API error:', e.message)
      }
    }

    // 汇总本轮结束原因，明确告诉前端：正常完成 / 连接超时 / 工具未执行 / 长跑未收口 / 无回答
    if (hasRealAnswer && !textToolCallDetected) {
      endReason = 'complete'
    } else if (abortedBy || controller.signal.aborted) {
      // 用户中断 / 空闲超时 / 被新请求取代：终态事件由 endAbortedTurn 统一发出
      endAbortedTurn()
      return
    } else if (textToolCallDetected) {
      endReason = 'text_tool_call'
      endDetail = '模型把工具调用写成了正文（当前网关/模型未走原生 function calling），本轮工具没有真正执行。可点击“重试”，或在设置里换用支持原生 function calling 的模型。'
    } else if (loopExhausted) {
      // 只有触达绝对刹车（ABSOLUTE_STEP_CEILING）才会走到这里 —— 内核本身没有步数上限，
      // 停滞收口（stop）也走同一分支：兜底请求仍没逼出回答。
      endReason = 'max_iterations'
      endDetail = `AI 连续调用工具超过 ${loopPolicy.ABSOLUTE_STEP_CEILING} 轮（或多次无进展被强制收口），仍未给出最终回答。` +
        '常见原因是模型卡在同一个死循环里（可查看日志里的「重复调用已拦截」与「收口」记录）。' +
        '建议把任务拆小后重发，或点「继续」让它接着做。'
    } else if (totalToolCalls > 0) {
      endReason = 'no_answer'
      endDetail = 'AI 使用了工具，但最终没有生成回答。'
    } else {
      endReason = 'no_answer'
      endDetail = 'AI 本轮没有生成任何内容。'
    }

    emitDone(endReason, endDetail, null)
  } catch (err) {
    // 中断类失败（用户点中断 / 空闲超时 → AbortError）：统一收尾，不再静默返回
    if (abortedBy || controller.signal.aborted) {
      if (abortedBy === 'user') console.log(`[chat] stopped by user (conversation ${conversationId})`)
      endAbortedTurn()
    } else {
      endReason = 'error'
      // 连接层失败（Node 的 fetch 统一抛 `TypeError: fetch failed`）此前没有任何痕迹：
      // 渲染层只拿得到 err.message、主进程也不打日志 —— 事后完全无法复盘「断在哪一层」。
      // 这里把 undici 的真实 cause（code / errno / 地址）一并带进 endDetail 与主进程日志。
      endDetail = describeFetchError(err)
      console.error(`[chat] 本轮请求失败 (conversation ${conversationId}):`, endDetail, (err && err.cause) || '')
      // 这次真实失败直接喂给网络健康模块。必须在这里报，不能只靠它的周期探针：
      // 探针量的是「新建连接 + 一次小请求」，而长连接被掐（`terminated（ECONNRESET）`）
      // 它测不出来 —— 实测内网下小请求平时只要 0.7s、探针判 good，可流式生成一直在断。
      // code 用 err.cause.code 最准（undici 把真实原因放在 cause 里），没有则退回文案匹配。
      netHealth.noteChatNetworkFailure({
        message: endDetail,
        code: (err && err.cause && (err.cause.code || err.cause.errno || err.cause.name)) || '',
        kind: 'error',
      })
      emitError('error', endDetail, null)
    }
  } finally {
    clearInterval(idleTimer)
    // 会话级临时工作目录兜底清理：无论正常 / 报错 / 超时 / 用户中断都执行（延迟删除，
    // 由 xl-work.scheduleCleanup 负责越界防护）。用户"停止"路径已由 chat:stop 杀进程树，
    // 这里补上目录清理，脚本与中间文件不会残留在授权目录。
    if (run.workDir) scheduleCleanup(run.workDir)
    // 兜底 1：AI 有时把过程脚本写到 `.xl-work/` 根而不是本轮 run 子目录 —— 那些文件不属于
    // 任何 run，scheduleCleanup 永远碰不到。剪掉早于本轮开始时间的根下散落文件（阈值保证
    // 不误伤本轮/并发会话刚写的）。见 xl-work.pruneRootLeftovers。
    pruneRootLeftovers(run.startedAt)
    // 兜底 2：本轮跑过 shell → 异步清一次上次运行遗留的孤儿脚本进程（不阻塞收尾，
    // 失败静默）。正常路径下没孤儿，这里只是"用户不重启应用也能被兜住"。
    if (run.usedShell) {
      orphanCleanup.killOrphanScriptProcesses().then((res) => {
        if (res.found > 0) console.log(`[chat] cleaned ${res.found} orphan script process(es) after shell turn`)
      }).catch(() => {})
    }
    // 仅清理本会话的运行槽；若已被新运行替换则不动
    if (state.chatRuns.get(conversationId) === run) state.chatRuns.delete(conversationId)
  }
}

// ============================================================
//  chat 域 IPC
// ============================================================
function registerIpc() {
  // 每个会话独立并发：新请求只中止本会话的旧运行（handleChatSend 内部处理），不影响其他会话
  ipcMain.handle('chat:send', (event, payload) => {
    return handleChatSend(event, payload)
  })

  // 用户点选/输入回答了 ask_user：按会话 + id 回填给挂起的工具循环
  ipcMain.on('chat:askUserAnswer', (_event, payload) => {
    const run = payload && payload.convId ? state.chatRuns.get(payload.convId) : null
    if (!run || !run.pendingAsk) return
    const p = run.pendingAsk
    if (payload.id !== undefined && payload.id !== p.id) return // 丢弃陈旧回答
    run.pendingAsk = null
    if (payload.cancelled) {
      p.resolve(JSON.stringify({ success: false, cancelled: true, error: '用户取消了这次提问' }))
    } else {
      p.resolve(JSON.stringify({
        success: true,
        answer: payload.answer != null ? String(payload.answer) : '',
        optionIndex: payload.optionIndex != null && Number.isInteger(payload.optionIndex) ? payload.optionIndex : -1,
      }))
    }
  })

  // 用户点击"中断"时，真正取消指定会话的流式请求（中止 fetch、终止工具循环）
  ipcMain.on('chat:stop', (_event, conversationId) => {
    const run = state.chatRuns.get(conversationId)
    if (!run) return
    console.log(`[chat] stop requested for conversation ${conversationId}, aborting its request`)
    // 统一走 run.abortRun：登记 abortedBy='user' → abort → 强杀子进程（防止 Python 等脚本在后台继续跑）
    if (run.abortRun) {
      run.abortRun('user')
    } else {
      run.stopRequested = true
      run.controller.abort()
      killAllChildren()
    }
  })

  // 该会话是否留有"可从断点续跑"的快照：用户主动中断后，渲染层据此决定要不要显示
  // 中性的「继续」入口（用户中断按约定不出错误横幅，所以不能复用 turnIssue 那条路）。
  ipcMain.handle('chat:canResume', (_event, conversationId) => {
    if (!conversationId) return false
    return turnSnapshot.hasResumableTurn(conversationId)
  })
}

module.exports = {
  handleChatSend,
  askUser,
  askUserWithAbort,
  resolvePendingAskAsCancelled,
  registerIpc,
  // 工具结果窗口化（A1）：导出纯函数与阈值供 tests/tool-result-window.test.js 直接断言
  foldOldToolResults,
  restoreToolResults,
  TOOL_RESULT_WINDOW,
  TOOL_RESULT_FOLD_MIN,
  FACT_TOOL_RESULT_WINDOW,
  FACT_TOOLS,
  LARGE_CONTEXT_THRESHOLD,
  MID_CONTEXT_THRESHOLD,
  OTHER_TOOL_RESULT_WINDOW_MID,
  factKeepForContext,
  otherKeepForContext,
  factKeyOf,
  mapToolCalls,
  // 缓存命中 token 提取（供测试与前端展示复用）
  cachedTokensOf,
  // 工具循环收口 + 重复调用检测：导出纯函数供测试直接断言。
  // 收口阈值/文案/判据都在 electron/tool-loop-policy.js（无步数上限、按进展收口），
  // 这里只透出一份引用，避免测试再从 chat.js 里抄一份常量。
  loopPolicy,
  PLAN_NUDGE_FROM,
  planNudgeText,
  trackRepeatCall,
  repeatWarnText,
  repeatBlockText,
}