// 工具执行编排（并发 / 串行分流）与 dev 工具白名单的回归测试
//
// 背景：chat.js 原先用一个 for-of 串行执行一轮内的所有工具调用 —— 模型一轮里要读 5 个文件
// 就得排队 5 次（grep_code 单次 1.6~2.3s），这段墙钟时间与模型无关、纯属白等。
// 2026-09-30 改成「能并发的并发、必须串行的按原顺序」：
//   · 串行组：ask_user / 子 Agent 两个工具 / 需弹原生确认框的命令 / browser_*（共享同一个测试窗口）
//   · 其余（读文件、检索、写文件、自动放行的命令…）并发
// 结果一律按 tool_calls 原下标回填 —— tool 消息顺序与 tool_calls 不一致时部分网关会 400。
//
// 本文件锁住 4 条不变量：
//   1) 一轮内多个独立工具**真的并发**（执行区间重叠），且结果仍按 tool_calls 原顺序回填
//   2) dev 角色只发白名单内的工具（其余角色不受影响）
//   3) 串行组独占执行：browser_* 两两不重叠，且整组排在并发组之后
//   4) 重复调用拦截语义不变（同参数连续第 3 次起不执行）
//
// 桩法与 chat-abort.test.js 一致：把依赖塞进 require.cache 后再 require chat.js。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const CHAT = path.join(__dirname, '..', 'electron', 'chat.js')
const CONV = 'conv-tool-parallel'
// 工具活动台账的落点（chat.js 会把每轮工具调用写进 userData/conversations/<id>.activity.json）
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-parallel-'))

// ---- 可注入的桩行为 ----
let currentFetch = null
let currentCompact = null
let currentExec = null
let currentConfirm = null
const sent = []
const killed = []
const bodies = []      // 每轮请求体（用于断言实际发出的 tools）
const execLog = []     // 工具执行记录：{ name, args, start, end }
const confirmCalls = []
const handlers = {}
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

// 假工具集：覆盖"并发组 + 串行组 + 被 dev 白名单剔除"三类
const FAKE_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'grep_code',
  'execute_command', 'ask_user', 'spawn_sub_agent',
  'browser_click', 'read_file',
].map((name) => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
}))

stub('electron', {
  // 工具活动台账（tool-activity.js）要经 app.getPath('userData') 定位 sidecar
  app: { getPath: () => USERDATA },
  ipcMain: {
    handle: (ch, fn) => { handlers[ch] = fn },
    on: (ch, fn) => { handlers[ch] = fn },
  },
  // 守卫弹框：默认放行（response 0 = 第一个按钮）
  dialog: { showMessageBox: async (...a) => (currentConfirm ? currentConfirm(...a) : { response: 0 }) },
  BrowserWindow: {
    fromWebContents: () => ({ isDestroyed: () => false }),
    getAllWindows: () => [],
  },
})
stub('./state', stateStub)
stub('./tool-schemas', { TOOLS_DEFINITION: FAKE_TOOLS })
// describeFetchError 等其余导出走真实实现（chat.js 失败收尾时用它格式化原因）；须在 stub 之前 require
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
  executeToolCall: async (tc, _ctx) => {
    const name = tc.function.name
    const args = tc.function.arguments
    const start = Date.now()
    let out
    try {
      out = currentExec ? await currentExec(name, args) : 'ok'
    } catch (e) {
      out = 'tool error: ' + e.message
    }
    execLog.push({ name, args, start, end: Date.now() })
    return typeof out === 'string' ? out : JSON.stringify(out)
  },
  killAllChildren: () => killed.push(Date.now()),
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
chat.registerIpc()

// ---- 辅助 ----
const sse = (obj) => `data: ${JSON.stringify(obj)}\n`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const eventsOf = (ch) => sent.filter((e) => e.ch === ch)
const doneEvents = () => eventsOf('chat:tool').filter((e) => e.payload.status === 'done')
const argsOf = (e) => JSON.parse(e.payload.args || '{}')
// toolCalls 事件用一次给全的方式（chat.js 对 arguments 是累加字符串，一次给全等价）
const tcChunk = (list) => sse({
  choices: [{
    delta: {
      tool_calls: list.map((t, i) => ({
        index: i,
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.args || {}) },
      })),
    },
    finish_reason: 'tool_calls',
  }],
})
const stopChunk = (text = '已完成') => sse({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })

