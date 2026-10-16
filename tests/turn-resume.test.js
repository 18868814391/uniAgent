// 断点续跑（turn-snapshot）回归测试
//
// 背景（真实痛点）：渲染层发给主进程的 history 只有 { role, content } —— 工具调用与工具结果
// 从不落盘，主进程的工具结果只活在单次请求的局部变量 currentMessages 里。于是中断后点「继续」，
// 主进程只能用纯文本历史重建请求：模型看不到任何工具结果，"不要重复已完成的步骤"这句话它无从遵守，
// 最合理的动作就是把已经跑过的工具再跑一遍（还可能撞上"脚本被 kill、文件只写了一半"的残留状态）。
//
// 本文件锁住四条不变量：
//   1) 中断时把"那一轮"完整落盘（含 assistant.tool_calls 与 tool 结果）
//   2) 回放前必须修好工具序列：缺结果的 tool_call 补 interrupted 占位，孤儿 tool 消息丢弃
//      —— 否则服务端会因为"assistant.tool_calls 缺少对应 tool 结果"直接 400
//   3) 命中快照续跑时，上一轮已成功的工具**不再执行第二次**，且模型能看到上一轮的真实工具结果
//   4) 历史被改过 / 本轮没调过工具 / 已正常完成 → 一律不留或不用快照（不许误命中）
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const ELECTRON_DIR = path.join(__dirname, '..', 'electron')
const CHAT = path.join(ELECTRON_DIR, 'chat.js')

// userData 指到临时目录：快照文件落这儿，测试之间互不干扰
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-turn-'))

// ---- 桩 ----
const handlers = {}
const sent = []
const killed = []
const toolRuns = new Map()      // 工具名 → 执行次数（核心断言：续跑后不能再涨）
let compactCalls = 0            // 压缩调用次数（续跑必须跳过压缩）
let fetchScript = []            // 每轮 fetch 的剧本：{ chunks } 或 { block: true }
let capturedBodies = []         // 每次请求的请求体（断言模型到底看到了什么）

const stateStub = {
  settings: { allowedDirs: [], role: 'general', autoExecute: true, subAgentsEnabled: false },
  chatRuns: new Map(),
  askSeq: 0,
  subAgents: new Map(),
  subAgentsPending: new Map(),
  mainWindow: null,
}

const stub = (request, exports) => {
  const id = require.resolve(request, { paths: [ELECTRON_DIR] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

const electronStub = {
  ipcMain: {
    handle: (ch, fn) => { handlers[ch] = fn },
    on: (ch, fn) => { handlers[ch] = fn },
  },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }), getAllWindows: () => [] },
  app: { getPath: () => userDataDir },
}
stub('electron', electronStub)
stub('./state', stateStub)
stub('./tool-schemas', { TOOLS_DEFINITION: [] })
// describeFetchError 等其余导出走真实实现（chat.js 失败收尾时用它格式化原因）；须在 stub 之前 require
const realNetRetry = require(path.join(__dirname, '..', 'electron', 'net-retry.js'))
stub('./net-retry', { ...realNetRetry, fetchWithRetry: (...args) => dispatchFetch(...args) })
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
  maybeCompactHistory: async () => { compactCalls++; return null },
})
stub('./tools/fs-safe', {
  buildImageParts: async () => [],
  addImagePartsToLatestUser: (msgs) => msgs,
  imageMimeForPath: () => null,
})
stub('./tools', {
  executeToolCall: async (tc) => {
    const name = (tc && tc.function && tc.function.name) || 'unknown'
    toolRuns.set(name, (toolRuns.get(name) || 0) + 1)
    if (name === 'read_file') {
      return JSON.stringify({ success: true, path: 'a.md', data: 'FILE_CONTENT' })
    }
    return JSON.stringify({ success: true })
  },
  killAllChildren: () => killed.push(Date.now()),
})
stub('./sub-agent', { abortSubAgentsForConversation: () => {} })
stub('./xl-work', { newRunWorkDir: () => path.join(userDataDir, 'xl-work'), scheduleCleanup: () => {}, pruneRootLeftovers: () => 0 })
// 孤儿进程清扫：测试里绝不真去枚举系统进程表（慢 400ms+，而且在有真孤儿的机器上会真杀进程）
stub('./tools/orphan-cleanup', { killOrphanScriptProcesses: async () => ({ found: 0, killed: [] }) })

