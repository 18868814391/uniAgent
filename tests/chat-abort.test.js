// 会话「无声结束」P0 修复的回归测试
//
// 背景（真实故障）：某轮对话里模型把工具调用写成了正文（`<tool_call>…`，opencode 网关转发的
// mimo 系不走原生 function calling），主进程只认结构化 tool_calls，于是把这一轮当成"正常回答"
// 收尾（endReason=complete）→ 前端零提示、工具一次都没执行，用户看到的就是"说要干活然后没了"。
//
// 同一个坑还有第二种触发方式：4 处 `return` 静默返回（压缩期 / 工具循环中 / 无真答且被中断 /
// catch）都不发 chat:done 或 chat:error，只要 `controller.abort()` 被"空闲超时"（180s 无数据）
// 触发，就同样无声结束；而空闲超时那条路又不杀子进程，于是"界面停了、Python 还在跑"。
//
// 这里锁住五条不变量：
//   1) 正常完成 → endReason=complete（回归，别把好路径改坏）
//   2) 正文里出现文本形态工具调用 → **还原成结构化调用并真正执行**，而不是无声结束
//   3) 用户点「中断」→ 发 chat:done(endReason=aborted, abortedBy=user)，不再静默；且杀子进程
//   4) 空闲超时 → 发 chat:error(endReason=timeout, abortedBy=idle)，同样杀子进程
//   5) 压缩期被中断（原先的第 1 处静默 return）→ 也要发终态事件
//   6) 同一会话被新请求取代 → 旧运行绝不发终态事件（否则会串掉新回合的 UI 状态）
//
// 另：done/error 事件现在还会带一个 `resumable` 标记（该会话是否留下了断点续跑快照），
// 渲染层据此在"用户主动中断"这种不出错误横幅的场合也给一个中性的「继续」入口。
// 本文件把快照模块整体桩成 no-op，故这些用例里 resumable 恒为 false；
// 快照的真实读写、回放与降级见 turn-resume.test.js。
//
// chat.js 是 CJS 且加载即 require('electron')，故先把全部依赖塞进 require.cache 再 require，
// 使其能在纯 Node（无 Electron、无真实网络）下跑完整轮次。空闲超时不靠真等 180 秒：
// 计时器唯一的动作就是 `run.abortRun('idle')`，测试直接调它即可等价复现。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const CHAT = path.join(__dirname, '..', 'electron', 'chat.js')
const CONV = 'conv-abort-test'

// ---- 可注入的桩行为（每个用例前重置） ----
let currentFetch = null
let currentCompact = null
const sent = []            // 主进程发给渲染层的事件
const killed = []          // killAllChildren 调用记录
const executedTools = []   // executeToolCall 的工具名记录
const abortedSubAgents = [] // 子 Agent 中止记录
const handlers = {}        // 捕获 ipcMain.handle / ipcMain.on
const stateStub = {
  settings: {},
  chatRuns: new Map(),
  askSeq: 0,
  subAgents: new Map(),
  subAgentsPending: new Map(),
  mainWindow: null,
}

