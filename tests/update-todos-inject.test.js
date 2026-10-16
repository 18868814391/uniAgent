// 任务清单「每轮回显」的集成测试（update_todos 的核心行为）。
//
// 单测 tests/update-todos.test.js 锁的是纯逻辑；这里锁的是**接线**，也就是这个功能真正起作用的那一步：
//   1) 有清单时，每一条发给模型请求的末尾都要带【任务清单】段（不是只第一轮）
//   2) 清单为空时一条都不发（零开销 —— 不能白占每轮 prefill）
//   3) 注入**不能造出连续两条 user 消息**（原代码从不在工具消息前插 user，轮次提醒最早第 40 轮才触发；
//      任务清单每轮都注入，是本机制新引入的风险）
//   4) 注入后消息序列仍然合法：assistant(tool_calls) 后必须紧跟等量 tool 消息（否则接口 400）
//   5) 轮次提醒与任务清单合并进同一条消息，不是两条
//   6) 工具下发正确：只有 dev 角色拿得到 update_todos
//
// chat.js 是 CJS 且加载即 require('electron')，故先把依赖塞进 require.cache。
// 桩列表与 tool-loop-budget.test.js / tool-result-window.test.js 保持一致。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const CHAT = path.join(__dirname, '..', 'electron', 'chat.js')

const stub = (request, exports) => {
  const id = require.resolve(request, { paths: [path.dirname(CHAT)] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

// 【注意】chat.js 在模块加载时解构 `const { TOOLS_DEFINITION } = require('./tool-schemas')`，
// 拿到的是**数组引用**。所以这里必须在 stub 之前把数组内容定好，之后只能改数组内容、不能换引用。
const TOOLS_DEFINITION = [
  { type: 'function', function: { name: 'read_file', description: 'x', parameters: {} } },
  { type: 'function', function: { name: 'update_todos', description: 'y', parameters: {} } },
  { type: 'function', function: { name: 'browser_open', description: 'z', parameters: {} } },
]

const stateStub = {
  settings: {},
  chatRuns: new Map(),
  todos: new Map(),
  subAgents: new Map(),
  subAgentsPending: new Map(),
  mainWindow: null,
}
const executed = []
let currentFetch = async () => { throw new Error('本测试不发起请求') }

stub('electron', {
  ipcMain: { handle() {}, on() {} },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }), getAllWindows: () => [] },
})
stub('./state', stateStub)
stub('./tool-schemas', { TOOLS_DEFINITION })
// describeFetchError 等其余导出走真实实现（chat.js 失败收尾时用它格式化原因）；须在 stub 之前 require
const realNetRetry = require(path.join(__dirname, '..', 'electron', 'net-retry.js'))
stub('./net-retry', { ...realNetRetry, fetchWithRetry: (...a) => currentFetch(...a) })
stub('./settings', {
  DEFAULT_BASE_URL: 'http://127.0.0.1/v1',
  DEFAULT_MODEL_ID: 'test-model',
  DEFAULT_CONTEXT_WINDOW: 128000,
  MAX_CONSECUTIVE_ASKS: 2,
  getActiveProfile: () => ({ apiKey: 'sk-test', baseUrl: 'http://127.0.0.1/v1', model: 'test-model', contextWindow: 128000 }),
  getApiBaseUrl: () => 'http://127.0.0.1/v1',
  buildSystemPrompt: () => 'system',
})
stub('./context', {
  estimateTokens: () => 0,
  estimateMessagesTokens: () => 0,
  getModelContextWindow: () => 128000,
  maybeCompactHistory: async () => null,
})
stub('./tools/fs-safe', {
  buildImageParts: async () => [],
  addImagePartsToLatestUser: (msgs) => msgs,
  imageMimeForPath: () => null,
})
stub('./tools', {
  executeToolCall: async (tc) => {
    executed.push(tc.function.name)
    return JSON.stringify({ success: true, content: 'X' })
  },
  killAllChildren: () => {},
})
stub('./sub-agent', { abortSubAgentsForConversation: () => {} })
stub('./xl-work', { newRunWorkDir: () => '/tmp/xl-work', scheduleCleanup: () => {}, pruneRootLeftovers: () => 0 })
// 孤儿进程清扫：测试里绝不真去枚举系统进程表（慢 400ms+，而且在有真孤儿的机器上会真杀进程）
stub('./tools/orphan-cleanup', { killOrphanScriptProcesses: async () => ({ found: 0, killed: [] }) })
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
const todo = require(path.join(__dirname, '..', 'electron', 'tools', 'todo.js'))