// 这两个模块用真实实现：本文件要测的就是快照的落盘/校验/回放
const turnSnapshot = require(path.join(ELECTRON_DIR, 'turn-snapshot.js'))
const chat = require(CHAT)
chat.registerIpc()

// ---- 辅助 ----
const sse = (obj) => `data: ${JSON.stringify(obj)}\n`

function streamResponse(chunks) {
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

// 卡住的响应：直到 signal 被 abort 才像真 fetch 一样抛 AbortError
function blockingResponse(signal) {
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: () =>
          new Promise((_res, rej) => {
            const onAbort = () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            if (signal && signal.aborted) return onAbort()
            if (signal) signal.addEventListener('abort', onAbort, { once: true })
          }),
      }),
    },
  }
}

function dispatchFetch(_url, init) {
  capturedBodies.push(JSON.parse(init.body))
  const step = fetchScript.shift()
  if (!step) throw new Error('fetch 剧本已用尽（用例的轮次预期不对）')
  if (step.block) return Promise.resolve(blockingResponse(init && init.signal))
  return Promise.resolve(streamResponse(step.chunks))
}

// 一轮"模型要求调工具"的响应
function toolRound(id, name, args) {
  return [
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }),
  ]
}

// 一轮"模型给出最终回答"的响应
function textRound(text) {
  return [sse({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } })]
}

const makeEvent = () => ({ sender: { send: (ch, payload) => sent.push({ ch, payload }) } })
const eventsOf = (ch) => sent.filter((e) => e.ch === ch)

async function waitFor(predicate, { tries = 300 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 0))
  }
  throw new Error('waitFor: 条件未在预期内满足')
}

const payloadOf = (convId, messages) => ({ conversationId: convId, messages, profileId: 'test-profile', autoExecute: true })

const NUDGE = '请继续完成你刚才正在进行的任务，不要重复已完成的步骤，直接继续执行。'
const snapshotPath = (convId) => turnSnapshot.getSnapshotPath(convId)

test.beforeEach(() => {
  sent.length = 0
  killed.length = 0
  toolRuns.clear()
  capturedBodies = []
  fetchScript = []
  compactCalls = 0
  stateStub.chatRuns = new Map()
})

// ============================================================
//  一、快照模块单测（落盘 / 校验 / 修复）
// ============================================================

test('快照落盘后可读回；历史一致才可续跑', () => {
  const convId = 'unit-1'
  turnSnapshot.clearTurnSnapshot(convId)
  const history = [{ role: 'user', content: '读一下 a.md' }]
  const ok = turnSnapshot.saveTurnSnapshot(convId, {
    messages: [
      { role: 'user', content: '读一下 a.md' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"success":true}' },
    ],
    historyCount: history.length,
    inputHash: turnSnapshot.hashHistory(history),
    abortedBy: 'user',
    endReason: 'aborted',
  })
  assert.equal(ok, true)
  assert.equal(fs.existsSync(snapshotPath(convId)), true)
  assert.equal(turnSnapshot.hasResumableTurn(convId), true)

  // 命中：history 只多出一条「继续」指令
  const hit = turnSnapshot.loadResumableTurn(convId, { messages: [...history, { role: 'user', content: NUDGE }] })
  assert.ok(hit, '历史一致时应命中')

  // 命中：渲染层把半截 assistant 回答补进了历史（中断后 onChatDone 会这么干）
  const hit2 = turnSnapshot.loadResumableTurn(convId, {
    messages: [...history, { role: 'assistant', content: '我看一下…' }, { role: 'user', content: NUDGE }],
  })
  assert.ok(hit2, '末尾多出的半截 assistant 消息应被容忍')

  // 未命中：历史被改过
  const miss = turnSnapshot.loadResumableTurn(convId, {
    messages: [{ role: 'user', content: '换个问题' }, { role: 'user', content: NUDGE }],
  })
  assert.equal(miss, null, '历史被改动后绝不能再命中（否则会回放到别的上下文里）')

  // 未命中：差了条数
  assert.equal(turnSnapshot.loadResumableTurn(convId, { messages: [{ role: 'user', content: NUDGE }] }), null)

  assert.equal(turnSnapshot.clearTurnSnapshot(convId), true)
  assert.equal(fs.existsSync(snapshotPath(convId)), false)
})

