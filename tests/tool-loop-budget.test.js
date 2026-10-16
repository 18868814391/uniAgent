// 工具循环的轮次预算 + 重复调用检测 —— 回归测试
//
// 背景（2026-09-29 实测）：改代码时「卡住」，最后报
//   「AI 工具调用轮次已达上限，尚未给出最终回答 / AI 已连续调用 60 轮工具」。
// 根因不是卡死，是模型**不知道轮次有上限**，一路做探索性检索直到 loop 跑满；
// 此时再走兜底请求往往也失败（上下文攒了 60 轮工具历史）。
//
// 两个对策：① 剩余轮数不多时注入「轮次提醒」逼它收敛；
//          ② 同一 (工具名, 参数) 连续重复 → 第 2 次附警告、第 3 次拦下不执行。
//
// 这里锁住四条不变量：
//   1) 提醒只在剩余不足时出现，且按固定间隔，不是每轮都塞（白花 token）
//   2) 提醒文案带「已用几轮 / 共几轮 / 还剩几轮」三个数字，模型才知道还剩多少
//   3) 重复计数是「跨轮次、紧邻」语义：中间夹一次不同调用必须清零
//   4) 拦截回传是合法 JSON 且带 blocked 标记，模型能据此改道
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
  TOOL_LOOP_LIMIT,
  shouldWarnBudget,
  budgetWarnText,
  trackRepeatCall,
  repeatWarnText,
  repeatBlockText,
} = chat

// ============================================================
//  轮次预算提醒
// ============================================================

test('轮次上限是常量，且模板里不再硬编码 60 文案', () => {
  assert.equal(TOOL_LOOP_LIMIT, 60)
})

test('提醒只在剩余不足时出现，且按间隔节流', () => {
  // 前 39 轮（0-based loop 0~39）不提醒
  for (let loop = 0; loop < 40; loop++) {
    assert.equal(shouldWarnBudget(loop), false, `第 ${loop} 轮不该提醒`)
  }
  // 第 40 轮起提醒
  assert.equal(shouldWarnBudget(40), true, '第 40 轮应提醒')
  // 之后每 5 轮一次：41~44 不提醒，45 提醒
  for (let loop = 41; loop <= 44; loop++) {
    assert.equal(shouldWarnBudget(loop), false, `第 ${loop} 轮不该提醒（未到间隔）`)
  }
  assert.equal(shouldWarnBudget(45), true)
  assert.equal(shouldWarnBudget(50), true)
  assert.equal(shouldWarnBudget(55), true)
  // 4 次提醒足够，不该每轮都塞
  const warns = []
  for (let loop = 0; loop < TOOL_LOOP_LIMIT; loop++) if (shouldWarnBudget(loop)) warns.push(loop)
  assert.deepEqual(warns, [40, 45, 50, 55], `提醒点应为 [40,45,50,55]，实际 ${JSON.stringify(warns)}`)
})

test('提醒文案必须带「已用 / 共 / 还剩」三个数字', () => {
  const t = budgetWarnText(40)
  assert.match(t, /40\/60/, '要写明已用 40 / 共 60')
  assert.match(t, /剩余约 20 轮/, '要写明还剩多少轮 —— 模型不知道上限正是问题根源')
  assert.match(t, /收敛|最终回答/, '要明确要求收敛并给出回答')

  // 边界：最后一轮
  const last = budgetWarnText(59)
  assert.match(last, /剩余约 1 轮/)
  // 不该出现负数
  assert.doesNotMatch(budgetWarnText(80), /剩余约 -/)
})

test('shouldWarnBudget 对非法入参安全', () => {
  assert.equal(shouldWarnBudget(NaN), false)
  assert.equal(shouldWarnBudget(undefined), false)
  assert.equal(shouldWarnBudget(null), false)
})

// ============================================================
//  重复调用检测
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

test('参数是对象时也能稳定比较（顺序无关的写法差异除外）', () => {
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
//  端到端：模拟「模型永不收敛」的真实工具循环
// ============================================================

const enc = new TextEncoder()
const sseLine = (obj) => `data: ${JSON.stringify(obj)}\n\n`

/** 造一个 SSE 流响应：模型每轮都返回同一个 read_file 调用（模拟死循环）。
 *  fallbackText 决定兜底那发（不带 tools）返回什么 —— 空串即模拟「兜底也失败」。 */
function neverConvergeFetch(requests, fallbackText = '') {
  return async (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push(body)

    // 兜底请求（不带 tools）：走 .json() 分支
    if (!body.tools) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: fallbackText } }], usage: {} }) }
    }

    const idx = requests.length
    const parts = [
      sseLine({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: `c${idx}`,
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"C:/same.js","offset":1,"limit":100}' },
            }],
          },
        }],
      }),
      sseLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
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

