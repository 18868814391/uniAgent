// 工具循环的收口策略 + 重复调用检测 —— 端到端回归测试
//
// 背景（2026-10-05 重构）：旧实现是「`TOOL_LOOP_LIMIT = 60` 硬上限 + 跑满兜底逼答 +
// 第 40/45/50/55 轮提醒」。问题：步数与「有没有干成事」无关 —— 长任务被平白截断，
// 而模型只能抢在提醒点之前收敛。
//
// 现在工具循环是 `for(;;)`，**内核没有最大步数**；收口只依据**进展判据**：
// 连续多轮没拿到新信息（本轮调用的 (工具名, 参数) 组合以前全用过、清单也没变）
// 才逐级升级 warn(2) → wrapup(3) → stop(4)，stop 时跳出循环交给「不带工具的兜底请求」。
// 阈值/文案/状态机的纯函数单测见 tests/tool-loop-policy.test.js，本文件只管接线是否正确。
//
// 这里锁住五条不变量：
//   1) **长任务不会被步数截断**：跑 70 轮不同的读取也照样继续，只在软预算点提醒一次工作量
//   2) 原地打转：重复调用只放行前 2 次（第 2 次附警告），第 3 次起拦下
//   3) 停滞到第 4 轮内核跳出 → 走兜底请求；兜底成功=complete，兜底失败=max_iterations
//   4) 消息序列始终合法：assistant(tool_calls) 后必须紧跟对应数量的 tool 消息
//   5) 正常收敛的任务不会被任何提醒打扰，也不触发收口
//
// chat.js 是 CJS 且加载即 require('electron')，故先把依赖塞进 require.cache。
// 桩列表与 tool-result-window.test.js / chat-abort.test.js 保持一致。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const CHAT = path.join(__dirname, '..', 'electron', 'chat.js')

const stub = (request, exports) => {
  const id = require.resolve(request, { paths: [path.dirname(CHAT)] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

const stateStub = { settings: {}, chatRuns: new Map(), subAgents: new Map(), subAgentsPending: new Map(), mainWindow: null }
const executed = []   // 实际被执行（未拦截）的工具名
let currentFetch = async () => { throw new Error('本测试不发起请求') }

stub('electron', {
  ipcMain: { handle() {}, on() {} },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }), getAllWindows: () => [] },
})
stub('./state', stateStub)
stub('./tool-schemas', { TOOLS_DEFINITION: [{ type: 'function', function: { name: 'read_file', description: 'x', parameters: {} } }] })
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
    return JSON.stringify({ success: true, content: 'X'.repeat(2000) })
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
const {
  loopPolicy,
  trackRepeatCall,
  repeatWarnText,
  repeatBlockText,
} = chat

// ============================================================
//  没有步数上限（策略层）
// ============================================================

test('工具循环没有步数上限：只有防死循环的绝对刹车', () => {
  assert.ok(loopPolicy.ABSOLUTE_STEP_CEILING >= 200, '绝对刹车是保险丝量级，不是预算')
  assert.equal(chat.TOOL_LOOP_LIMIT, undefined, '旧的 60 轮硬上限常量必须已移除')
  assert.equal(chat.shouldWarnBudget, undefined, '「剩余轮数」提醒已随硬上限一并移除')
  assert.equal(chat.budgetWarnText, undefined)
})

// ============================================================
//  重复调用检测（行为不变：第 2 次附警告、第 3 次起拦下）
// ============================================================

test('连续重复才计数：首次 0、第 2 次 1、第 3 次 2', () => {
  const st = { lastSig: '', streak: 0 }
  assert.equal(trackRepeatCall(st, 'read_file', '{"path":"a.js"}'), 0, '首次 → 0')
  assert.equal(trackRepeatCall(st, 'read_file', '{"path":"a.js"}'), 1, '第 2 次 → 1（附警告）')
  assert.equal(trackRepeatCall(st, 'read_file', '{"path":"a.js"}'), 2, '第 3 次 → 2（拦截）')
  assert.equal(trackRepeatCall(st, 'read_file', '{"path":"a.js"}'), 3, '第 4 次 → 3')
})