test('快照超期即失效并顺手清理', () => {
  const convId = 'unit-ttl'
  const history = [{ role: 'user', content: 'hi' }]
  turnSnapshot.saveTurnSnapshot(convId, {
    messages: [{ role: 'user', content: 'hi' }, { role: 'tool', tool_call_id: 'x', content: '{}' }],
    historyCount: 1,
    inputHash: turnSnapshot.hashHistory(history),
  })
  // 手动把 savedAt 改成过期
  const p = snapshotPath(convId)
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
  raw.savedAt = Date.now() - turnSnapshot.SNAPSHOT_TTL_MS - 1000
  fs.writeFileSync(p, JSON.stringify(raw), 'utf-8')

  assert.equal(turnSnapshot.hasResumableTurn(convId), false)
  const hit = turnSnapshot.loadResumableTurn(convId, { messages: [...history, { role: 'user', content: NUDGE }] })
  assert.equal(hit, null)
  assert.equal(fs.existsSync(p), false, '超期快照应顺手删掉，不留孤儿')
})

test('repairToolSequence：缺结果的 tool_call 补中断占位、孤儿 tool 消息丢弃、顺序按 tool_calls', () => {
  const msgs = [
    { role: 'user', content: 'go' },
    // 批量调用 3 个工具，只有第 2 个跑完就被中断了
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'list_directory', arguments: '{}' } },
        { id: 'c', type: 'function', function: { name: 'search_web', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'b', content: '{"success":true,"data":"LIST"}' },
    { role: 'tool', tool_call_id: 'ghost', content: '{"success":true}' },   // 孤儿：没有对应 tool_calls
  ]
  const { messages: out, total, repaired } = turnSnapshot.repairToolSequence(msgs)
  assert.equal(total, 3)
  assert.equal(repaired, 2)
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'tool'])
  assert.deepEqual(out.slice(2).map((m) => m.tool_call_id), ['a', 'b', 'c'], '必须按 tool_calls 顺序回填')
  assert.match(out[2].content, /interrupted/, '缺结果的工具必须标记为被中断，不能让模型以为成功了')
  assert.match(out[3].content, /LIST/, '已有结果原样保留')
  assert.match(out[4].content, /interrupted/)
  assert.ok(!out.some((m) => m.tool_call_id === 'ghost'), '孤儿 tool 消息必须丢弃')
})

test('repairToolSequence：system 不进回放序列（由调用方按当前开关重建）', () => {
  const { messages: out } = turnSnapshot.repairToolSequence([
    { role: 'system', content: 'stale system' },
    { role: 'user', content: 'hi' },
  ])
  assert.deepEqual(out, [{ role: 'user', content: 'hi' }])
})

// ============================================================
//  二、端到端：中断 → 继续
// ============================================================

// 跑一次"调了工具、然后被用户中断"的回合，返回 convId / history
async function abortTurnWithTool(convId, history) {
  fetchScript = [{ chunks: toolRound('call_1', 'read_file', '{"path":"a.md"}') }, { block: true }]
  const running = chat.handleChatSend(makeEvent(), payloadOf(convId, history))
  await waitFor(() => toolRuns.get('read_file') === 1 && stateStub.chatRuns.has(convId))
  handlers['chat:stop'](null, convId)
  await running
  return convId
}

