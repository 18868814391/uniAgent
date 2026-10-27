// ============================================================
//  tools/index —— 工具 handler 注册表 + 参数校验执行器
//  每个工具 = zod schema(tool-schemas.js) + handler(本文件)。
//  handler 只接收 safeParse 校验后的数据;校验失败不会走到 handler,
//  executeToolCall 会返回带具体字段错误的 JSON 喂回模型让它在自纠错后重试。
//  与 chat 模块是双向依赖(ask_user 需要 chat 的挂起等待),
//  但 ask_user handler 在函数体内才 require('../chat'),避免加载期循环。
// ============================================================
const path = require('path')
const state = require('../state')
const { TOOLS } = require('../tool-schemas')
const fsSafe = require('./fs-safe')
const { listAllSkills, readSkillByName } = require('./skills')
const { executeCommand, killAllChildren } = require('./shell')
const { searchWeb } = require('./network')
const { grepCode, globFiles } = require('./search')
const { searchConversationHistory } = require('../conversations')
const browserTest = require('../browser-test')
const toolImages = require('../tool-images')
const settings = require('../settings')
const agentsMd = require('../agents-md')
const todo = require('./todo')
const subagentPolicy = require('./subagent-policy')
const quickDiag = require('./quick-diag')
const checkpoints = require('../checkpoints')
const { legalNpcSearch } = require('./legal-npc-search')
const { downloadUrl } = require('./download')
const { handleSpawnSubAgent, handleGetSubAgentResults } = require('../sub-agent')

// ============================================================
//  视觉能力（多模态）—— read_image / browser_read_images / browser_screenshot 共用
//  与 chat.js 的下发闸门、settings.js 的提示词段**同源**：都读 profile.vision。
//  这里再判一次是必要的：chat.js 只过滤「下发给模型」的工具列表，而
//  「文本形态工具调用还原」（部分网关不走原生 function calling）能绕过它。
// ============================================================
const VISION_DISABLED_MSG =
  '当前模型配置没有开启「支持读图（多模态）」，图片无法发给你。'
  + '请如实告诉用户：到 设置 → 模型配置 页签勾选「该模型支持读图（多模态）」，'
  + '并确认当前用的是能接收图片的多模态模型，然后重试。'
  + '在你确实能看到图之前，不要用 OCR / 像素坐标 / 猜测的方式假装自己读了图片内容。'

function isVisionCapable(profileId) {
  try {
    const profile = settings.getActiveProfile(profileId)
    return !!profile && profile.vision === true
  } catch {
    return false
  }
}

// path（单张）/ paths（多张）两种传法都接受 —— 弱模型经常只给一个字符串。
// @returns {{ok: true, paths: string[]} | {ok: false, error: string}}
function normalizeImagePaths(singlePath, paths) {
  const raw = []
  if (typeof singlePath === 'string' && singlePath.trim()) raw.push(singlePath.trim())
  if (Array.isArray(paths)) {
    for (const p of paths) if (typeof p === 'string' && p.trim()) raw.push(p.trim())
  }
  const unique = [...new Set(raw)]
  if (unique.length === 0) {
    return { ok: false, error: '缺少图片路径：用 path 传单张绝对路径，或用 paths 传最多 4 张。' }
  }
  if (unique.length > fsSafe.MAX_IMAGES_PER_MESSAGE) {
    return {
      ok: false,
      error: `一次最多 ${fsSafe.MAX_IMAGES_PER_MESSAGE} 张图（收到 ${unique.length} 个不同路径）。请分批调用。`,
    }
  }
  return { ok: true, paths: unique }
}

