// 收口闸门的**接线**测试（electron/todo-gate.js 的纯逻辑在 tests/todo-gate.test.js）。
//
// 这里要锁的是真实事故里的那条路径（2026-10-18，会话 mvb0y3nlk4ru）：
//   模型跑完一堆 read_file 之后直接输出"完工报告"，正文写着新增了 N 个文件，
//   工具台账里 0 条写盘 —— 旧内核在 `if (toolCalls.length === 0) break` 处无条件放行，
//   endReason 记成 complete，右下角还弹「任务完成」。
//
// 六个用例：
//   1) 清单有未完成项 → 回推提醒（最多 2 次）→ endReason=unfinished_todos（不再报完成）
//   2) 清单全部完成 → 一次放行，endReason=complete
//   3) 正文声称改动但 0 次写盘 → 回推一次核对提醒
//   4) 本轮真写过盘 → 不触发核对
//   5) 回推不造出连续两条 user 消息（部分网关直接 400）
//   6) 回推通过 chat:status(type=todo_gate) 让用户看得见
// 另加自检核对（P0-3，2026-10-24）三条：
//   7) 声称"验证通过"但没跑校验 → 回推一次后放行
//   8) 真跑过一条 exitCode=0 的校验命令 → 不回推
//   9) 校验命令跑挂了（exitCode≠0）→ 仍算"没验证过"
//
// chat.js 是 CJS 且加载即 require('electron')，故先把依赖塞进 require.cache。
// 桩列表与 update-todos-inject.test.js / tool-loop-budget.test.js 保持一致。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const CHAT = path.join(__dirname, '..', 'electron', 'chat.js')