test('中断留下快照（含真实工具结果），「继续」命中后工具不再跑第二遍', async () => {
  const convId = 'e2e-hit'
  const history = [{ role: 'user', content: '读一下 a.md' }]
  await abortTurnWithTool(convId, history)

  const done = eventsOf('chat:done')
  assert.equal(done.length, 1)
  assert.equal(done[0].payload.endReason, 'aborted')
  assert.equal(done[0].payload.abortedBy, 'user')
  assert.equal(done[0].payload.resumable, true, '中断时留下了可续跑快照 → 渲染层要给「继续」入口')

  const snap = JSON.parse(fs.readFileSync(snapshotPath(convId), 'utf-8'))
  assert.equal(snap.messages.length, 3, 'user + assistant(tool_calls) + tool 结果')
  assert.equal(snap.messages[1].tool_calls[0].id, 'call_1')
  assert.match(snap.messages[2].content, /FILE_CONTENT/)

  // ---- 用户点「继续」 ----
  capturedBodies = []
  compactCalls = 0   // 只统计本次（续跑）这一次请求
  fetchScript = [{ chunks: textRound('读完了：a.md 里是 FILE_CONTENT。') }]
  await chat.handleChatSend(makeEvent(), {
    ...payloadOf(convId, [...history, { role: 'user', content: NUDGE }]),
    resumeTurn: true,
  })

  const body = capturedBodies[0]
  assert.equal(compactCalls, 0, '续跑要保留的正是这些工具结果，不能走压缩')
  assert.equal(body.messages.length, 5, 'system + 上一轮 3 条 + 中断说明')
  assert.equal(body.messages[0].role, 'system')
  assert.match(body.messages[0].content, /^system/, 'system 由调用方重新构建（含最新开关状态）')
  assert.equal(body.messages[1].content, '读一下 a.md')
  assert.equal(body.messages[2].tool_calls[0].id, 'call_1')
  assert.equal(body.messages[3].role, 'tool')
  assert.match(body.messages[3].content, /FILE_CONTENT/, '模型必须能看到上一轮的真实工具结果')
  assert.equal(body.messages[4].role, 'user')
  assert.match(body.messages[4].content, /断点继续/)
  assert.equal(toolRuns.get('read_file'), 1, '上一轮已成功的工具绝不能再执行第二次')

  // 续跑正常收尾 → 快照清理
  assert.equal(eventsOf('chat:done').slice(-1)[0].payload.endReason, 'complete')
  assert.equal(fs.existsSync(snapshotPath(convId)), false)
})

// 带补充说明的「继续」（2026-10-04）：渲染层在中止横幅的输入框里写了要求，点「继续」一起发出。
// 这条路径的真实风险是**静默丢字**：命中快照时 chat.js 会把末尾那条 user 消息整条换成续跑提示，
// 用户写的补充说明如果不单独拼进来，模型一个字都看不到 —— 用户以为提了要求，其实没提。
test('带补充说明点「继续」：补充说明进到模型请求里，且工具仍不重跑', async () => {
  const convId = 'e2e-hit-note'
  const history = [{ role: 'user', content: '读一下 a.md' }]
  await abortTurnWithTool(convId, history)

  capturedBodies = []
  compactCalls = 0
  fetchScript = [{ chunks: textRound('好的，按补充说明调整完成。') }]
  // 渲染层的实际入参：正文 = 继续指令 + 标记 + 补充说明，同时经 resumeNote 显式传一份
  await chat.handleChatSend(makeEvent(), {
    ...payloadOf(convId, [
      ...history,
      { role: 'user', content: `${NUDGE}\n\n【本次补充说明】type 字段改成必填` },
    ]),
    resumeTurn: true,
    resumeNote: 'type 字段改成必填',
  })

  const body = capturedBodies[0]
  assert.equal(body.messages.length, 5, 'system + 上一轮 3 条 + 续跑提示')
  assert.match(body.messages[4].content, /断点继续/, '续跑提示照旧')
  assert.match(body.messages[4].content, /【用户本次补充说明/, '补充说明要有独立小标题，别混在续跑提示里')
  assert.match(body.messages[4].content, /type 字段改成必填/, '补充说明必须真的下发（这是本用例的核心）')
  assert.equal(
    body.messages.filter((m) => m.role === 'user').length,
    2,
    '只有 1 条尾部 user 消息 —— 另开一条会形成连续 user，部分网关直接 400',
  )
  assert.equal(toolRuns.get('read_file'), 1, '带补充说明续跑同样不该重跑已成功的工具')
  assert.equal(eventsOf('chat:done').slice(-1)[0].payload.endReason, 'complete')
})

