// 子代理（spawn_sub_agent）超时行为的回归测试 —— 2026-09-21
//
// 背景（真实故障，用户实际遇到）：一次「丢赔单价取值逻辑是什么、源头取哪个模块」的提问里，
// 主 Agent 派了两个子代理分别去前后端仓库找实现，两个子代理各跑到墙钟上限被 abort，
// 而当时的收尾逻辑**只回了一句「子代理超时（300秒）」**——
// 中途读过的文件、跑出来的结论全被丢掉，主 Agent 白等一整轮之后只能自己从头再搜一遍。
// 顺带那次还暴露了两个问题：系统提示词里没告诉子代理仓库在哪、也没有检索纪律，
// 所以它在几万文件的授权目录里 repo-wide 乱搜，必然撞线；而超时返回里的 rounds 被硬编码成 0，
// 事后连"它到底跑了几轮"都复盘不出来。
//
// 这里锁住六条不变量：
//   1) 子代理的 system 提示词里必须真的带上了角色上下文（settings.buildSubAgentContext 的产出）
//   2) 子代理看不到 spawn_sub_agent / get_sub_agent_results / ask_user（防递归派生与阻塞等待）
//   3) 超时返回**真实 rounds**（不能再是硬编码 0）
//   4) 超时/异常时 result 里带「中止前已完成的部分成果」（工具产出摘要），不再是空
//   5) get_sub_agent_results 把部分成果拼进失败条目，并附 note 引导模型自己接着干、别原样重派
//   6) 发给渲染层的 status 词表必须与渲染层一致：派发是 'running'，收尾是 'completed'/'error'
//      （2026-09-21 修：派发时曾发 'started'，渲染层不认识 → 派发瞬间就显示"✓ N 个子任务已完成"）
//   另加一条回归：正常完成的路径不能被改坏（不出现 note）。
//
// 不真等 10 分钟：runSubAgentLoop 里 `setTimeout(() => controller.abort(), SUB_AGENT_TIMEOUT_MS)`
// 是唯一的超时动作，本文件把这条定时器截下来只登记不执行，等第一轮工具跑完之后再手动触发它，
// 等价复现「跑到一半被超时掐断」。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const SUB_AGENT = path.join(__dirname, '..', 'electron', 'sub-agent.js')
const SUB_AGENT_DIR = path.dirname(SUB_AGENT)
const CONV = 'conv-subagent-test'

// ---- 可注入的桩行为（每个用例前重置） ----
let currentFetch = null
const sent = []                    // 主进程发给渲染层的事件
const toolNames = []               // 桩工具执行器的调用记录
const TIME_SENTINEL = 'SENTINEL-角色上下文-检索纪律'   // 由 settings 桩返回，用于验证"真的注入了"
const DISCIPLINE_HINT = '检索纪律'

const stateStub = {
  settings: { role: 'qa' },
  subAgents: new Map(),
  subAgentsPending: new Map(),
  subAgentSeq: 0,
}

const TOOLS_DEFINITION = [
  { type: 'function', function: { name: 'read_file', description: '读文件', parameters: {} } },
  { type: 'function', function: { name: 'grep_code', description: '检索', parameters: {} } },
  { type: 'function', function: { name: 'spawn_sub_agent', description: '派发', parameters: {} } },
  { type: 'function', function: { name: 'get_sub_agent_results', description: '收结果', parameters: {} } },
  { type: 'function', function: { name: 'ask_user', description: '反问', parameters: {} } },
  // 会话级状态类工具：子代理沿用主会话的 convId，必须被拦（否则会覆盖主 Agent 的任务清单）
  { type: 'function', function: { name: 'update_todos', description: '任务清单', parameters: {} } },
  // 写类工具：子代理是只读角色，且不经过 guard.js —— 一律不下发（2026-10-04 补）
  { type: 'function', function: { name: 'write_file', description: '写文件', parameters: {} } },
  { type: 'function', function: { name: 'edit_file', description: '改文件', parameters: {} } },
  { type: 'function', function: { name: 'delete_file', description: '删文件', parameters: {} } },
  { type: 'function', function: { name: 'write_skill', description: '写技能', parameters: {} } },
  { type: 'function', function: { name: 'write_memory', description: '写记忆', parameters: {} } },
  { type: 'function', function: { name: 'execute_command', description: '命令', parameters: {} } },
]