const enc = new TextEncoder()
const sseLine = (obj) => `data: ${JSON.stringify(obj)}\n\n`

/**
 * 造一个 SSE fetch：前 `toolRounds` 轮返回 read_file 调用，之后返回正文收尾。
 * 每轮参数不同（带轮次序号）—— 参数完全相同会被 trackRepeatCall 拦下，那是另一条链路，别混淆。
 */
function makeFetch(requests, toolRounds) {
  return async (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push(body)

    // 兜底请求（不带 tools）走 .json() 分支
    if (!body.tools) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: '兜底回答' } }], usage: {} }) }
    }

    const idx = requests.length
    const useTool = idx <= toolRounds
    const parts = useTool
      ? [
          sseLine({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: `c${idx}`,
                  type: 'function',
                  function: { name: 'read_file', arguments: JSON.stringify({ path: `C:/f${idx}.js` }) },
                }],
              },
            }],
          }),
          sseLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
          'data: [DONE]\n\n',
        ]
      : [
          sseLine({ choices: [{ delta: { content: '改完了，改了 2 个文件。' } }] }),
          sseLine({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
          'data: [DONE]\n\n',
        ]

    let i = 0
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => (i < parts.length ? { done: false, value: enc.encode(parts[i++]) } : { done: true, value: undefined }),
        }),
      },
    }
  }
}

function event() {
  const sent = []
  return { sent, sender: { send: (ch, payload) => { sent.push({ ch, payload }) } } }
}

const CONV = 'conv-todo-inject'
const payload = () => ({
  conversationId: CONV,
  messages: [{ role: 'user', content: '帮我改一下这个页面的表格' }],
  profileId: 'test-profile',
  autoExecute: true,
})

// 「清单已存在、需要在请求里被回显」的现实场景**只有一个**：同一个任务的续跑
// —— 用户新发一条消息会清空清单（见下方「轮次边界」两个用例），所以清单不可能跨任务存活。
// 凡是要验证"清单被回显/被注入"的用例，都用这个 payload 发起（等价用户点了「继续」）。
const payloadKeepTodos = () => ({ ...payload(), resumeTurn: true })

function resetState(role) {
  executed.length = 0
  stateStub.settings = { allowedDirs: [], role, autoExecute: true, subAgentsEnabled: false }
  stateStub.chatRuns = new Map()
  stateStub.todos = new Map()
  todo.clearTodos(CONV)
}

const userMsgs = (req) => (req.messages || []).filter((m) => m.role === 'user')
const todoMsgs = (req) => (req.messages || []).filter((m) => typeof m.content === 'string' && m.content.includes('【任务清单】'))

// ============================================================

test('有清单时：第一个请求就带上【任务清单】，且是并入用户消息、不新增一条 user', async () => {
  resetState('dev')
  // 直接往主进程侧塞一份清单（等价于上一轮模型调过 update_todos）
  todo.updateTodos(CONV, [
    { text: '已完成的老任务-不应出现在回显里', status: 'completed' },
    { text: '改 ht-table-page/index.vue', status: 'in_progress' },
    { text: '跑 eslint', status: 'pending' },
  ])

  const requests = []
  currentFetch = makeFetch(requests, 0)
  await chat.handleChatSend(event(), payloadKeepTodos())

  const first = requests[0]
  assert.ok(first, '应发出至少一次请求')
  assert.equal(todoMsgs(first).length, 1, '第一个请求就该带【任务清单】')

  const injected = todoMsgs(first)[0]
  assert.match(injected.content, /共 3 项，已完成 1 项/)
  assert.match(injected.content, /当前进行中：改 ht-table-page\/index\.vue/)
  assert.match(injected.content, /\[ \] 跑 eslint/)
  assert.equal(injected.content.includes('已完成的老任务'), false, '已完成项不该回显')

  // 注入是并进用户那条，不是新开一条 —— 否则请求开头就是连续两条 user
  assert.equal(userMsgs(first).length, 1, '只应有一条 user 消息（提醒并入其中）')
  assert.match(userMsgs(first)[0].content, /帮我改一下这个页面的表格/)
})