// rounds: 每轮的 chunk 数组；用尽后自动返回一个 stop 收尾
function mockFetch(rounds) {
  return async (_url, init) => {
    bodies.push(init && init.body ? JSON.parse(init.body) : null)
    const chunks = rounds.length
      ? rounds.shift()
      : [stopChunk()]
    let i = 0
    const enc = new TextEncoder()
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length
            ? { done: false, value: enc.encode(chunks[i++]) }
            : { done: true, value: undefined }),
        }),
      },
    }
  }
}

function makeEvent() {
  return { sender: { send: (ch, payload) => sent.push({ ch, payload }) } }
}

const payload = () => ({
  conversationId: CONV,
  messages: [{ role: 'user', content: '改一下这个页面' }],
  profileId: 'test-profile',
  autoExecute: true,
})

test.beforeEach(() => {
  sent.length = 0
  killed.length = 0
  bodies.length = 0
  execLog.length = 0
  confirmCalls.length = 0
  stateStub.chatRuns = new Map()
  stateStub.settings = { allowedDirs: [], role: 'dev', autoExecute: true, subAgentsEnabled: true }
  currentFetch = null
  currentCompact = async () => null
  currentExec = async () => 'ok'
  currentConfirm = null
})

test('一轮内多个独立工具并发执行，结果仍按 tool_calls 原顺序回填', async () => {
  // 三个 read_file：a 最慢 30ms、b 20ms、c 10ms —— 并发时完成顺序必然是 c→b→a，
  // 而回填（即 UI 看到 done 的顺序）必须仍是 a→b→c。
  const delay = { 'a.md': 30, 'b.md': 20, 'c.md': 10 }
  currentExec = async (_name, args) => {
    const a = JSON.parse(args || '{}')
    await sleep(delay[a.path] || 0)
    return `content of ${a.path}`
  }
  currentFetch = mockFetch([
    [tcChunk([
      { id: 'call_a', name: 'read_file', args: { path: 'a.md' } },
      { id: 'call_b', name: 'read_file', args: { path: 'b.md' } },
      { id: 'call_c', name: 'read_file', args: { path: 'c.md' } },
    ])],
  ])

  await chat.handleChatSend(makeEvent(), payload())

  const reads = execLog.filter((e) => e.name === 'read_file')
  assert.equal(reads.length, 3, '三个工具都该执行')

  // ① 真的并发了：三个执行区间必须重叠
  const maxStart = Math.max(...reads.map((e) => e.start))
  const minEnd = Math.min(...reads.map((e) => e.end))
  assert.ok(maxStart < minEnd, `三个 read_file 的执行区间应重叠（并发），实测不重叠 → 退化成串行了`)

  // ② 串行的话总墙钟 ≥60ms；并发 ≈30ms。用宽松阈值兜住机器抖动
  const window = Math.max(...reads.map((e) => e.end)) - Math.min(...reads.map((e) => e.start))
  assert.ok(window < 60, `并发执行的总窗口应明显小于串行（实测 ${window}ms）`)

  // ③ 完成顺序 ≠ 回填顺序（最慢的 a 不可能第一个完成）
  assert.notEqual(JSON.parse(execLog[0].args).path, 'a.md', '最慢的那个不该最先完成 → 说明没并发')

  // ④ 回填顺序仍严格等于 tool_calls 顺序
  assert.deepEqual(
    doneEvents().map((e) => argsOf(e).path),
    ['a.md', 'b.md', 'c.md'],
    'done 事件（= tool 消息回填顺序）必须与 tool_calls 顺序一致，否则部分网关 400',
  )
  // 结果内容也按序落进 tool 消息：第二个工具的结果带"重复警告"以外的原文即可
  assert.equal(eventsOf('chat:done').length, 1)
})