const toolCtxs = []                // 桩工具执行器收到的 ctx（用于断言 subAgent 标记）
const toolsStub = {
  executeToolCall: async (tc, ctx) => {
    toolNames.push(tc.function.name)
    toolCtxs.push(ctx)
    return JSON.stringify({ success: true, content: `${tc.function.name} 的桩产出` })
  },
}

// 把依赖塞进 require.cache，使 sub-agent.js 能在纯 Node（无 Electron、无真实网络、不加载 tools/ 依赖树）下跑
const stub = (request, exports) => {
  const id = require.resolve(request, { paths: [SUB_AGENT_DIR] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

stub('./state', stateStub)
stub('./tool-schemas', { TOOLS_DEFINITION })
// describeFetchError 等其余导出走真实实现（chat.js/sub-agent.js 失败收尾时用它格式化原因）
const realNetRetry = require(path.join(__dirname, '..', 'electron', 'net-retry.js'))
stub('./net-retry', { ...realNetRetry, fetchWithRetry: (...args) => currentFetch(...args) })
stub('./text-tool-call', {
  looksLikeTextToolCall: () => false,
  parseTextToolCalls: () => ({ calls: [], cleaned: '' }),
})
stub('./settings', {
  DEFAULT_BASE_URL: 'http://127.0.0.1/v1',
  DEFAULT_MODEL_ID: 'test-model',
  getActiveProfile: () => ({
    apiKey: 'sk-test',
    baseUrl: 'http://127.0.0.1/v1',
    model: 'test-model',
  }),
  // 真实实现见 settings.js 的 buildSubAgentContext（角色 + 仓库根目录 + 检索纪律）；
  // 这里换成哨兵串，只验证「子代理确实把它的产出拼进了 system 提示词」这条链路。
  buildSubAgentContext: () => `${TIME_SENTINEL}（${DISCIPLINE_HINT}）`,
})
// 关键：不加载 electron/tools/index.js（它的依赖树通向 main.js 的加载链），换成桩
stub('./tools', toolsStub)

const subAgent = require(SUB_AGENT)

// ---- 桩响应构造 ----
// 一轮带工具调用的流式响应
function toolCallStream(name, args) {
  const chunk = {
    choices: [{
      delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      finish_reason: 'tool_calls',
    }],
  }
  return sseResponse(['data: ' + JSON.stringify(chunk) + '\n\n', 'data: [DONE]\n\n'])
}

// 一轮纯文本的收尾响应
function textStream(text) {
  const chunk = { choices: [{ delta: { content: text }, finish_reason: 'stop' }] }
  return sseResponse(['data: ' + JSON.stringify(chunk) + '\n\n', 'data: [DONE]\n\n'])
}

function sseResponse(chunks) {
  const enc = new TextEncoder()
  let i = 0
  return async () => ({
    ok: true,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined }),
      }),
    },
  })
}

const makeEvent = () => ({ sender: { send: (ch, payload) => sent.push({ ch, payload }) } })

/**
 *  跑一次「派发 1 个子代理 → 收结果」，并返回 { reqBodies, results, raw }
 *  fetchPlan: 数组，第 n 项是第 n 次 chat/completions 调用的行为。
 *  'TIMEOUT' 表示：触发被截下的超时定时器，然后像真 fetch 一样抛 AbortError。
 */