test('清单为空时：一个请求都不带【任务清单】（零开销）', async () => {
  resetState('dev')
  const requests = []
  currentFetch = makeFetch(requests, 2)
  await chat.handleChatSend(event(), payload())

  assert.ok(requests.length >= 3)
  for (const r of requests) {
    assert.equal(todoMsgs(r).length, 0, '没有清单时不应注入任何提醒段')
  }
})

test('每轮都回显，而且新注入的那条永远在请求末尾', async () => {
  resetState('dev')
  todo.updateTodos(CONV, [{ text: '第二项任务', status: 'in_progress' }])

  const requests = []
  currentFetch = makeFetch(requests, 3)
  await chat.handleChatSend(event(), payloadKeepTodos())

  const withTools = requests.filter((r) => r.tools)
  assert.equal(withTools.length, 4, '3 轮工具 + 1 轮正文收尾')
  for (const [i, r] of withTools.entries()) {
    const ms = r.messages
    // 每个请求都会重发全量历史，所以早期注入的那几条还在 —— 不能断言"只有一条"。
    // 真正要锁的是：**本轮新注入的那条在末尾**（这是"追加而非改写"的证据，也是前缀缓存友好的前提）。
    assert.ok(todoMsgs(r).length >= 1, `第 ${i + 1} 个请求应带清单`)
    assert.ok(
      typeof ms[ms.length - 1].content === 'string' && ms[ms.length - 1].content.includes('【任务清单】'),
      `第 ${i + 1} 个请求的末尾应是本轮新注入的清单段`
    )
  }
})

test('注入后消息序列仍合法，且全程不出现连续两条 user 消息', async () => {
  resetState('dev')
  todo.updateTodos(CONV, [{ text: 'A', status: 'in_progress' }])

  const requests = []
  currentFetch = makeFetch(requests, 6)
  await chat.handleChatSend(event(), payloadKeepTodos())

  for (const r of requests) {
    const ms = r.messages || []
    // ① 不允许连续两条 user：提醒必须并入已有 user 消息，或落在 tool 消息之后
    for (let i = 1; i < ms.length; i++) {
      assert.ok(
        !(ms[i].role === 'user' && ms[i - 1].role === 'user'),
        `出现连续两条 user 消息（第 ${i} 条）—— 部分 OpenAI 兼容网关会 400`
      )
    }
    // ② assistant(tool_calls) 之后必须紧跟等量 tool 消息
    let need = 0
    for (const m of ms) {
      if (need > 0) {
        assert.equal(m.role, 'tool', 'assistant(tool_calls) 后必须紧跟 tool 消息')
        need--
        continue
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) need = m.tool_calls.length
    }
  }
})

test('第 40 轮的轮次提醒与任务清单合并成同一条消息，而不是两条', async () => {
  resetState('dev')
  todo.updateTodos(CONV, [{ text: 'B', status: 'in_progress' }])

  const requests = []
  // 45 轮工具调用 —— 足以跨过 BUDGET_WARN_FROM(40)
  currentFetch = makeFetch(requests, 45)
  await chat.handleChatSend(event(), payloadKeepTodos())

  const withTools = requests.filter((r) => r.tools)
  const has = (m, s) => m && typeof m.content === 'string' && m.content.includes(s)
  // 「本轮新注入了轮次提醒」的判据 = 末尾那条带【轮次提醒】（注入永远在末尾）
  const fresh = withTools.filter((r) => has(r.messages[r.messages.length - 1], '【轮次提醒】'))
  assert.ok(fresh.length >= 1, '应至少注入过一次轮次提醒')

  for (const r of fresh) {
    const tail = r.messages[r.messages.length - 1]
    assert.ok(has(tail, '【任务清单】'), '两个提醒必须合并进同一条消息 —— 分开推就是连续两条 user')
  }
  // 第一次注入（第 40 轮）时全请求里只该有 1 条轮次提醒
  const first = fresh[0]
  const count = (first.messages || []).filter((m) => has(m, '【轮次提醒】')).length
  assert.equal(count, 1, `第 40 轮首次注入时不应出现多条轮次提醒（实际 ${count}）`)
})