test('带补充说明续跑：没显式传 resumeNote 时，从正文标记里兜底解析', async () => {
  const convId = 'e2e-hit-note-fallback'
  const history = [{ role: 'user', content: '读一下 a.md' }]
  await abortTurnWithTool(convId, history)

  capturedBodies = []
  fetchScript = [{ chunks: textRound('收到。') }]
  await chat.handleChatSend(makeEvent(), {
    ...payloadOf(convId, [
      ...history,
      { role: 'user', content: `${NUDGE}\n\n【本次补充说明】把弹窗标题也改一下` },
    ]),
    resumeTurn: true,
    // 刻意不传 resumeNote：模拟渲染层/主进程版本错配，兜底解析必须仍能救回补充说明
  })

  assert.match(capturedBodies[0].messages[4].content, /把弹窗标题也改一下/)
})

test('带补充说明续跑：resumeNote 为空串/纯空白时不产生空的补充段', async () => {
  const convId = 'e2e-hit-note-blank'
  const history = [{ role: 'user', content: '读一下 a.md' }]
  await abortTurnWithTool(convId, history)

  capturedBodies = []
  fetchScript = [{ chunks: textRound('继续完成。') }]
  await chat.handleChatSend(makeEvent(), {
    ...payloadOf(convId, [...history, { role: 'user', content: NUDGE }]),
    resumeTurn: true,
    resumeNote: '   ',
  })

  const tail = capturedBodies[0].messages[4]
  assert.match(tail.content, /断点继续/)
  assert.ok(!/【用户本次补充说明/.test(tail.content), '空白补充说明不该拼出一个空标题段')
})

test('历史被改动后「继续」：不误命中，退回重建历史（工具确实会重跑）', async () => {
  const convId = 'e2e-stale'
  const history = [{ role: 'user', content: '读一下 a.md' }]
  await abortTurnWithTool(convId, history)
  assert.equal(fs.existsSync(snapshotPath(convId)), true)

  capturedBodies = []
  compactCalls = 0   // 只统计本次（降级）这一次请求
  fetchScript = [
    { chunks: toolRound('call_9', 'read_file', '{"path":"a.md"}') },
    { chunks: textRound('好了。') },
  ]
  // 用户改了历史（等价于编辑重发/删了消息），指纹对不上
  await chat.handleChatSend(makeEvent(), {
    ...payloadOf(convId, [{ role: 'user', content: '读一下 b.md' }, { role: 'user', content: NUDGE }]),
    resumeTurn: true,
  })

  const body = capturedBodies[0]
  assert.equal(body.messages.length, 3, '退回普通流程：system + 原样 history')
  assert.ok(!body.messages.some((m) => m.role === 'tool'), '不该把别的上下文的工具结果塞进来')
  assert.equal(compactCalls, 1, '普通流程照常走压缩判断')
  assert.equal(toolRuns.get('read_file'), 2, '降级路径下工具只能重跑 —— 这正是本特性要消灭的行为')
})

test('本轮没调过工具（纯文本中断）不留快照，resumable=false', async () => {
  const convId = 'e2e-notext'
  const history = [{ role: 'user', content: '你好' }]
  fetchScript = [{ block: true }]
  const running = chat.handleChatSend(makeEvent(), payloadOf(convId, history))
  await waitFor(() => stateStub.chatRuns.has(convId))
  handlers['chat:stop'](null, convId)
  await running

  const done = eventsOf('chat:done')
  assert.equal(done[0].payload.endReason, 'aborted')
  assert.equal(done[0].payload.resumable, false, '没有工具活动就没有可续跑的东西')
  assert.equal(fs.existsSync(snapshotPath(convId)), false)
})