const stub = (request, exports) => {
  const id = require.resolve(request, { paths: [path.dirname(CHAT)] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

stub('electron', {
  ipcMain: {
    handle: (ch, fn) => { handlers[ch] = fn },
    on: (ch, fn) => { handlers[ch] = fn },
  },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  BrowserWindow: {
    fromWebContents: () => ({ isDestroyed: () => false }),
    getAllWindows: () => [],
  },
})
stub('./state', stateStub)
// tool-schemas 必须用**真实**的 TOOLS：text-tool-call.js 靠它校验还原出来的工具名
// 是否真实存在（桩成空数组的话，任何调用都"还原失败"，用例就测不到真正的执行路径了）。
// 只把 TOOLS_DEFINITION 打成空数组即可 —— 本文件不关心下发给模型的工具清单。
const realToolSchemas = require(path.join(__dirname, '..', 'electron', 'tool-schemas.js'))
stub('./tool-schemas', {
  TOOLS: realToolSchemas.TOOLS,
  zodToJsonSchema: realToolSchemas.zodToJsonSchema,
  TOOLS_DEFINITION: [],
})
// describeFetchError 等其余导出走**真实实现**：chat.js 在本轮请求失败收尾时用它格式化失败原因。
// ⚠️ 必须在 stub 之前 require，否则会拿到 cache 里的桩。
const realNetRetry = require(path.join(__dirname, '..', 'electron', 'net-retry.js'))
stub('./net-retry', { ...realNetRetry, fetchWithRetry: (...args) => currentFetch(...args) })
stub('./settings', {
  DEFAULT_BASE_URL: 'http://127.0.0.1/v1',
  DEFAULT_MODEL_ID: 'test-model',
  DEFAULT_CONTEXT_WINDOW: 128000,
  MAX_CONSECUTIVE_ASKS: 2,
  getActiveProfile: () => ({
    apiKey: 'sk-test',
    baseUrl: 'http://127.0.0.1/v1',
    model: 'test-model',
    contextWindow: 128000,
  }),
  getApiBaseUrl: () => 'http://127.0.0.1/v1',
  buildSystemPrompt: () => 'system',
})
stub('./context', {
  estimateTokens: () => 0,
  estimateMessagesTokens: () => 0,
  getModelContextWindow: () => 128000,
  maybeCompactHistory: (...args) => currentCompact(...args),
})
stub('./tools/fs-safe', {
  buildImageParts: async () => [],
  addImagePartsToLatestUser: (msgs) => msgs,
  imageMimeForPath: () => null,
})
stub('./tools', {
  // 记录被调用的工具名：用于断言"文本形态工具调用被还原后**真的执行了"。
  // 签名见 tools/index.js：executeToolCall(toolCall) —— 收的是 {function:{name,arguments}}。
  executeToolCall: async (toolCall) => {
    executedTools.push(toolCall && toolCall.function ? toolCall.function.name : String(toolCall))
    return JSON.stringify({ success: true })
  },
  killAllChildren: () => killed.push(Date.now()),
})
stub('./sub-agent', {
  abortSubAgentsForConversation: (convId) => abortedSubAgents.push(convId),
})
stub('./xl-work', { newRunWorkDir: () => '/tmp/xl-work', scheduleCleanup: () => {}, pruneRootLeftovers: () => 0 })
// 孤儿进程清扫：测试里绝不真去枚举系统进程表（慢 400ms+，而且在有真孤儿的机器上会真杀进程）
stub('./tools/orphan-cleanup', { killOrphanScriptProcesses: async () => ({ found: 0, killed: [] }) })
// 断点续跑快照：本文件只关心"终态事件与子进程"，快照的真实读写由 turn-resume.test.js 覆盖。
// 这里全部桩成 no-op，顺便验证"快照不可用/写不进去"时主流程照旧跑通（降级路径）。
stub('./turn-snapshot', {
  SNAPSHOT_TTL_MS: 24 * 60 * 60 * 1000,
  hashHistory: () => 'stub-hash',
  saveTurnSnapshot: () => false,
  loadTurnSnapshot: () => null,
  loadResumableTurn: () => null,
  hasResumableTurn: () => false,
  clearTurnSnapshot: () => false,
  repairToolSequence: (messages) => ({ messages, total: 0, repaired: 0 }),
})

const chat = require(CHAT)
chat.registerIpc() // 注册 chat:send / chat:stop 等 handler

// ---- 辅助 ----
const sse = (obj) => `data: ${JSON.stringify(obj)}\n`

// 正常流：按顺序吐出若干 SSE 块后结束
function streamFetch(chunks) {
  return async () => {
    let i = 0
    const enc = new TextEncoder()
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined },
        }),
      },
    }
  }
}

// 卡住的流：一直挂着，直到 signal 被 abort 才像真 fetch 一样抛 AbortError
function blockingFetch() {
  return async (_url, init) => {
    const signal = init && init.signal
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: () =>
            new Promise((_resolve, reject) => {
              const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
              if (signal && signal.aborted) return onAbort()
              if (signal) signal.addEventListener('abort', onAbort, { once: true })
            }),
        }),
      },
    }
  }
}

// 多轮流：每调用一次 fetch 返回下一段流（工具循环里每轮请求各调一次）。
// 最后一段用完后重复最后一段，避免因多请求一次而拿到空流导致用例假失败。
function multiTurnFetch(turns) {
  let i = 0
  return async () => {
    const idx = Math.min(i, turns.length - 1)
    const chunks = turns[idx]
    i++
    const enc = new TextEncoder()
    let k = 0
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () =>
            k < chunks.length ? { done: false, value: enc.encode(chunks[k++]) } : { done: true, value: undefined },
        }),
      },
    }
  }
}

function makeEvent() {
  return { sender: { send: (ch, payload) => sent.push({ ch, payload }) } }
}