const TOOL_HANDLERS = {
  read_file: ({ path, offset, limit }) => {
    const result = fsSafe.readFileWithRange(path, offset, limit)
    return typeof result === 'string'
      ? JSON.stringify({ success: true, content: result })
      : JSON.stringify({ success: true, ...result })
  },
  // 本机图片文件 → 视觉载荷（2026-10-05，与 browser_read_images 共用 tool-images 侧通道）。
  // 为什么必须有这个工具：用户/文档里落盘的图（wiki 附件、从 .docx 抽出来的图、自己截的图）
  // 原先**没有任何入口** —— read_file 只会吐乱码，browser_read_images 只认测试窗口当前页面的图。
  // 视觉闸门在这里也要判一次（不能只靠 chat.js 的下发过滤）：文本形态工具调用能绕过下发。
  read_image: ({ path: singlePath, paths }, ctx) => {
    const list = normalizeImagePaths(singlePath, paths)
    if (!list.ok) return JSON.stringify({ success: false, error: list.error })
    if (!isVisionCapable(ctx && ctx.profileId)) {
      return JSON.stringify({ success: false, visionDisabled: true, error: VISION_DISABLED_MSG })
    }
    const items = []
    const failed = []
    for (const p of list.paths) {
      try {
        const part = fsSafe.localImagePart(p)
        if (!part) {
          failed.push({ path: p, reason: '不是受支持的图片格式（仅 .png / .jpg / .jpeg / .webp）' })
          continue
        }
        items.push({ label: `${path.basename(p)} — ${p}`, part })
      } catch (err) {
        failed.push({ path: p, reason: err.message })
      }
    }
    const stash = toolImages.stashImages(ctx && ctx.convId, items)
    const result = {
      delivered: stash.accepted,
      files: list.paths,
      duplicates: stash.duplicates,
      dropped: stash.dropped,
      failed,
    }
    result.note = stash.accepted > 0
      ? `已把 ${stash.accepted} 张图作为图像附在你的下一条消息里 —— 你马上就能直接看到它们。`
        + (failed.length ? `另有 ${failed.length} 张没读成功（见 failed）。` : '')
      : '一张图都没能读出来。'
        + (failed.length ? `原因见 failed；常见原因是路径写错、不在授权目录内、或文件过大（单张上限 10MB）。` : '')
    return JSON.stringify({ success: true, result })
  },
  // 写盘类：写成功后**顺手带上语法/编译诊断**（2026-10-24）。
  // 为什么要挂在这里而不是让模型自己跑：模型判断不了"这个项目该跑什么检查"，
  // 而全项目 typecheck / build 是被明令禁止的（几分钟），模型于是只跑"改动文件的 eslint"，
  // 语法错误一路漏到用户打包时才炸。quick-diag 只跑单文件秒级检查，
  // 有错才附 diagnostics 字段，干净时不加任何字段（省 token）；失败一律静默降级。
  write_file: async ({ path, content }, ctx) => {
    // 覆盖已有文件前要求「本次会话读过 + 读后没被改动过」（P0-5，见 fs-safe 的 readState 段）
    const requireRead = !!(state.settings && state.settings.role === 'dev')
    // 写盘前留检查点（P0-7）：改坏了可以「撤销本轮改动」
    checkpoints.snapshotBeforeWrite(ctx && ctx.convId, ctx && ctx.turnId, path)
    const res = fsSafe.writeFileSafe(path, content, { requireRead })
    return JSON.stringify({ success: true, result: await quickDiag.attachDiagnostics(res, res && res.path ? res.path : path) })
  },
  edit_file: async ({ path, old_string, new_string, replace_all }, ctx) => {
    checkpoints.snapshotBeforeWrite(ctx && ctx.convId, ctx && ctx.turnId, path)
    const res = fsSafe.editFileSafe(path, old_string, new_string, replace_all)
    return JSON.stringify({ success: true, result: await quickDiag.attachDiagnostics(res, res && res.path ? res.path : path) })
  },
  // 检索类工具可能扫几万文件、耗时十几秒：把进度回调透传下去，
  // 渲染层在输入框上方显示「正在检索代码…」，避免"无反馈 = 像卡死"
  grep_code: (args, ctx) => grepCode(args, ctx && ctx.onProgress),
  glob_files: (args, ctx) => globFiles(args, ctx && ctx.onProgress),
  list_directory: ({ path }) => JSON.stringify({ success: true, result: fsSafe.listDirSafe(path) }),
  delete_file: ({ path }, ctx) => {
    // 删除同理：先把原文存进检查点，撤销时能恢复（P0-7）
    checkpoints.snapshotBeforeWrite(ctx && ctx.convId, ctx && ctx.turnId, path)
    return JSON.stringify({ success: true, result: fsSafe.deleteFileSafe(path) })
  },
  // 任务清单：整表覆盖写入当前会话。清单本身由 chat.js 在每轮请求末尾追加回显给模型
  // （见 tools/todo.js 头部）。校验失败返回结构化错误让模型自纠错，而不是 throw。
  // ⚠️ ctx.subAgent 必须硬拒绝：子代理沿用主会话的 convId，放它进来会覆盖主 Agent 的清单
  //    （sub-agent.js 的 BLOCKED_TOOLS 已经不下发这个工具，这里是执行层的第二道）。
  update_todos: ({ todos }, ctx) => {
    if (ctx && ctx.subAgent) {
      return JSON.stringify({ success: false, error: '任务清单由主 Agent 维护，子代理不能使用本工具。' })
    }
    const res = todo.updateTodos(ctx && ctx.convId, todos)
    if (!res.ok) return JSON.stringify({ success: false, error: res.error })
    return JSON.stringify({ success: true, count: res.todos.length, result: todo.todoResultText(res.todos) })
  },
  list_skills: () => JSON.stringify({ success: true, result: listAllSkills() }),
  read_skill: ({ name }) => JSON.stringify({ success: true, ...readSkillByName(name) }),
  write_skill: ({ name, content }) => {
    const filename = name.replace(/\.md$/, '') + '.md'
    return JSON.stringify({ success: true, result: fsSafe.writeFileSafe(path.join(state.settings.skillsDir, filename), content) })
  },
  list_memories: () => {
    settings.ensureDir(state.settings.memoryDir)
    return JSON.stringify({ success: true, result: fsSafe.listDirSafe(state.settings.memoryDir) })
  },
  read_memory: ({ name }) => {
    const filename = name.replace(/\.md$/, '') + '.md'
    return JSON.stringify({ success: true, name: filename, content: fsSafe.readFileSafe(path.join(state.settings.memoryDir, filename)) })
  },
  write_memory: ({ name, content }) => {
    const filename = name.replace(/\.md$/, '') + '.md'
    return JSON.stringify({ success: true, result: fsSafe.writeFileSafe(path.join(state.settings.memoryDir, filename), content) })
  },
  search_web: ({ query }) => searchWeb(query),
  search_history: async ({ query, limit }) => {
    const results = await searchConversationHistory(query, { withContent: true, maxResults: limit || 3 })
    return JSON.stringify({
      success: true,
      query,
      results,
      note: results.length === 0 ? '没有找到匹配的历史会话，可换一个更精确的关键词再搜。' : `共命中 ${results.length} 个历史会话，已按最近更新排序。`,
    })
  },
  execute_command: ({ command, cwd }) => executeCommand(command, { cwd }),
  browser_open: async ({ url, timeoutMs }) => JSON.stringify({ success: true, result: await browserTest.openBrowser(url, timeoutMs) }),
  browser_click: async ({ selector, timeoutMs }) => JSON.stringify({ success: true, result: await browserTest.click(selector, timeoutMs) }),
  browser_type: async ({ selector, text }) => JSON.stringify({ success: true, result: await browserTest.type(selector, text) }),
  browser_press: async ({ key }) => JSON.stringify({ success: true, result: await browserTest.press(key) }),
  browser_eval: async ({ js, arg }) => JSON.stringify({ success: true, result: await browserTest.evalJs(js, arg) }),
  browser_get_page: async ({ maxLen }) => JSON.stringify({ success: true, result: await browserTest.getPage(maxLen) }),
  browser_snapshot: async ({ max }) => JSON.stringify({ success: true, result: await browserTest.snapshot(max) }),
  browser_wait_for: async ({ selector, condition, timeoutMs }) => JSON.stringify({ success: true, result: await browserTest.waitFor(selector, condition, timeoutMs) }),
  // 截图：落盘给用户看之外，**顺手把同一张图也回灌给模型**（视觉配置开启时）——
  // 这是"DOM 描述不了的视觉问题"（canvas、CSS 背景图、布局重叠）的唯一退路。
  browser_screenshot: async ({ name }, ctx) => {
    const res = await browserTest.screenshot(name)
    const { part, ...rest } = res
    if (!part || !isVisionCapable(ctx && ctx.profileId)) {
      return JSON.stringify({ success: true, result: rest })
    }
    const stash = toolImages.stashImages(ctx && ctx.convId, [{ label: `网页截图 ${res.path}`, part }])
    return JSON.stringify({
      success: true,
      result: {
        ...rest,
        delivered: stash.accepted,
        note: stash.accepted > 0
          ? '截图已作为图像附在你的下一条消息里，你能直接看到它。'
          : '截图已落盘，但没能作为图像发给你。',
      },
    })
  },
  // 网页取图（视觉）：图片本体经 tool-images 侧通道暂存，由 chat.js 注入**下一轮** user 消息
  // （Chat Completions 的 tool 消息只能放字符串，这里不能把 base64 塞进返回值 ——
  //   塞进去等于把图片按字符计费，同一张图会从 ~1.4k token 变成 15k~25k）。
  // 所以返回值里只留文字索引，parts 一律不进 JSON。
  browser_read_images: async ({ max }, ctx) => {
    const res = await browserTest.readImages({ max })
    const { parts, ...text } = res
    const stash = toolImages.stashImages(ctx && ctx.convId, parts || [])
    const result = {
      ...text,
      delivered: stash.accepted,
      duplicates: stash.duplicates,
      dropped: stash.dropped,
    }
    if (stash.dropped > 0) {
      result.note = `${result.note}另有 ${stash.dropped} 张因单次上限（最多 4 张 / 体积预算）未发送。`
    }
    return JSON.stringify({ success: true, result })
  },
  browser_console_logs: ({ limit, type, clear }) => JSON.stringify({ success: true, result: browserTest.consoleLogs(limit, type, clear) }),
  browser_close: () => JSON.stringify({ success: true, result: browserTest.closeBrowser() }),
  browser_wait_download: async ({ name, timeoutMs }) => JSON.stringify({ success: true, result: await browserTest.waitForDownload({ name, timeoutMs }) }),
  // A4/A5：批量执行 + 断言 + 固化回放。一次调用跑完一串步骤，失败即停并回传失败处快照。
  browser_flow: async (args) => JSON.stringify({ success: true, result: await browserTest.runFlow(args) }),
  legal_npc_search: async (args) => JSON.stringify({ success: true, result: await legalNpcSearch(args) }),
  download_url: async (args) => JSON.stringify({ success: true, result: await downloadUrl(args) }),
  ask_user: (args, ctx) =>
    require('../chat').askUserWithAbort(ctx.event && ctx.event.sender, ctx.convId, args.question, args.options || [], ctx.controller),
  spawn_sub_agent: (args, ctx) => handleSpawnSubAgent(args, ctx),
  get_sub_agent_results: (args, ctx) => handleGetSubAgentResults(args, ctx),
}