test('中间夹一次不同调用 → 计数清零（「连续」语义）', () => {
  const st = { lastSig: '', streak: 0 }
  trackRepeatCall(st, 'read_file', '{"path":"a.js"}')
  trackRepeatCall(st, 'read_file', '{"path":"a.js"}')
  assert.equal(st.streak, 1)
  // 换个参数 → 清零
  assert.equal(trackRepeatCall(st, 'read_file', '{"path":"b.js"}'), 0)
  // 换个工具 → 也是新签名
  assert.equal(trackRepeatCall(st, 'grep_code', '{"path":"b.js"}'), 0)
  // 再回到原来的 → 仍算新签名（不是紧邻重复）
  assert.equal(trackRepeatCall(st, 'read_file', '{"path":"a.js"}'), 0)
})

test('工具名相同但参数不同 → 不算重复（合法的连续读多个文件）', () => {
  const st = { lastSig: '', streak: 0 }
  for (let i = 0; i < 10; i++) {
    assert.equal(trackRepeatCall(st, 'read_file', `{"path":"f${i}.js"}`), 0, `第 ${i} 个文件不该被判重复`)
  }
})

test('参数是对象时也能稳定比较', () => {
  const st = { lastSig: '', streak: 0 }
  assert.equal(trackRepeatCall(st, 'read_file', { path: 'a.js' }), 0)
  assert.equal(trackRepeatCall(st, 'read_file', { path: 'a.js' }), 1, '同一对象字面量应判为重复')
})

test('警告文案：点名工具 + 给出改道建议', () => {
  const w = repeatWarnText('read_file')
  assert.match(w, /read_file/)
  assert.match(w, /相同的参数|完全相同/)
  assert.match(w, /不同参数|offset/, '要提示换参数，而不是只说"别重复"')
})

test('拦截文案是合法 JSON，带 blocked 标记与明确指引', () => {
  const raw = repeatBlockText('read_file', 2)
  const obj = JSON.parse(raw) // 不合法会直接抛
  assert.equal(obj.success, false)
  assert.equal(obj.blocked, true)
  assert.match(obj.error, /read_file/)
  assert.match(obj.error, /3 次/, '要写明已连续几次')
  assert.match(obj.error, /最终回答|不同参数/, '要给出出路')
})

test('拦截文案的 JSON 不会被参数里的特殊字符破坏', () => {
  // 工具名取自模型输出，理论上可能带奇怪字符 —— 必须走 JSON.stringify 而不是拼字符串
  const raw = repeatBlockText('weird"name\\x', 3)
  const obj = JSON.parse(raw)
  assert.equal(obj.success, false)
})

// ============================================================
//  端到端：真实工具循环接线
// ============================================================

const enc = new TextEncoder()
const sseLine = (obj) => `data: ${JSON.stringify(obj)}\n\n`

/** 把若干 SSE 文本片段包成 fetch 响应（每次 read 吐一段）。 */
function streamOf(parts) {
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

/** 一轮「带工具调用」的流式响应 */
function toolCallParts(id, name, args) {
  return [
    sseLine({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }],
        },
      }],
    }),
    sseLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    'data: [DONE]\n\n',
  ]
}

/** 一轮「纯文本收尾」的流式响应 */
function textParts(text) {
  return [
    sseLine({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    'data: [DONE]\n\n',
  ]
}

/**
 *  造一个 SSE 流响应：前 n 轮都返回**同一个** read_file 调用（模拟死循环），
 *  之后（不会发生）返回正文。fallbackText 决定兜底那发（不带 tools）返回什么 —— 空串即「兜底也失败」。
 */
function neverConvergeFetch(requests, fallbackText = '') {
  return async (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push(body)

    // 兜底请求（不带 tools）：走 .json() 分支
    if (!body.tools) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: fallbackText } }], usage: {} }) }
    }

    const idx = requests.filter((r) => r.tools).length
    return streamOf(toolCallParts(`c${idx}`, 'read_file', '{"path":"C:/same.js","offset":1,"limit":100}'))
  }
}

/**
 *  造一个「一路推进」的 SSE fetch：前 n 轮每轮读**不同**的文件（新签名 = 有进展），
 *  第 n+1 轮给出最终回答。用于证明长任务不会被步数截断。
 */
function convergeAfterNFetch(requests, n, answer = '整理完成。') {
  return async (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push(body)
    if (!body.tools) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: '' } }], usage: {} }) }
    }
    const idx = requests.filter((r) => r.tools).length
    if (idx <= n) return streamOf(toolCallParts(`p${idx}`, 'read_file', `{"path":"C:/f${idx}.js"}`))
    return streamOf(textParts(answer))
  }
}