async function runOnce(fetchPlan) {
  const reqBodies = []
  let capturedTimeout = null
  const origSetTimeout = global.setTimeout
  const origClearTimeout = global.clearTimeout
  global.setTimeout = (fn, delay, ...rest) => {
    // 只截子代理的墙钟超时定时器（10 分钟），其余（如 handleGetSubAgentResults 里的 30s 清理）照常。
    // 真实定时器一律 unref：这里所有用例都是同步跑完的，不靠计时器维持事件循环，
    // 不 unref 的话那个 30s 清理定时器会让整个测试文件白等 30 秒才退出。
    if (delay >= 10 * 60 * 1000) { capturedTimeout = fn; return { __fakeTimer: true, unref() {} } }
    const t = origSetTimeout(fn, delay, ...rest)
    if (t && typeof t.unref === 'function') t.unref()
    return t
  }
  global.clearTimeout = (t) => {
    if (t && t.__fakeTimer) return
    return origClearTimeout(t)
  }

  let call = 0
  currentFetch = async (_url, init) => {
    try { reqBodies.push(JSON.parse(init.body)) } catch { reqBodies.push(null) }
    call++
    const plan = fetchPlan[call - 1]
    if (typeof plan === 'function') return plan()
    if (plan === 'TIMEOUT') {
      assert.ok(capturedTimeout, '超时定时器应已被截下（说明 runSubAgentLoop 确实注册了墙钟超时）')
      const fire = capturedTimeout
      capturedTimeout = null
      fire()
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    }
    return plan
  }

  try {
    const ctx = { convId: CONV, event: makeEvent(), profileId: undefined }
    subAgent.handleSpawnSubAgent({ task: '找出某接口的实现', description: '前端' }, ctx)
    const raw = await subAgent.handleGetSubAgentResults({}, { convId: CONV, event: makeEvent() })
    return { reqBodies, raw, parsed: JSON.parse(raw) }
  } finally {
    global.setTimeout = origSetTimeout
    global.clearTimeout = origClearTimeout
  }
}

function resetAll() {
  sent.length = 0
  toolNames.length = 0
  toolCtxs.length = 0
  currentFetch = null
  stateStub.subAgents.clear()
  stateStub.subAgentsPending.clear()
  stateStub.subAgentSeq = 0
}

test('子代理的 system 提示词带上了角色上下文与检索纪律', async () => {
  resetAll()
  const { reqBodies } = await runOnce([textStream('结论：在 your-backend-module 下')])
  const system = reqBodies[0].messages.find(m => m.role === 'system')
  assert.ok(system, '请求体里应有 system 消息')
  assert.match(system.content, new RegExp(TIME_SENTINEL), 'roleContext 必须被拼进 system 提示词')
  assert.match(system.content, new RegExp(DISCIPLINE_HINT))
})

test('子代理看不到写类工具与流程类工具（只读角色）', async () => {
  resetAll()
  const { reqBodies } = await runOnce([textStream('结论')])
  const names = reqBodies[0].tools.map(t => t.function.name)
  const blocked = [
    // 流程类：防递归派生 / 防挂起等用户 / 防覆盖主 Agent 清单
    'spawn_sub_agent', 'get_sub_agent_results', 'ask_user', 'update_todos',
    // 写类：子代理只读，且不经过 guard.js
    'write_file', 'edit_file', 'delete_file', 'write_skill', 'write_memory',
  ]
  assert.deepEqual(names.filter(n => blocked.includes(n)), [], `不该下发：${blocked.join(' / ')}`)
  assert.ok(names.includes('read_file') && names.includes('grep_code'), '其余工具要保留')
  assert.ok(names.includes('execute_command'), 'execute_command 仍下发（执行层按只读白名单过滤）')
  // 黑名单本身也要锁住（防止有人从 Set 里删掉一项却没人发现）
  assert.deepEqual([...subAgent.BLOCKED_TOOLS].sort(), [...blocked].sort())
})

// update_todos 的第二道防线：即便模型（或文本形态调用还原）硬凑出这个名字，
// handler 也要按 ctx.subAgent 拒绝 —— 它写的是主会话的清单。
test('子代理调用工具时 ctx 带 subAgent 标记（会话级状态类工具据此硬拒绝）', async () => {
  resetAll()
  await runOnce([toolCallStream('read_file', { path: 'x.vue' }), textStream('结论')])
  assert.equal(toolCtxs.length, 1, '第 1 轮读文件应执行一次')
  assert.equal(toolCtxs[0].subAgent, true, '子代理的执行上下文必须带 subAgent:true')
  assert.equal(toolCtxs[0].convId, CONV)
})