// 长耗时工具（grep/glob 大仓库等）的进度播报器：在主进程侧向渲染层发 chat:status。
// 只在工具循环里调用（有 event.sender + convId）时可用；渲染层销毁后静默丢弃。
// 频率由调用方节流（search.js 内是 700ms 一次），不要在此加计时器。
function makeProgressReporter(ctx, toolName) {
  const sender = ctx && ctx.event && ctx.event.sender
  if (!sender || typeof sender.isDestroyed !== 'function' || sender.isDestroyed()) return null
  return (message) => {
    try {
      sender.send('chat:status', { convId: ctx.convId, type: 'tool_wait', tool: toolName, message })
    } catch {
      // 窗口已销毁时忽略
    }
  }
}

// 哪些工具的参数带路径？执行前把它们记进 agents-md 的「最近碰过路径」，
// 供下一轮推断「当前在哪个项目」并注入该项目的 AGENTS.md。
// 只记 path（目录/文件根），不记参数里的 glob 模式 —— 推断项目只需仓库级线索。
const PATH_ARG_KEYS = ['path', 'file_path', 'filePath', 'dir', 'directory']

function recordTouchedPath(name, args) {
  if (!args || typeof args !== 'object') return
  for (const key of PATH_ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value) {
      agentsMd.recordPathTouched(value)
      return
    }
  }
}