function makeEvent() {
  const sent = []
  return { sent, sender: { send: (ch, payload) => sent.push({ ch, payload }) } }
}

const payload = () => ({
  conversationId: 'conv-budget-test',
  messages: [{ role: 'user', content: '帮我改一下这个页面的表格' }],
  profileId: 'test-profile',
  autoExecute: true,
})

/** 每次请求都要满足的消息序列约束：assistant(tool_calls) 后紧跟等量的 tool 消息 */
function assertLegalSequences(requests) {
  for (const r of requests) {
    const ms = r.messages || []
    let need = 0
    for (const m of ms) {
      if (need > 0) {
        assert.equal(m.role, 'tool', 'assistant(tool_calls) 后必须紧跟 tool 消息，否则接口 400')
        need--
        continue
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) need = m.tool_calls.length
    }
  }
}

const toolRequests = (requests) => requests.filter((r) => r.tools)
const hasText = (m, needle) => m && typeof m.content === 'string' && m.content.includes(needle)

test('端到端：长任务（70 轮不同读取）不会被步数截断，只有软预算提醒', async () => {
  executed.length = 0
  const requests = []
  currentFetch = convergeAfterNFetch(requests, 70)

  stateStub.settings = { allowedDirs: [], role: 'dev', autoExecute: true, subAgentsEnabled: false }
  stateStub.chatRuns = new Map()

  const ev = makeEvent()
  await chat.handleChatSend(ev, payload())

  // ① 70 次工具调用一次都没被拦（旧实现跑到第 60 轮就被硬截断了）
  assert.equal(executed.length, 70, `70 轮不同参数的读取都应执行，实际 ${executed.length}`)

  // ② 全程没有任何「停滞/收口」提醒 —— 一直在推进
  const allTexts = requests.flatMap((r) => (r.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')))
  assert.ok(!allTexts.some((t) => t.startsWith('【进展提醒】')), '一路推进不该被判停滞')
  assert.ok(!allTexts.some((t) => t.includes('【收口指令】')), '一路推进不该被要求收口')

  // ③ 软预算点：20 / 35 / 50 各提醒一次「已用掉 N 轮」，且不提任何上限
  const last = toolRequests(requests).pop()
  const soft = last.messages.filter((m) => hasText(m, '【进度提醒】'))
  assert.equal(soft.length, 3, `70 轮应依次跨过 20/35/50 三个软预算点，实际 ${soft.length}`)
  const softText = soft.map((m) => m.content).join('\n')
  for (const n of [20, 35, 50]) assert.match(softText, new RegExp(`已用掉 ${n} 轮`))
  assert.ok(!soft.some((m) => /上限|还剩/.test(m.content)), '软预算提醒不该提任何上限/剩余轮数')

  // ④ 模型自己给答案 → 正常完成，没有走兜底
  const done = ev.sent.filter((e) => e.ch === 'chat:done')
  assert.equal(done.length, 1)
  assert.equal(done[0].payload.endReason, 'complete')
  assert.ok(!requests.some((r) => !r.tools), '没有触发兜底请求')

  assertLegalSequences(requests)
})

test('端到端：原地打转 → 只执行 2 次、停滞提醒逐级升级、兜底失败则报 max_iterations', async () => {
  executed.length = 0
  const requests = []
  currentFetch = neverConvergeFetch(requests)

  stateStub.settings = { allowedDirs: [], role: 'dev', autoExecute: true, subAgentsEnabled: false }
  stateStub.chatRuns = new Map()

  const ev = makeEvent()
  await chat.handleChatSend(ev, payload())

  // ① 重复调用只放行前 2 次（第 1 次正常 + 第 2 次附警告），第 3 次起一律拦下不执行
  assert.equal(executed.length, 2, `只应执行前 2 次，实际执行了 ${executed.length}`)

  // ② 停滞立即被收口：stall 2 → warn、stall 3 → wrapup、stall 4 → stop 跳出循环。
  //    收口不看步数，所以整轮只有 5 次工具请求（旧实现要烧满 60 轮）。
  const toolReqs = toolRequests(requests)
  assert.equal(toolReqs.length, 5, `停滞收口应在第 5 次工具请求前生效，实际 ${toolReqs.length}`)

  const lastReq = toolReqs.pop()
  const lastToolMsgs = lastReq.messages.filter((m) => m.role === 'tool')
  // 第 2 次重复的警告附在结果原文之后，会被「同目标去重」在后续轮次里换成「已省略」标记，
  // 所以要在**全部请求**里找（旧用例同理），不能用最后一发。
  const allToolMsgs = requests.flatMap((r) => (r.messages || []).filter((m) => m.role === 'tool'))
  assert.ok(allToolMsgs.some((m) => m.content.includes('【注意】')), '第 2 次重复应附带警告')
  // 拦截回的是短 JSON（不足折叠阈值），不会被去重，所以能在最后一发里逐条数出来
  assert.equal(lastToolMsgs.filter((m) => m.content.includes('"blocked":true')).length, lastToolMsgs.length - 2)

  // ③ 提醒各出现一次：进展提醒（warn）+ 收口指令（wrapup）
  const warns = lastReq.messages.filter((m) => hasText(m, '【进展提醒】'))
  const wrapups = lastReq.messages.filter((m) => hasText(m, '【收口指令】'))
  assert.equal(warns.length, 1, `进展提醒应只注入一次，实际 ${warns.length}`)
  assert.equal(wrapups.length, 1, `收口指令应只注入一次，实际 ${wrapups.length}`)
  assert.match(warns[0].content, /没有取得任何新信息/)

  assertLegalSequences(requests)

  // ④ 兜底也救不回来（模型照样不给答案）→ 报 max_iterations，且文案说明是「无进展被收口」
  const done = ev.sent.filter((e) => e.ch === 'chat:done')
  assert.equal(done.length, 1)
  assert.equal(done[0].payload.endReason, 'max_iterations')
  assert.match(done[0].payload.endDetail, /无进展/)
  assert.doesNotMatch(done[0].payload.endDetail, /60 轮/, '不该再提旧的 60 轮硬上限')

  // ⑤ 兜底请求确实发出过（不带 tools 的那一发）
  assert.ok(requests.some((r) => !r.tools), '收口后应发起一次不带工具的兜底请求')
})

test('端到端：兜底那发成功时 → 不报 max_iterations，而是照常给出答案', async () => {
  executed.length = 0
  const requests = []
  // 与上一条的唯一差别：兜底请求返回了正文
  currentFetch = neverConvergeFetch(requests, '基于已有工具结果，这是我的最终回答。')

  stateStub.settings = { allowedDirs: [], role: 'dev', autoExecute: true, subAgentsEnabled: false }
  stateStub.chatRuns = new Map()

  const ev = makeEvent()
  await chat.handleChatSend(ev, payload())

  const done = ev.sent.filter((e) => e.ch === 'chat:done')
  assert.equal(done.length, 1)
  assert.equal(done[0].payload.endReason, 'complete', '兜底成功就不该报「未给出最终回答」—— 用户看到那条报错说明兜底也挂了')
  assert.match(done[0].payload.fullContent, /基于已有工具结果/)
  assert.ok(requests.some((r) => !r.tools), '兜底请求发出过')
})

test('端到端：模型正常收敛（第 3 轮给答案）→ endReason=complete，不触发任何提醒', async () => {
  executed.length = 0
  const requests = []
  currentFetch = convergeAfterNFetch(requests, 2, '改好了。')

  stateStub.settings = { allowedDirs: [], role: 'dev', autoExecute: true, subAgentsEnabled: false }
  stateStub.chatRuns = new Map()

  const ev = makeEvent()
  await chat.handleChatSend(ev, payload())

  assert.equal(executed.length, 2, '两个不同参数各执行一次')
  const warned = (m) => hasText(m, '【进度提醒】') || hasText(m, '【进展提醒】') || hasText(m, '【收口指令】')
  const reqsWithWarn = requests.filter((r) => (r.messages || []).some(warned))
  assert.equal(reqsWithWarn.length, 0, '未接近软预算点、也没停滞时不该注入任何提醒（不白花 token）')

  const done = ev.sent.filter((e) => e.ch === 'chat:done')
  assert.equal(done.length, 1)
  assert.equal(done[0].payload.endReason, 'complete')
})