test('正常完成的回合会清掉上一轮遗留的快照（不留陈旧入口）', async () => {
  const convId = 'e2e-clear'
  const history = [{ role: 'user', content: '读一下 a.md' }]
  await abortTurnWithTool(convId, history)
  assert.equal(fs.existsSync(snapshotPath(convId)), true)

  // 用户没用「继续」，而是直接发了新消息且正常跑完
  fetchScript = [{ chunks: textRound('好的。') }]
  await chat.handleChatSend(makeEvent(), payloadOf(convId, [...history, { role: 'user', content: '算了' }]))
  assert.equal(eventsOf('chat:done').slice(-1)[0].payload.endReason, 'complete')
  assert.equal(fs.existsSync(snapshotPath(convId)), false, '跑完了就不该再留着续跑入口')
  assert.equal(turnSnapshot.hasResumableTurn(convId), false)
})

test('空闲超时同样留快照（超时也常想接着做）', async () => {
  const convId = 'e2e-idle'
  const history = [{ role: 'user', content: '读一下 a.md' }]
  fetchScript = [{ chunks: toolRound('call_1', 'read_file', '{"path":"a.md"}') }, { block: true }]
  const running = chat.handleChatSend(makeEvent(), payloadOf(convId, history))
  await waitFor(() => toolRuns.get('read_file') === 1 && stateStub.chatRuns.has(convId))
  stateStub.chatRuns.get(convId).abortRun('idle')
  await running

  const errs = eventsOf('chat:error')
  assert.equal(errs.length, 1)
  assert.equal(errs[0].payload.endReason, 'timeout')
  assert.equal(errs[0].payload.resumable, true)
  assert.equal(fs.existsSync(snapshotPath(convId)), true)
})

// 多模态消息落快照（2026-10-05，与「网页取图 → 注入下一轮 user 消息」同批改动）
// 背景：user 消息的 content 现在可能是数组（text part + image_url part）——用户发的图片附件，
// 以及 browser_read_images 抓到网页图片后注入的那条消息。两条路都必须满足：
//   ① 只保留文字部分：base64 一张 200~400KB，写进快照必然顶穿 MAX_SNAPSHOT_BYTES
//      → 整份快照被丢弃（连工具序列一起没了，"继续"退化成全部重跑）；
//   ② **不能整体退化成空串**：续跑回放时那条 user 消息会变成空 content，部分网关直接 400
//      （改动前 normalizeTurnMessages 就是 content:'类型不是 string 就置 ""'，会踩这条）。
test('含图片的 user 消息落快照：保留文字、丢掉 base64、不出现空 content', () => {
  const convId = 'snap-images'
  const bigBase64 = 'A'.repeat(300 * 1024)
  const saved = turnSnapshot.saveTurnSnapshot(convId, {
    messages: [
      { role: 'user', content: '看看这个页面 https://demo.local/list' },
      { role: 'assistant', content: '好的', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.md"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'FILE_CONTENT' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '【图片】以下 2 张图已作为图像附在本条消息中，你可以直接看到：\n1. 列表页横幅 — https://demo.local/a.png' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bigBase64}` } },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bigBase64}` } },
        ],
      },
    ],
    historyCount: 1,
    inputHash: 'h1',
  })
  assert.equal(saved, true, '含图片的轮次也必须能落盘（base64 不该把它撑爆）')

  const snap = turnSnapshot.loadTurnSnapshot(convId)
  assert.ok(snap, '快照应当可读回')
  const injected = snap.messages[snap.messages.length - 1]
  assert.equal(typeof injected.content, 'string', 'content 必须归一化成字符串')
  assert.ok(injected.content.length > 0, '不能变成空 content（网关会 400）')
  assert.match(injected.content, /【图片】/)
  assert.ok(injected.content.includes('https://demo.local/a.png'), '图片清单（含来源 URL）要保留下来')
  assert.ok(!injected.content.includes('data:image'), 'base64 一律不得进快照')
  // 相邻消息的 role/tool_call_id 结构不变（tool 序列是接口不 400 的前提）
  assert.equal(snap.messages[1].tool_calls[0].id, 'c1')
  assert.equal(snap.messages[2].role, 'tool')
  turnSnapshot.clearTurnSnapshot(convId)
})