test('正常完成：success=true，结果不出现 note，不被误判为失败', async () => {
  resetAll()
  const { parsed } = await runOnce([textStream('结论：丢赔单价取自合同商品 standard 字段')])
  assert.equal(parsed.success, true)
  assert.equal(parsed.note, undefined)
  assert.equal(parsed.results.length, 1)
  assert.equal(parsed.results[0].status, 'completed')
  assert.match(parsed.results[0].result, /丢赔单价取自合同商品/)
})

test('超时：返回真实 rounds（不再硬编码 0），且带上中止前已完成的部分成果', async () => {
  resetAll()
  // 第 1 轮：模型要求调 read_file；第 2 轮：撞超时被中止
  const { parsed } = await runOnce([toolCallStream('read_file', { path: 'src/pages/order/lossBill/index.vue' }), 'TIMEOUT'])

  const one = parsed.results[0]
  assert.equal(one.status, 'error')
  assert.match(one.result, /子代理超时（600秒）/, '超时文案应反映新的 10 分钟上限')
  assert.equal(one.rounds, 2, 'rounds 必须是真实轮数（旧版硬编码 0）')
  assert.match(String(one.duration), /^\d+(\.\d+)?$/, 'duration 应是秒数字符串（本用例被立刻中止，值为 0.0 属正常）')
  assert.match(one.result, /部分成果/, '失败结果里要说明这是被中止前完成的部分成果')
  assert.match(one.result, /read_file 的桩产出/, '第 1 轮工具的真实产出必须被回传，不能整段丢弃')
  assert.deepEqual(toolNames, ['read_file'], '第 1 轮的工具确实执行过')
})

test('超时：补一条 note 引导模型自己接着干，而不是原样重派（会再撞一次超时）', async () => {
  resetAll()
  const { parsed } = await runOnce([toolCallStream('grep_code', { pattern: 'getContractType' }), 'TIMEOUT'])
  assert.equal(parsed.success, true)
  assert.match(parsed.note, /1 个子代理未成功完成/)
  assert.match(parsed.note, /不要把这个子任务原样重新派发一次/)
})

test('派发事件的状态词必须是 running（渲染层据此显示"执行中"）', async () => {
  resetAll()
  await runOnce([toolCallStream('read_file', { path: 'a.js' }), 'TIMEOUT'])
  const events = sent.filter(e => e.ch === 'chat:subagent')
  assert.equal(events.length, 2, '派发 + 收尾各一条')
  // 契约：渲染层 SubAgentStatus.vue 把**非终态**一律当"执行中"（只有 completed / error / aborted 是终态）。
  // 旧实现这里发的是 'started'，不在渲染层认得的词表里 → 派发瞬间 runningCount=0、errorCount=0，
  // 兜底分支直接谎报"✓ N 个子任务已完成"（用户 2026-09-21 实际遇到的显示 bug），
  // 同时每行图标因为既非 running 也非 completed，落到 else 分支渲染成红色错误图标。
  assert.equal(events[0].payload.status, 'running', '派发事件必须是 running，不能是 started')
  assert.equal(events[0].payload.description, '前端')
  assert.equal(events[0].payload.subAgentId, events[1].payload.subAgentId, '两条事件必须指向同一个子代理')
  assert.equal(events[1].payload.status, 'error')
  const entry = [...stateStub.subAgents.values()][0]
  assert.equal(entry.status, 'error')
  assert.equal(entry.result.success, false)
  assert.ok(entry.result.result, 'state 里也要留住部分成果，便于事后排查')
})

test('正常完成的路径也要发 running → completed 两条（状态机不缺环）', async () => {
  resetAll()
  await runOnce([textStream('结论：完成')])
  const events = sent.filter(e => e.ch === 'chat:subagent')
  assert.equal(events.length, 2, '派发 + 收尾各一条')
  assert.equal(events[0].payload.status, 'running')
  assert.equal(events[1].payload.status, 'completed')
  assert.equal(events[1].payload.duration !== undefined, true, '完成事件要带 duration，用于列表右侧展示')
})