test('工具下发：全角色都能拿到 update_todos；开源版不做工具收窄', async () => {
  for (const role of ['dev', 'general', 'product', 'qa', 'excel', 'legal']) {
    resetState(role)
    const req = []
    currentFetch = makeFetch(req, 0)
    await chat.handleChatSend(event(), payload())
    const names = (req[0].tools || []).map((t) => t.function.name)
    assert.ok(names.includes('update_todos'), `${role} 角色也应拿到 update_todos（2026-09-30 起放开）`)
    assert.ok(names.includes('read_file'), `${role} 应拿到改码工具`)
    assert.ok(names.includes('browser_open'), `${role} 应拿到浏览器工具（开源版不按角色收窄）`)
  }
})

test('settings.todosEnabled = false 时不下发（照 subAgentsEnabled 的开关模式：undefined 视为开）', async () => {
  resetState('dev')
  stateStub.settings.todosEnabled = false
  const req = []
  currentFetch = makeFetch(req, 0)
  await chat.handleChatSend(event(), payload())
  const names = (req[0].tools || []).map((t) => t.function.name)
  assert.equal(names.includes('update_todos'), false, '关掉开关后不应下发')
  assert.ok(names.includes('read_file'), '其余工具不受影响')

  // 显式 true 与 undefined 都要下发（不能把「没配置」当成关闭）
  for (const value of [undefined, true]) {
    resetState('dev')
    stateStub.settings.todosEnabled = value
    const r2 = []
    currentFetch = makeFetch(r2, 0)
    await chat.handleChatSend(event(), payload())
    assert.ok(
      (r2[0].tools || []).map((t) => t.function.name).includes('update_todos'),
      `todosEnabled=${String(value)} 时应下发`
    )
  }
})

// ============================================================
//  轮次边界：新发消息清空清单，「继续」保留清单
// ============================================================

test('新发消息（非续跑）清空上一轮清单；「继续」保留清单', async () => {
  // ① 新发消息 → 清空（用户要的语义：新消息 = 新任务，按原逻辑重新生成）
  resetState('dev')
  todo.updateTodos(CONV, [{ text: '上一轮已完成的任务', status: 'completed' }])
  assert.equal(todo.getTodos(CONV).length, 1, '前置：清单应存在')

  const r1 = []
  currentFetch = makeFetch(r1, 0)
  await chat.handleChatSend(event(), payload()) // payload() 不带 resumeTurn
  assert.equal(todo.getTodos(CONV).length, 0, '新发消息必须清空上一轮的清单')
  assert.equal(todoMsgs(r1[0]).length, 0, '清空后第一个请求就不该再带旧清单（不能拿旧计划当上下文）')

  // ② 「继续」→ 保留（同一任务的断点续跑）
  resetState('dev')
  todo.updateTodos(CONV, [
    { text: '续跑中已完成的一项', status: 'completed' },
    { text: '续跑中待做的一项', status: 'pending' },
  ])
  const r2 = []
  currentFetch = makeFetch(r2, 0)
  await chat.handleChatSend(event(), { ...payload(), resumeTurn: true })
  assert.equal(todo.getTodos(CONV).length, 2, '「继续」必须保留清单')
  assert.equal(todoMsgs(r2[0]).length, 1, '续跑时清单照常回显')

  todo.clearTodos(CONV)
})