test('端到端：模型反复调用同一工具 → 只执行 2 次、注入 4 条轮次提醒、兜底仍失败则报 max_iterations', async () => {
  executed.length = 0
  const requests = []
  currentFetch = neverConvergeFetch(requests)

  stateStub.settings = { allowedDirs: [], role: 'dev', autoExecute: true, subAgentsEnabled: false }
  stateStub.chatRuns = new Map()

  const ev = makeEvent()
  await chat.handleChatSend(ev, payload())

  // ① 重复调用只放行前 2 次（第 1 次正常 + 第 2 次附警告），第 3 次起一律拦下不执行
  assert.equal(executed.length, 2, `只应执行前 2 次，实际执行了 ${executed.length} 次`)

  // ② 第 2 次的结果里带警告，第 3 次起是 blocked 拦截
  //    注意：每个请求都会重发全部历史，所以要基于**最后一个请求**统计，不能把所有请求加总。
  const allToolMsgs = requests.flatMap((r) => (r.messages || []).filter((m) => m.role === 'tool'))
  assert.ok(allToolMsgs.some((m) => m.content.includes('【注意】')), '第 2 次重复应附带警告')

  const lastReq = requests.filter((r) => r.tools).pop()
  const lastToolMsgs = (lastReq.messages || []).filter((m) => m.role === 'tool')
  // 末尾这次请求是在第 60 轮**之前**发出的，所以含的是前 59 轮的结果（第 60 轮的还没产生）
  assert.equal(lastToolMsgs.length, TOOL_LOOP_LIMIT - 1, `末尾请求应含 ${TOOL_LOOP_LIMIT - 1} 条工具结果`)
  const blocked = lastToolMsgs.filter((m) => m.content.includes('"blocked":true'))
  // 第 1 次正常执行、第 2 次带警告执行，第 3 次起全部拦下
  assert.equal(blocked.length, lastToolMsgs.length - 2, `第 3 次起应被拦截（实际 ${blocked.length}/${lastToolMsgs.length}）`)

  // ③ 轮次提醒：最后一个请求里应有 4 条（第 40/45/50/55 轮各注入一次）
  const warns = (lastReq.messages || []).filter((m) => typeof m.content === 'string' && m.content.startsWith('【轮次提醒】'))
  assert.equal(warns.length, 4, `应注入 4 条轮次提醒，实际 ${warns.length}`)
  assert.match(warns[0].content, /40\/60/)

  // ④ 消息序列合法：assistant(tool_calls) 之后必须紧跟对应数量的 tool 消息
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

  // ⑤ 兜底也救不回来（模型照样不给答案）→ 明确报 max_iterations，且文案里带上限常量
  const done = ev.sent.filter((e) => e.ch === 'chat:done')
  assert.equal(done.length, 1)
  assert.equal(done[0].payload.endReason, 'max_iterations')
  assert.match(done[0].payload.endDetail, /60 轮/)

  // ⑥ 兜底请求确实发出过（不带 tools 的那一发）
  assert.ok(requests.some((r) => !r.tools), '轮次耗尽后应发起一次不带工具的兜底请求')
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
  assert.equal(done[0].payload.endReason, 'complete', '兜底成功就不该报「轮次已达上限」—— 用户看到那条报错说明兜底也挂了')
  assert.match(done[0].payload.fullContent, /基于已有工具结果/)
  assert.ok(requests.some((r) => !r.tools), '兜底请求发出过')
})

test('端到端：模型正常收敛（第 3 轮给答案）→ endReason=complete，不触发轮次提醒', async () => {
  executed.length = 0
  const requests = []
  currentFetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push(body)
    const n = requests.length
    const parts = n < 3
      ? [
          sseLine({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: `d${n}`,
                  type: 'function',
                  function: { name: 'read_file', arguments: `{"path":"C:/f${n}.js"}` }, // 参数不同 → 不是重复
                }],
              },
            }],
          }),
          sseLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
          'data: [DONE]\n\n',
        ]
      : [
          sseLine({ choices: [{ delta: { content: '改好了。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
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

  stateStub.settings = { allowedDirs: [], role: 'dev', autoExecute: true, subAgentsEnabled: false }
  stateStub.chatRuns = new Map()

  const ev = makeEvent()
  await chat.handleChatSend(ev, payload())

  assert.equal(executed.length, 2, '两个不同参数各执行一次')
  const reqsWithWarn = requests.filter((r) => (r.messages || []).some((m) => typeof m.content === 'string' && m.content.startsWith('【轮次提醒】')))
  assert.equal(reqsWithWarn.length, 0, '未接近上限时不该注入轮次提醒（不白花 token）')

  const done = ev.sent.filter((e) => e.ch === 'chat:done')
  assert.equal(done.length, 1)
  assert.equal(done[0].payload.endReason, 'complete')
})