const stub = (request, exports) => {
  const id = require.resolve(request, { paths: [path.dirname(CHAT)] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

const TOOLS_DEFINITION = [
  { type: 'function', function: { name: 'read_file', description: 'x', parameters: {} } },
  { type: 'function', function: { name: 'write_file', description: 'w', parameters: {} } },
  { type: 'function', function: { name: 'update_todos', description: 'y', parameters: {} } },
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
// execute_command 的模拟退出码（自检核对按 exitCode===0 计数）。用例可临时改成 1 模拟"校验跑挂"。
// ⚠️ 不能用"事后改 stub.exports"的方式注入：chat.js 在加载期就解构了 executeToolCall，
//    改 exports 不会生效 —— 必须让 stub 闭包读这个变量。
let commandExitCode = 0

stub('./tools', {
  executeToolCall: async (tc) => {
    executed.push(tc.function.name)
    // execute_command 的返回是**扁平结构**（tools/shell.js 直接 stringify payload）：
    // 自检核对（P0-3）按 exitCode === 0 计数，所以这里必须给真形状，不能套 result。
    if (tc.function.name === 'execute_command') {
      return JSON.stringify({ success: true, stdout: 'ok', stderr: '', exitCode: commandExitCode, killed: false, timedOut: false })
    }
    return JSON.stringify({ success: true, result: { path: 'C:/game/Assets/Scripts/ModelLib.cs', created: true } })
  },
  killAllChildren: () => {},
})
stub('./sub-agent', { abortSubAgentsForConversation: () => {} })
stub('./xl-work', { newRunWorkDir: () => '/tmp/xl-work', scheduleCleanup: () => {}, pruneRootLeftovers: () => 0 })
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

/** 前 toolRounds 次返回一个工具调用（默认 read_file），之后一直返回正文收尾。 */
function makeFetch(requests, { toolRounds = 0, toolName = 'read_file', toolArgs = null, text = '改完了，改了 2 个文件。' } = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push(body)

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
                  function: { name: toolName, arguments: JSON.stringify(toolArgs || { path: `C:/game/Assets/Scripts/ModelLib.cs`, content: 'x' }) },
                }],
              },
            }],
          }),
          sseLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
          'data: [DONE]\n\n',
        ]
      : [
          sseLine({ choices: [{ delta: { content: text } }] }),
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

const find = (ev, ch) => ev.sent.filter((x) => x.ch === ch).map((x) => x.payload)
const doneOf = (ev) => find(ev, 'chat:done').pop()
const gateMsgs = (req) =>
  (req.messages || []).filter((m) => typeof m.content === 'string' && m.content.includes('【收口核对'))

const CONV = 'conv-todo-gate'
const payload = () => ({
  conversationId: CONV,
  messages: [{ role: 'user', content: '把这批 3D 素材接进游戏' }],
  profileId: 'test-profile',
  autoExecute: true,
  resumeTurn: true,   // 「继续」语义：不清空上一轮清单
})

function resetState(todos) {
  executed.length = 0
  stateStub.settings = { allowedDirs: [], role: 'dev', autoExecute: true, subAgentsEnabled: false }
  stateStub.chatRuns = new Map()
  stateStub.todos = new Map()
  todo.clearTodos(CONV)
  if (todos) todo.updateTodos(CONV, todos)
}

const OPEN = [
  { text: '备份工程 + 拷贝 3D 素材', status: 'completed' },
  { text: '新增 ModelLib.cs', status: 'in_progress' },
  { text: '跑编译自检', status: 'pending' },
]

// ============================================================

test('清单还有未完成项：回推 ≤2 次后仍不收尾 → endReason=unfinished_todos（不再报"完成"）', async () => {
  resetState(OPEN)
  const requests = []
  currentFetch = makeFetch(requests, { toolRounds: 0 })
  const ev = event()
  await chat.handleChatSend(ev, payload())

  // 第一次正文 → 闸门回推；第二次正文 → 再回推；第三次正文 → 用尽放行
  assert.equal(requests.length, 3, `应回推 2 次后放行，实测 ${requests.length} 次请求`)
  assert.ok(gateMsgs(requests[1]).length >= 1, '第二次请求里应带上收口核对提醒')
  assert.match(
    String(requests[1].messages[requests[1].messages.length - 1].content),
    /任务清单还有 2 项未完成/,
    '提醒必须落在请求末尾（追加而非改写，前缀缓存友好）'
  )
  assert.match(String(requests[1].messages.at(-1).content), /新增 ModelLib\.cs/, '未完成项要点名')

  const done = doneOf(ev)
  assert.ok(done, '应发出 chat:done')
  assert.equal(done.endReason, 'unfinished_todos', '不能记成 complete —— 否则系统通知会说"任务完成"')
  assert.match(done.endDetail, /还有 2 项未完成/)
  assert.match(done.endDetail, /点「继续」/)
})

test('清单全部完成 → 一次放行，endReason=complete，不多发请求', async () => {
  resetState([
    { text: '备份工程', status: 'completed' },
    { text: '接线 ModelFactory', status: 'completed' },
  ])
  const requests = []
  // ⚠️ 正文刻意**不提**"验证通过"：自检核对（P0-3）会把"声称验证过但没跑校验"也拦下来，
  // 那是另一个用例的事。这里只验证"清单全完成 → 放行"。
  currentFetch = makeFetch(requests, { toolRounds: 0, text: '两个文件都改完了。' })
  const ev = event()
  await chat.handleChatSend(ev, payload())

  assert.equal(requests.length, 1, '清单全完成时不该回推')
  assert.equal(doneOf(ev).endReason, 'complete')
})

test('正文声称改了文件、但本次运行 0 次写盘 → 回推一次"没有任何写盘调用"', async () => {
  resetState(null)   // 没有清单，单独验证写盘核对
  const requests = []
  currentFetch = makeFetch(requests, { toolRounds: 1, toolName: 'read_file', text: '已新增 `ModelLib.cs`，并重写了 `SpriteLib.cs` 的开关。' })
  const ev = event()
  await chat.handleChatSend(ev, payload())

  assert.equal(requests.length, 3, '1 轮读文件 + 1 次正文 + 1 次回推后收尾')
  assert.equal(gateMsgs(requests[2]).length, 1, '第三请求里应带写盘核对提醒')
  assert.match(String(requests[2].messages.at(-1).content), /本次运行没有任何写盘调用/)
  // 只回推一次：再多就会变成"模型反复解释"的烧 token 循环
  assert.equal(doneOf(ev).endReason, 'complete', '没有清单时按正常完成收尾（核对的目的是让它补写）')
})

test('本轮真的调用过 write_file → 不触发写盘核对', async () => {
  resetState(null)
  const requests = []
  currentFetch = makeFetch(requests, { toolRounds: 1, toolName: 'write_file', text: '已新增 `ModelLib.cs`。' })
  const ev = event()
  await chat.handleChatSend(ev, payload())

  assert.equal(requests.length, 2, '写盘 + 正文，不应回推')
  assert.equal(gateMsgs(requests[1]).length, 0)
  assert.equal(executed.includes('write_file'), true, '前置：write_file 确实执行了')
})

test('回推不造出连续两条 user 消息（否则部分 OpenAI 兼容网关直接 400）', async () => {
  resetState(OPEN)
  const requests = []
  currentFetch = makeFetch(requests, {
    toolRounds: 1,
    toolName: 'read_file',
    text: '已重写 `SpriteLib.cs`。',
  })
  const ev = event()
  await chat.handleChatSend(ev, payload())

  assert.ok(requests.length >= 3, '至少应有：读文件 / 正文 / 回推后请求')
  for (const [i, r] of requests.entries()) {
    const ms = r.messages || []
    for (let k = 1; k < ms.length; k++) {
      assert.ok(
        !(ms[k].role === 'user' && ms[k - 1].role === 'user'),
        `第 ${i + 1} 个请求里出现连续两条 user 消息（第 ${k} 条）`
      )
    }
    // assistant(tool_calls) 之后必须紧跟等量 tool 消息
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

test('回推时通过 chat:status(type=todo_gate) 告知渲染层，用户看得见"在核对"', async () => {
  resetState(OPEN)
  const requests = []
  currentFetch = makeFetch(requests, { toolRounds: 0 })
  const ev = event()
  await chat.handleChatSend(ev, payload())

  const gates = find(ev, 'chat:status').filter((s) => s.type === 'todo_gate')
  assert.equal(gates.length, 2, '两次回推各推一次状态')
  assert.match(gates[0].message, /清单还有 2 项未完成/)
  assert.match(gates[0].message, /不要当作已完成/)
})

// ---------------- 自检核对（P0-3，2026-10-24） ----------------
// 要证明的是「正文声称」与「工具台账」是被真连起来的：
//   声称"测试通过" → 台账里 0 条成功校验 → 回推一次；
//   真跑过一条 exitCode=0 的校验命令 → 不再回推。

test('声称"验证通过"但本次运行没跑任何校验 → 回推一次，然后放行', async () => {
  resetState(null)   // 无清单，排除清单闸门干扰
  const requests = []
  currentFetch = makeFetch(requests, { toolRounds: 0, text: '已经改好了，测试全部通过。' })
  const ev = event()
  await chat.handleChatSend(ev, payload())

  assert.equal(requests.length, 2, '应回推 1 次后放行，实测 ' + requests.length + ' 次')
  assert.match(String(requests[1].messages.at(-1).content), /声称验证过/)
  assert.match(String(requests[1].messages.at(-1).content), /0 条成功的校验命令/)
  assert.equal(doneOf(ev).endReason, 'complete', '只给 1 次机会，用尽后按正常完成收尾')
})

test('真跑过一条 node --check（exitCode=0）再声称通过 → 不回推', async () => {
  resetState(null)
  const requests = []
  currentFetch = makeFetch(requests, {
    toolRounds: 1,
    toolName: 'execute_command',
    toolArgs: { command: 'node --check electron/chat.js' },
    text: '已经改好了，node --check 通过。',
  })
  const ev = event()
  await chat.handleChatSend(ev, payload())

  assert.deepEqual(executed, ['execute_command'], '应当真的调过一次命令')
  assert.equal(requests.length, 2, '1 轮工具 + 1 次正文收尾，不该有第三次')
  assert.equal(gateMsgs(requests[1]).length, 0, '有成功校验记录时不该回推')
  assert.equal(doneOf(ev).endReason, 'complete')
})

test('命令跑挂了（exitCode≠0）不能算"验证过"', async () => {
  commandExitCode = 1   // 模拟 node --check 报语法错退出
  try {
    resetState(null)
    const requests = []
    currentFetch = makeFetch(requests, {
      toolRounds: 1,
      toolName: 'execute_command',
      toolArgs: { command: 'node --check electron/chat.js' },
      text: '测试通过。',
    })
    const ev = event()
    await chat.handleChatSend(ev, payload())

    assert.equal(requests.length, 3, '跑挂的校验不算数 → 仍要回推一次')
    assert.match(String(requests[2].messages.at(-1).content), /声称验证过/)
  } finally {
    commandExitCode = 0
  }
})