test('清空发生在模型循环之前：新任务的所有请求里都不得出现旧清单', async () => {
  resetState('product') // 换个角色，确认不是 dev 的特例
  todo.updateTodos(CONV, [{ text: '上一轮-product-任务的清单', status: 'completed' }])

  const req = []
  currentFetch = makeFetch(req, 2)
  await chat.handleChatSend(event(), payload())

  assert.ok(req.length >= 3)
  for (const [i, r] of req.entries()) {
    assert.equal(todoMsgs(r).length, 0, `第 ${i + 1} 个请求不该带旧清单`)
    assert.equal(
      JSON.stringify(r.messages).includes('上一轮-product-任务的清单'),
      false,
      `旧清单文本不得出现在第 ${i + 1} 个请求里`
    )
  }
})

// ============================================================
//  「你还没列计划」就地提醒（2026-10-04 补 PLAN_NUDGE）
//  起因：纪律写在系统提示词的【任务清单】公共段里，但弱模型/转发网关会整段忽略它 ——
//  用户真实会话台账（userData/conversations/<id>.activity.json）里 48 次工具调用、update_todos 0 次，
//  界面上的任务清单面板始终不出现，用户反馈「任务清单改没了」。
//  这里把纪律挪到**请求末尾**再说一遍，与轮次预算提醒同一机制。
// ============================================================
const planNudges = (req) =>
  (req.messages || []).filter((m) => typeof m.content === 'string' && m.content.includes('还没有列任务清单'))

test('跑满 3 轮工具仍没有清单 → 第 4 个请求末尾提醒补列计划（且只提醒一次）', async () => {
  resetState('dev')
  const requests = []
  currentFetch = makeFetch(requests, 5)
  await chat.handleChatSend(event(), payload())

  const withTools = requests.filter((r) => r.tools)
  assert.ok(withTools.length >= 5, `应有 5 轮工具请求，实测 ${withTools.length}`)

  // 前 3 个请求不该出现提醒（loop 0/1/2）
  for (let i = 0; i < 3; i++) {
    assert.equal(planNudges(withTools[i]).length, 0, `第 ${i + 1} 个请求不该提醒（还没跑够轮次）`)
  }
  // 第 4 个请求（loop === 3）出现，且**在末尾**（追加而非改写，前缀缓存友好）
  const fourth = withTools[3]
  assert.equal(planNudges(fourth).length, 1, '第 4 个请求应提醒一次')
  const lastMsg = fourth.messages[fourth.messages.length - 1]
  assert.match(String(lastMsg.content), /还没有列任务清单/, '提醒必须在请求末尾')
  assert.match(String(lastMsg.content), /update_todos/, '提醒要点名该调哪个工具')

  // 后续请求里它是"历史"的一部分，不应再新增第二条
  assert.equal(planNudges(withTools[4]).length, 1, '只该有一条提醒，不能每轮都塞')
})

test('短任务（只跑 2 轮）不提醒 —— 零噪声', async () => {
  resetState('dev')
  const requests = []
  currentFetch = makeFetch(requests, 2)
  await chat.handleChatSend(event(), payload())
  assert.ok(requests.length >= 3)
  for (const r of requests) {
    assert.equal(planNudges(r).length, 0, '一句话能做完的琐碎任务不该被提醒打扰')
  }
})

test('已经有清单 → 只回显清单，不提醒补列', async () => {
  resetState('dev')
  todo.updateTodos(CONV, [{ text: '改表格页', status: 'in_progress' }])
  const requests = []
  currentFetch = makeFetch(requests, 5)
  await chat.handleChatSend(event(), payloadKeepTodos())
  for (const r of requests.filter((x) => x.tools)) {
    assert.equal(planNudges(r).length, 0, '有清单时不该出现补列提醒')
    assert.ok(todoMsgs(r).length >= 1, '仍应回显清单')
  }
})

test('settings.todosEnabled = false → 不提醒（与工具下发同一个开关）', async () => {
  resetState('dev')
  stateStub.settings.todosEnabled = false
  const requests = []
  currentFetch = makeFetch(requests, 5)
  await chat.handleChatSend(event(), payload())
  for (const r of requests) {
    assert.equal(planNudges(r).length, 0, '关掉任务清单后不该提醒')
  }
})