// 执行一次工具调用：解析参数 → 查注册表 → zod 校验 → 失败返回带字段错误的结构化结果 → 派发 handler。
// 校验失败时把"哪个字段、错在哪"喂回给模型，让它能自己修正参数后重试，而不是只看一句泛化错误。
async function executeToolCall(toolCall, ctx = {}) {
  const { name, arguments: argsRaw } = toolCall.function
  let parsed
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    return JSON.stringify({ success: false, error: `参数不是合法 JSON：${String(argsRaw).slice(0, 200)}` })
  }

  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) return JSON.stringify({ success: false, error: `Unknown tool: ${name}` })

  // 子代理只读策略：执行层的硬约束（子代理不经过 guard.js，且 tools 下发过滤可能被
  // 「文本形态工具调用还原」绕过）。写类工具一律拒；execute_command 只放行只读命令。
  // 与 sub-agent.js 的 BLOCKED_TOOLS 过滤互为兜底，两者用同一份名单（tools/subagent-policy.js）。
  if (ctx && ctx.subAgent) {
    const verdict = subagentPolicy.checkSubAgentToolCall(name, parsed)
    if (!verdict.ok) {
      console.log(`[subagent-policy] 拒绝 ${name}: ${verdict.error.slice(0, 120)}`)
      return JSON.stringify({ success: false, blocked: true, error: verdict.error })
    }
  }

  const v = tool.schema.safeParse(parsed)
  if (!v.success) {
    const issues = v.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    return JSON.stringify({ success: false, validationError: issues, error: `参数校验失败：${issues.join('；')}` })
  }

  const handler = TOOL_HANDLERS[name]
  if (!handler) return JSON.stringify({ success: false, error: `Unknown tool: ${name}` })
  // 记为「碰过的路径」，用于下一轮的项目级上下文（AGENTS.md）推断
  recordTouchedPath(name, v.data)
  // 注意：handler 可能返回 Promise（grep_code / glob_files / execute_command 等），
  // 必须 return 而非 await 后二次包装 —— 调用方（chat.js）统一 await executeToolCall。
  return handler(v.data, { ...ctx, onProgress: makeProgressReporter(ctx, name) })
}

module.exports = { TOOL_HANDLERS, executeToolCall, killAllChildren }