const eventsOf = (ch) => sent.filter((e) => e.ch === ch)
const terminalEvents = () => sent.filter((e) => e.ch === 'chat:done' || e.ch === 'chat:error')

async function waitFor(predicate, { tries = 200 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 0))
  }
  throw new Error('waitFor: 条件未在预期内满足')
}

const payload = () => ({
  conversationId: CONV,
  messages: [{ role: 'user', content: '帮我写一份 PRD' }],
  profileId: 'test-profile',
  autoExecute: true,
})

test.beforeEach(() => {
  sent.length = 0
  killed.length = 0
  executedTools.length = 0
  abortedSubAgents.length = 0
  stateStub.chatRuns = new Map()
  stateStub.settings = { allowedDirs: [], role: 'product', autoExecute: true, subAgentsEnabled: false }
  currentFetch = null
  // 默认：未超阈值，不做压缩
  currentCompact = async () => null
})

test('正常完成（stop + 无工具调用）→ endReason=complete，不发 error、不杀子进程', async () => {
  currentFetch = streamFetch([
    sse({ choices: [{ delta: { content: '好的，' } }] }),
    sse({
      choices: [{ delta: { content: '这就开始。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
    }),
  ])

  await chat.handleChatSend(makeEvent(), payload())

  const done = eventsOf('chat:done')
  assert.equal(done.length, 1, '正常完成只发一次 chat:done')
  assert.equal(done[0].payload.endReason, 'complete')
  assert.equal(done[0].payload.fullContent, '好的，这就开始。')
  assert.equal(done[0].payload.usage.total_tokens, 16)
  assert.equal(done[0].payload.abortedBy, null)
  assert.equal(eventsOf('chat:error').length, 0)
  assert.equal(killed.length, 0, '正常完成不该杀子进程')
  assert.equal(stateStub.chatRuns.has(CONV), false, '收尾后要从 chatRuns 摘掉')
})

test('正文里出现文本形态工具调用 → 还原成结构化调用并真正执行（不再无声结束）', async () => {
  const text =
    '好的，我先加载文档技能，然后创建 PRD 文档。\n' +
    '<tool_call>\n<function=read_skill>\n<parameter=name>docx</parameter>\n</function>\n</tool_call>'
  // 第一轮：模型把调用写进正文；工具执行完后第二轮给真正的文字回答。
  // 注意 endReason 必须是 complete —— 这正是本用例要锁的核心不变量。
  const finalAnswer = '技能已加载，PRD 已创建。'
  currentFetch = multiTurnFetch([
    [
      sse({
        choices: [{ delta: { content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2867648, completion_tokens: 9063, total_tokens: 2876711 },
      }),
    ],
    [
      sse({
        choices: [{ delta: { content: finalAnswer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    ],
  ])

  await chat.handleChatSend(makeEvent(), payload())

  // 关键断言：调用被**还原并真正执行了**（旧行为是一次都不执行 → 用户看到"说要干活然后没了"）
  assert.deepEqual(executedTools, ['read_skill'], '文本形态的调用应被还原后走正常工具循环执行')
  assert.ok(eventsOf('chat:tool').length >= 1, '应发出 chat:tool 事件（渲染层要显示工具执行）')

  const done = eventsOf('chat:done')
  assert.equal(done.length, 1, '只发一次终态事件，绝不静默')
  // 还原成功 → 走完工具循环拿到真答案，应为 complete
  assert.equal(
    done[0].payload.endReason,
    'complete',
    '还原并执行成功后应正常收尾，不能是 text_tool_call（那才是无声结束的根因）'
  )
  // 正文里那坨 XML 已被清理（真实回归：曾经只重置了 responseContent，
  // fullContent 跨轮累加没撤，导致 XML 一直留在最终正文与消息历史里）
  assert.ok(!done[0].payload.fullContent.includes('<tool_call>'), 'XML 工具调用标记应被清理')
  assert.ok(!done[0].payload.fullContent.includes('<function='), 'XML 片段应被清理')
  // 清理后应保留模型的正常文字（引导语 + 最终回答）
  assert.equal(
    done[0].payload.fullContent,
    '好的，我先加载文档技能，然后创建 PRD 文档。' + finalAnswer,
    '应只清掉 XML，保留两轮的正常文字'
  )
})

test('文本形态工具调用**还原失败**时 → 退回 endReason=text_tool_call，如实告知而非静默', async () => {
  // 只有 <tool_call> 开标签、没有可解析的 function 体 → 还原必然失败
  const text = '我这就去做：\n<tool_call>\n参数我还没想好\n</tool_call>'
  currentFetch = streamFetch([
    sse({
      choices: [{ delta: { content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }),
  ])

  await chat.handleChatSend(makeEvent(), payload())

  const done = eventsOf('chat:done')
  assert.equal(done.length, 1, '还原失败也必须发终态事件，不能静默')
  assert.equal(done[0].payload.endReason, 'text_tool_call', '还原失败才退回这个结束原因')
  assert.match(done[0].payload.endDetail, /function calling/, '应提示换用支持原生 function calling 的模型')
  assert.equal(executedTools.length, 0, '还原失败就不该执行任何工具')
  // 正文仍保留给用户看
  assert.ok(done[0].payload.fullContent.includes('<tool_call>'))
})

test('用户点「中断」→ chat:done(aborted, user) + 杀子进程，不再静默返回', async () => {
  currentFetch = blockingFetch()
  const running = chat.handleChatSend(makeEvent(), payload())
  await waitFor(() => stateStub.chatRuns.has(CONV))

  handlers['chat:stop'](null, CONV)
  await running

  const done = eventsOf('chat:done')
  assert.equal(done.length, 1, '中断必须发终态事件（旧版此处静默 return）')
  assert.equal(done[0].payload.endReason, 'aborted')
  assert.equal(done[0].payload.abortedBy, 'user')
  assert.equal(eventsOf('chat:error').length, 0, '用户中断属预期操作，不该出错误横幅')
  assert.equal(killed.length, 1, '中断要杀掉后台子进程')
  assert.deepEqual(abortedSubAgents, [CONV], '中断要连带中止子 Agent')
  assert.equal(stateStub.chatRuns.has(CONV), false)
})

test('空闲超时 → chat:error(timeout, idle) + 杀子进程（旧版既静默又留残留进程）', async () => {
  currentFetch = blockingFetch()
  const running = chat.handleChatSend(makeEvent(), payload())
  await waitFor(() => stateStub.chatRuns.has(CONV))

  // 等价于 IDLE_TIMEOUT_MS 到期：计时器唯一的动作就是 run.abortRun('idle')
  stateStub.chatRuns.get(CONV).abortRun('idle')
  await running

  const errs = eventsOf('chat:error')
  assert.equal(errs.length, 1, '空闲超时必须发终态事件（旧版此处静默 return）')
  assert.equal(errs[0].payload.endReason, 'timeout')
  assert.equal(errs[0].payload.abortedBy, 'idle')
  assert.match(errs[0].payload.message, /180 秒/)
  assert.equal(eventsOf('chat:done').length, 0)
  assert.equal(killed.length, 1, '空闲超时同样要杀子进程')
  assert.equal(stateStub.chatRuns.has(CONV), false)
})

test('压缩期被中断（原先的第 1 处静默 return）→ 也要发终态事件', async () => {
  // 压缩挂起，直到被 abort 才返回
  currentCompact = async ({ signal }) => {
    await new Promise((resolve) => {
      if (signal.aborted) return resolve()
      signal.addEventListener('abort', resolve, { once: true })
    })
    return null
  }
  currentFetch = blockingFetch() // 压缩返回后若继续往下走会被卡住（用于反证没有继续）

  const running = chat.handleChatSend(makeEvent(), payload())
  await waitFor(() => stateStub.chatRuns.has(CONV))

  handlers['chat:stop'](null, CONV)
  await running

  const done = eventsOf('chat:done')
  assert.equal(done.length, 1)
  assert.equal(done[0].payload.endReason, 'aborted')
  assert.equal(done[0].payload.abortedBy, 'user')
  assert.equal(stateStub.chatRuns.has(CONV), false)
})

test('同一会话被新请求取代 → 旧运行绝不发终态事件，避免串掉新回合', async () => {
  currentFetch = blockingFetch()
  const first = chat.handleChatSend(makeEvent(), payload())
  await waitFor(() => stateStub.chatRuns.has(CONV))

  const second = chat.handleChatSend(makeEvent(), payload())
  await first // 旧运行收尾

  assert.equal(terminalEvents().length, 0, '陈旧运行发 done/error 会复位新回合的 isStreaming 并清空其监听')
  assert.equal(stateStub.chatRuns.has(CONV), true, '该会话的运行槽应仍属于新运行')

  handlers['chat:stop'](null, CONV)
  await second
  assert.equal(eventsOf('chat:done')[0].payload.abortedBy, 'user', '新运行自身的中断照常发事件')
})