test('dev 角色只发白名单工具，其它角色不受影响', async () => {
  currentFetch = mockFetch([[stopChunk('好的')]])

  // dev：收窄到白名单
  await chat.handleChatSend(makeEvent(), payload())
  const devTools = bodies[0].tools.map((t) => t.function.name)
  assert.ok(!devTools.includes('browser_click'), 'dev 不该收到 browser_* 工具')
  assert.ok(!devTools.includes('read_file'), 'dev 不该收到 ERP 工具')
  assert.ok(devTools.includes('read_file') && devTools.includes('edit_file'), 'dev 必须保留改码工具')
  assert.ok(devTools.includes('execute_command'), 'dev 必须保留 execute_command')
  assert.ok(devTools.every((n) => [
    'read_file', 'write_file', 'edit_file', 'list_directory', 'delete_file',
    'grep_code', 'glob_files', 'execute_command',
    'list_skills', 'read_skill', 'write_skill',
    'list_memories', 'read_memory', 'write_memory',
    'search_web', 'ask_user', 'spawn_sub_agent', 'get_sub_agent_results',
  ].includes(n)), 'dev 收到的工具必须全部在白名单内')

  // product：不收窄（browser/erp 照旧下发）
  sent.length = 0
  bodies.length = 0
  stateStub.chatRuns = new Map()
  stateStub.settings = { allowedDirs: [], role: 'product', autoExecute: true, subAgentsEnabled: true }
  await chat.handleChatSend(makeEvent(), payload())
  const pmTools = bodies[0].tools.map((t) => t.function.name)
  assert.ok(pmTools.includes('browser_click') && pmTools.includes('read_file'), '非 dev 角色的工具集不该被收窄')
})

test('串行组独占执行：browser_* 互不重叠，且整组排在并发组之后', async () => {
  stateStub.settings.role = 'qa'
  currentExec = async (name) => {
    await sleep(name.startsWith('browser_') ? 25 : 5)
    return name + ' ok'
  }
  currentFetch = mockFetch([
    [tcChunk([
      { id: 'c1', name: 'browser_click', args: { ref: 1 } },
      { id: 'c2', name: 'read_file', args: { path: 'x.md' } },
      { id: 'c3', name: 'browser_click', args: { ref: 2 } },
    ])],
  ])

  await chat.handleChatSend(makeEvent(), payload())

  const b1 = execLog.find((e) => e.args.includes('"ref":1'))
  const b2 = execLog.find((e) => e.args.includes('"ref":2'))
  const rd = execLog.find((e) => e.name === 'read_file')
  assert.ok(b1 && b2 && rd, '三个工具都该执行')

  // browser_* 共享同一个测试窗口，必须一个跑完再跑下一个
  assert.ok(b2.start >= b1.end, '两个 browser_click 不得重叠（共享测试窗口，并发会乱）')
  // 并发组先跑完，串行组后跑
  assert.ok(rd.end <= b1.start, '并发的 read_file 应在串行的 browser_* 之前完成')

  // 回填顺序依旧按 tool_calls 原顺序
  assert.deepEqual(doneEvents().map((e) => argsOf(e)), [{ ref: 1 }, { path: 'x.md' }, { ref: 2 }])
})

test('重复调用拦截语义不变：同参数连续第 3 次不执行', async () => {
  currentFetch = mockFetch([
    [tcChunk([
      { id: 'r1', name: 'read_file', args: { path: 'same.md' } },
      { id: 'r2', name: 'read_file', args: { path: 'same.md' } },
      { id: 'r3', name: 'read_file', args: { path: 'same.md' } },
    ])],
  ])

  await chat.handleChatSend(makeEvent(), payload())

  assert.equal(execLog.filter((e) => e.name === 'read_file').length, 2, '第 3 次同参数调用不该执行')
  // 警告与拦截说明只写进"发给 API 的消息"（前端展示与快照还原仍是原文）
  const toolMsgs = bodies[1].messages.filter((m) => m.role === 'tool')
  assert.equal(toolMsgs.length, 3, '三次 tool_calls 都要有对应的 tool 消息，否则接口 400')
  assert.ok(toolMsgs[1].content.includes('【注意】'), '第 2 次重复应附带警告')
  assert.ok(toolMsgs[2].content.includes('重复调用被拦截'), '第 3 次应被拦下并回传说明')
  assert.ok(!doneEvents()[1].payload.result.includes('【注意】'), '警告不该污染前端展示与快照原文')
})

test('写盘类工具与 execute_command 同轮时，命令必须在写盘之后执行', async () => {
  // 背景（2026-10-04）：execute_command 原先与 edit_file 同属并发组，
  // 命令完全可能在编辑落盘之前跑完 —— 测到改动前的旧代码，exitCode:0 被模型
  // 当成"改动验证通过"。这是静默的错误归因，必须在编排层堵住。
  stateStub.settings.role = 'qa' // 非 dev 更干净（不吃 guard 分支）
  currentExec = async (name) => {
    await sleep(name === 'edit_file' ? 40 : 10)
    return name + ' ok'
  }
  currentFetch = mockFetch([
    [tcChunk([
      { id: 'w1', name: 'edit_file', args: { path: 'a.vue', old_string: 'x', new_string: 'y' } },
      { id: 'e1', name: 'execute_command', args: { command: 'npm test' } },
    ])],
  ])

  await chat.handleChatSend(makeEvent(), payload())

  const wr = execLog.find((e) => e.name === 'edit_file')
  const cmd = execLog.find((e) => e.name === 'execute_command')
  assert.ok(wr && cmd, '两个工具都该执行')
  assert.ok(
    cmd.start >= wr.end,
    `execute_command 必须等 edit_file 落盘后才能跑（edit 结束于 ${wr.end}，命令开始于 ${cmd.start}）`,
  )
  // 回填顺序仍严格等于 tool_calls 顺序
  assert.deepEqual(doneEvents().map((e) => e.payload.name), ['edit_file', 'execute_command'])
})

test('每轮工具调用会写进「工具活动台账」（压缩时摘要器靠它知道做了什么）', async () => {
  // 渲染层落盘的历史只有 { role, content }，工具活动不在里面 —— 所以压缩前必须靠这条 sidecar。
  // 这里验证 chat.js 真的把本轮的工具调用写进去了（写了什么由 tests/tool-activity.test.js 细测）。
  const sidecar = path.join(USERDATA, 'conversations', `${CONV}.activity.json`)
  fs.rmSync(sidecar, { force: true })

  stateStub.settings.role = 'qa'
  currentExec = async (name) => `${name} ok`
  currentFetch = mockFetch([
    [tcChunk([
      { id: 'act1', name: 'read_file', args: { path: 'src/pages/order/index.vue' } },
      { id: 'act2', name: 'execute_command', args: { command: 'npm test' } },
    ])],
  ])

  await chat.handleChatSend(makeEvent(), payload())

  assert.equal(fs.existsSync(sidecar), true, '台账 sidecar 应被写入')
  const data = JSON.parse(fs.readFileSync(sidecar, 'utf-8'))
  const tools = data.entries.map((e) => e.tool)
  assert.ok(tools.includes('read_file') && tools.includes('execute_command'), `台账应含本轮工具，实际：${JSON.stringify(tools)}`)
  assert.ok(
    data.entries.some((e) => String(e.target).includes('src/pages/order/index.vue')),
    '台账要带上具体目标（文件路径），否则压缩后模型只知道"读过文件"、不知道读的是哪个',
  )
  fs.rmSync(sidecar, { force: true })
})

test('思考模式恒开启：请求体一律不带 thinking 参数（无开关）', async () => {
  // 1) settings 里没有这个字段（老配置）→ 不带
  currentFetch = mockFetch([[stopChunk('好的')]])
  await chat.handleChatSend(makeEvent(), payload())
  assert.equal(bodies[0].thinking, undefined, '默认必须不带该参数')

  // 2) settings 里残留旧开关值（false）→ 依然不带（主进程已不再读该字段）
  sent.length = 0
  bodies.length = 0
  stateStub.chatRuns = new Map()
  stateStub.settings.thinkingEnabled = false
  currentFetch = mockFetch([[stopChunk('好的')]])
  await chat.handleChatSend(makeEvent(), payload())
  assert.equal(bodies[0].thinking, undefined, '「思考」开关已删除，遗留的 false 不得再压掉思考阶段')

  // 3) 其余请求体字段不受影响
  assert.equal(bodies[0].stream, true, '其它请求体字段不受影响')
  assert.equal(bodies[0].tool_choice, 'auto')
  assert.ok(Array.isArray(bodies[0].tools) && bodies[0].tools.length > 0)
})
