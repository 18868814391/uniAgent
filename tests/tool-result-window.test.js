// A1 工具结果窗口化 —— 回归测试
//
// 背景：工具循环里每一步的结果（网页快照 / 页面正文）都会永久留在 currentMessages 里，
// 而 maybeCompactHistory 只在轮次开头跑一次 → 第 k 步要重发前 k-1 份完整结果，
// prefill 呈 O(n²)（实测：单份快照 ≈2,500 tokens，20 步累积 ≈5 万 tokens）。
// A1 把**本轮**更早的结果折叠成一行摘要。
//
// 这里锁住四条不变量：
//   1) 保留最近 K 条全文，更早的折叠；摘要里保留"原长度 + 开头片段"，不是纯占位符
//   2) 只压 content —— role:'tool' 与 tool_call_id 必须原样保留
//      （缺 tool_call_id 会让 OpenAI 兼容接口直接 400）
//   3) 短于 minLen 的结果不折叠；startIndex 之前的历史不动（续跑回放要保真）
//   4) 幂等（重复调用不二次折叠），且快照落盘前能把摘要还原成原文
//
// chat.js 是 CJS 且加载即 require('electron')，故先把全部依赖塞进 require.cache 再 require，
// 使其能在纯 Node（无 Electron、无网络）下被加载。桩列表与 chat-abort.test.js 保持一致。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const CHAT = path.join(__dirname, '..', 'electron', 'chat.js')

const stub = (request, exports) => {
  const id = require.resolve(request, { paths: [path.dirname(CHAT)] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

stub('electron', {
  ipcMain: { handle() {}, on() {} },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }), getAllWindows: () => [] },
})
stub('./state', {
  settings: {},
  chatRuns: new Map(),
  subAgents: new Map(),
  subAgentsPending: new Map(),
  mainWindow: null,
})
stub('./tool-schemas', { TOOLS_DEFINITION: [] })
// describeFetchError 等其余导出走真实实现（chat.js 失败收尾时用它格式化原因）；须在 stub 之前 require
const realNetRetry = require(path.join(__dirname, '..', 'electron', 'net-retry.js'))
stub('./net-retry', { ...realNetRetry, fetchWithRetry: async () => { throw new Error('本测试不发起请求') } })
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
stub('./tools', { executeToolCall: async () => '{}', killAllChildren: () => {} })
stub('./sub-agent', { abortSubAgentsForConversation: () => {} })
stub('./xl-work', { newRunWorkDir: () => '/tmp/xl-work', scheduleCleanup: () => {}, pruneRootLeftovers: () => 0 })
// 孤儿进程清扫：测试里绝不真去枚举系统进程表（慢 400ms+，而且在有真孤儿的机器上会真杀进程）
stub('./tools/orphan-cleanup', { killOrphanScriptProcesses: async () => ({ found: 0, killed: [] }) })
// 快照模块桩成 no-op（真实读写由 turn-resume.test.js 覆盖），本文件只测折叠/还原本身
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
const { foldOldToolResults, restoreToolResults, TOOL_RESULT_WINDOW, TOOL_RESULT_FOLD_MIN, FACT_TOOL_RESULT_WINDOW, LARGE_CONTEXT_THRESHOLD, MID_CONTEXT_THRESHOLD, OTHER_TOOL_RESULT_WINDOW_MID, otherKeepForContext, cachedTokensOf } = chat

const bigTool = (id, len = 2000) => ({ role: 'tool', tool_call_id: id, content: 'A'.repeat(len) })

test('保留最近 K 条全文，更早的折叠成带原长度的摘要', () => {
  const msgs = [{ role: 'user', content: '开始' }]
  for (let i = 0; i < 5; i++) msgs.push(bigTool(`t${i}`))

  const folded = foldOldToolResults(msgs, 1, 3, 800)
  assert.equal(folded, 2, '5 条里保留 3 条 → 折叠 2 条')

  assert.ok(msgs[1].content.startsWith('[已折叠'), '第 1 条应被折叠')
  assert.ok(msgs[2].content.startsWith('[已折叠'), '第 2 条应被折叠')
  assert.ok(msgs[1].content.includes('原 2000 字符'), '摘要应保留原长度')
  assert.ok(msgs[1].content.includes('AAAA'), '摘要应保留开头片段，便于模型回忆那一步是什么')
  assert.ok(msgs[1].content.length < 400, '折叠后应显著变短')

  for (let i = 3; i <= 5; i++) assert.equal(msgs[i].content.length, 2000, `第 ${i} 条应保持全文`)
})

test('只压 content：role 与 tool_call_id 原样保留（否则接口 400）', () => {
  const msgs = [bigTool('a'), bigTool('b'), bigTool('c'), bigTool('d')]
  foldOldToolResults(msgs, 0, 3, 800)

  assert.equal(msgs[0].role, 'tool')
  assert.equal(msgs[0].tool_call_id, 'a', 'tool_call_id 必须还在')
  assert.equal(msgs[1].tool_call_id, 'b')
  assert.ok(msgs[0].content.length < 400)
  assert.equal(msgs[1].content.length, 2000, '后三条不动')
  assert.deepEqual(
    msgs.map((m) => m.role),
    ['tool', 'tool', 'tool', 'tool'],
  )
})

test('短结果不折叠（省不下 token 还白丢信息）', () => {
  const msgs = Array.from({ length: 5 }, (_, i) => ({ role: 'tool', tool_call_id: `t${i}`, content: 'short' }))
  assert.equal(foldOldToolResults(msgs, 0, 3, 800), 0)
  msgs.forEach((m) => assert.equal(m.content, 'short'))
})

test('startIndex 之前的历史不动（续跑回放的工具结果要保真）', () => {
  const msgs = [
    { role: 'tool', tool_call_id: 'hist', content: 'H'.repeat(2000) }, // 上一轮回放进来的
    { role: 'user', content: '继续' },
  ]
  for (let i = 0; i < 5; i++) msgs.push({ role: 'tool', tool_call_id: `n${i}`, content: 'N'.repeat(2000) })

  const folded = foldOldToolResults(msgs, 2, 3, 800)
  assert.equal(folded, 2)
  assert.equal(msgs[0].content.length, 2000, '历史里的工具结果绝不能被压')
})

test('幂等：重复调用不再二次折叠（已折叠的摘要短于 minLen）', () => {
  const msgs = Array.from({ length: 6 }, (_, i) => ({ role: 'tool', tool_call_id: `t${i}`, content: 'A'.repeat(1500) }))
  assert.equal(foldOldToolResults(msgs, 0, 3, 800), 3)
  const snapshot = msgs.map((m) => m.content)
  assert.equal(foldOldToolResults(msgs, 0, 3, 800), 0, '第二次调用不应再折叠任何东西')
  assert.deepEqual(msgs.map((m) => m.content), snapshot)
})

test('非数组入参安全返回（降级路径）', () => {
  assert.equal(foldOldToolResults(null, 0, 3, 800), 0)
  assert.equal(foldOldToolResults(undefined, 0, 3, 800), 0)
})

test('restoreToolResults：快照落盘前把摘要还原成原文', () => {
  const original = 'X'.repeat(3000)
  const originals = new Map([['k1', original]])
  const foldedMsg = { role: 'tool', tool_call_id: 'k1', content: '[已折叠 · 原 3000 字符] XXXX…' }
  const other = { role: 'user', content: '你好' }

  const out = restoreToolResults([foldedMsg, other], originals)
  assert.equal(out[0].content, original, '折叠过的结果应还原为原文')
  assert.equal(out[0].tool_call_id, 'k1')
  assert.equal(out[0].role, 'tool')
  assert.equal(out[1], other, '无关消息应原样返回（同一引用）')
})

test('restoreToolResults：无 originals / 未折叠时原样返回', () => {
  const msgs = [{ role: 'tool', tool_call_id: 'a', content: 'full' }]
  assert.equal(restoreToolResults(msgs, new Map()), msgs)
  assert.equal(restoreToolResults(msgs, null), msgs)
  assert.equal(restoreToolResults(msgs, new Map([['a', 'full']])), msgs, '内容未变则不必建新对象')
})

test('常量默认值：K=3 且折叠门槛 > 0', () => {
  assert.equal(TOOL_RESULT_WINDOW, 3)
  assert.ok(TOOL_RESULT_FOLD_MIN > 0)
})

// —— 2026-09-29 新增：按工具类型分流 ——
// 起因：统一窗口误伤读源码。模型读了 4 个文件后，第 1 个的正文已被压成一行摘要，
// 于是「读到的是折叠态，没看全」，只能回来问用户（实测 ht-table-page/index.vue）。
// 现在事实原文类（read_file/read_skill/read_memory）与其余结果**各自独立计数**。

/** 造一条 assistant(tool_calls) + 一条 tool 结果，模拟真实消息序列。 */
function pushCall(msgs, id, name, len = 2000, args = '{}') {
  msgs.push({
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
  })
  msgs.push({ role: 'tool', tool_call_id: id, content: 'X'.repeat(len) })
}

test('分流：4 个 read_file 全保留，同时 4 个浏览器结果只保留 3 条', () => {
  const msgs = [{ role: 'user', content: '开始' }]
  for (let i = 0; i < 4; i++) pushCall(msgs, `r${i}`, 'read_file')
  for (let i = 0; i < 4; i++) pushCall(msgs, `b${i}`, 'browser_snapshot')

  const folded = foldOldToolResults(msgs, 1)
  assert.equal(folded, 1, '只应折叠最早的 1 条浏览器结果')

  const get = (id) => msgs.find((m) => m.tool_call_id === id)
  // read_file 4 条 < FACT_TOOL_RESULT_WINDOW → 一条都不折叠（这正是修 bug 的目的）
  for (let i = 0; i < 4; i++) {
    assert.equal(get(`r${i}`).content.length, 2000, `read_file 第 ${i} 条应保留全文`)
  }
  assert.ok(get('b0').content.startsWith('[已折叠'), '最早的浏览器结果应被折叠')
  for (let i = 1; i < 4; i++) {
    assert.equal(get(`b${i}`).content.length, 2000, `浏览器第 ${i} 条应保留全文`)
  }
})

test('分流：事实原文超过大窗口时，只压最早那几条（浏览器结果不挤占它的名额）', () => {
  const msgs = [{ role: 'user', content: '开始' }]
  for (let i = 0; i < 12; i++) pushCall(msgs, `r${i}`, 'read_file')
  // 夹一堆浏览器结果：它们走小窗口，不应影响 read_file 的 8 条额度
  for (let i = 0; i < 6; i++) pushCall(msgs, `b${i}`, 'browser_get_page')

  const folded = foldOldToolResults(msgs, 1)
  assert.equal(folded, (12 - FACT_TOOL_RESULT_WINDOW) + (6 - TOOL_RESULT_WINDOW),
    `read_file 超 ${FACT_TOOL_RESULT_WINDOW} 条压 ${12 - FACT_TOOL_RESULT_WINDOW} 条，浏览器超 ${TOOL_RESULT_WINDOW} 条压 ${6 - TOOL_RESULT_WINDOW} 条`)

  const get = (id) => msgs.find((m) => m.tool_call_id === id)
  for (let i = 0; i < 12 - FACT_TOOL_RESULT_WINDOW; i++) {
    assert.ok(get(`r${i}`).content.startsWith('[已折叠'), `read_file 第 ${i} 条应折叠`)
  }
  for (let i = 12 - FACT_TOOL_RESULT_WINDOW; i < 12; i++) {
    assert.equal(get(`r${i}`).content.length, 2000, `read_file 第 ${i} 条应保留`)
  }
})

test('分流：认不出工具名时退回默认窗口（保守，向后兼容）', () => {
  // 裸 tool 消息、无 assistant.tool_calls → 映射为空 → 全部按默认窗口处理
  const msgs = [{ role: 'user', content: '开始' }]
  for (let i = 0; i < 5; i++) msgs.push({ role: 'tool', tool_call_id: `t${i}`, content: 'A'.repeat(2000) })
  assert.equal(foldOldToolResults(msgs, 1), 2, '5 条按默认窗口 3 → 折叠 2 条')
})

test('分流：可注入 factKeep / factTools 覆盖默认', () => {
  const msgs = [{ role: 'user', content: '开始' }]
  for (let i = 0; i < 3; i++) pushCall(msgs, `r${i}`, 'read_file')
  // 把 read_file 踢出事实集 → 走默认窗口 3 → 3 条不折叠；再用 factKeep=1 强制折叠
  assert.equal(foldOldToolResults(msgs, 1, 3, 800, { factKeep: 1 }), 2, 'factKeep=1 → 压 2 条')
  const get = (id) => msgs.find((m) => m.tool_call_id === id)
  assert.equal(get('r2').content.length, 2000, '最近 1 条保留')
})

test('分流后仍幂等', () => {
  const msgs = [{ role: 'user', content: '开始' }]
  for (let i = 0; i < 10; i++) pushCall(msgs, `r${i}`, 'read_file')
  for (let i = 0; i < 10; i++) pushCall(msgs, `b${i}`, 'browser_snapshot')
  const first = foldOldToolResults(msgs, 1)
  const snapshot = msgs.map((m) => m.content)
  assert.ok(first > 0, '首次应有折叠')
  assert.equal(foldOldToolResults(msgs, 1), 0, '第二次不应再折叠')
  assert.deepEqual(msgs.map((m) => m.content), snapshot)
})

// —— 2026-09-29 新增：窗口自适应 + 同一目标去重 ——
// 起因：1M 窗口的用户被 8 条窗口逼成「每次只读 15 行」（模型原话：
// the tool folds large outputs, so I'll go ~15 lines at a time），
// 读一个 440 行文件要 30 次工具调用，并反复重读同一文件 → 49 次调用、4509K 输入。

test('窗口够大（≥256K）时事实原文类完全不折叠', () => {
  const { factKeepForContext, LARGE_CONTEXT_THRESHOLD } = chat
  assert.equal(factKeepForContext(LARGE_CONTEXT_THRESHOLD), Infinity, '阈值上应不折叠')
  assert.equal(factKeepForContext(1024 * 1024), Infinity, '1M 窗口应不折叠')
  assert.equal(factKeepForContext(32 * 1024), FACT_TOOL_RESULT_WINDOW, '小窗口仍按条数折')

  const msgs = [{ role: 'user', content: '开始' }]
  for (let i = 0; i < 30; i++) pushCall(msgs, `r${i}`, 'read_file', 2000, `{"path":"C:/f${i}.vue"}`)

  const folded = foldOldToolResults(msgs, 1, 3, 800, { contextWindow: 1024 * 1024 })
  assert.equal(folded, 0, '1M 窗口下 30 个不同文件的原文都不该被折')
  for (let i = 0; i < 30; i++) {
    assert.equal(msgs.find((m) => m.tool_call_id === `r${i}`).content.length, 2000, `第 ${i} 个文件应保留全文`)
  }
})

test('窗口较小时仍按条数折叠（小窗口保护没被误关）', () => {
  const msgs = [{ role: 'user', content: '开始' }]
  for (let i = 0; i < 30; i++) pushCall(msgs, `r${i}`, 'read_file', 2000, `{"path":"C:/f${i}.vue"}`)

  const folded = foldOldToolResults(msgs, 1, 3, 800, { contextWindow: 32 * 1024 })
  assert.equal(folded, 30 - FACT_TOOL_RESULT_WINDOW, `小窗口应只保留 ${FACT_TOOL_RESULT_WINDOW} 条`)
})

test('同一文件被反复读 → 只保留最后一次全文（其余换成省略标记）', () => {
  const msgs = [{ role: 'user', content: '开始' }]
  for (let i = 0; i < 5; i++) pushCall(msgs, `r${i}`, 'read_file', 2000, '{"path":"C:/same.vue"}')

  // 即使窗口只有 8 条（远大于 5），去重也该把 4 份副本清掉
  const folded = foldOldToolResults(msgs, 1, 3, 800, { contextWindow: 32 * 1024 })
  assert.equal(folded, 4, '5 次读同一文件 → 折叠 4 次')
  assert.equal(msgs.find((m) => m.tool_call_id === 'r4').content.length, 2000, '最后一次保留全文')
  for (let i = 0; i < 4; i++) {
    const c = msgs.find((m) => m.tool_call_id === `r${i}`).content
    assert.match(c, /^\[已省略/, `第 ${i} 次应换成省略标记`)
    assert.match(c, /原 2000 字符/, '标记里要说明原本多少字符')
  }
})

test('去重只认同「同一目标」：不同文件、同文件不同 offset 都不去重', () => {
  const msgs = [{ role: 'user', content: '开始' }]
  pushCall(msgs, 'a', 'read_file', 2000, '{"path":"C:/a.vue"}')
  pushCall(msgs, 'b', 'read_file', 2000, '{"path":"C:/b.vue"}')          // 不同文件
  pushCall(msgs, 'c', 'read_file', 2000, '{"path":"C:/a.vue","offset":1,"limit":100}')  // 同文件不同区段
  pushCall(msgs, 'd', 'read_file', 2000, '{"path":"C:/a.vue","offset":101,"limit":100}') // 另一个区段

  const folded = foldOldToolResults(msgs, 1, 3, 800, { contextWindow: 1024 * 1024 })
  assert.equal(folded, 0, '四个都是不同目标，一个都不该折')
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.equal(msgs.find((m) => m.tool_call_id === id).content.length, 2000)
  }
})

test('拿不到路径时不参与去重（保守 —— 防止把不同文件误判成重复删掉）', () => {
  const { factKeyOf } = chat
  assert.equal(factKeyOf('read_file', '{}'), null, '空参数不能生成 key')
  assert.equal(factKeyOf('read_file', '{"offset":1}'), null, '只有 offset 没有 path 也不能')
  assert.equal(factKeyOf('read_file', '不是 JSON'), null)
  assert.equal(factKeyOf('read_file', null), null)
  assert.equal(factKeyOf('read_skill', '{}'), null)
  assert.equal(factKeyOf('grep_code', '{"path":"C:/a"}'), null, '非事实类工具不参与去重')

  // 反过来：4 个「无参数」的 read_file 不应被当成同一目标
  const msgs = [{ role: 'user', content: '开始' }]
  for (let i = 0; i < 4; i++) pushCall(msgs, `r${i}`, 'read_file', 2000, '{}')
  const folded = foldOldToolResults(msgs, 1, 3, 800, { contextWindow: 1024 * 1024 })
  assert.equal(folded, 0, '参数缺失时宁可不去重')
})

test('去重与原窗口叠加：去重后仍超窗口的才按条数折', () => {
  const msgs = [{ role: 'user', content: '开始' }]
  // 10 个不同文件（窗口 8 → 折 2），外加某文件被反复读 5 次
  for (let i = 0; i < 10; i++) pushCall(msgs, `f${i}`, 'read_file', 2000, `{"path":"C:/f${i}.vue"}`)
  for (let i = 0; i < 5; i++) pushCall(msgs, `d${i}`, 'read_file', 2000, '{"path":"C:/dup.vue"}')

  const folded = foldOldToolResults(msgs, 1, 3, 800, { contextWindow: 32 * 1024 })
  // 去重折 4 条（dup 的前 4 次）；剩下 11 条存活，超窗口 8 → 再折 3 条
  assert.equal(folded, 4 + (11 - FACT_TOOL_RESULT_WINDOW))
  assert.equal(msgs.find((m) => m.tool_call_id === 'd4').content.length, 2000, 'dup 的最后一次应在存活集里')
})

test('去重不影响非事实类工具（浏览器结果该折还是折）', () => {
  const msgs = [{ role: 'user', content: '开始' }]
  for (let i = 0; i < 5; i++) pushCall(msgs, `b${i}`, 'browser_snapshot', 2000, '{"path":"C:/same"}')
  const folded = foldOldToolResults(msgs, 1, 3, 800, { contextWindow: 1024 * 1024 })
  assert.equal(folded, 5 - TOOL_RESULT_WINDOW, `非事实类仍按 ${TOOL_RESULT_WINDOW} 条窗口折`)
})

// ============================================================
//  2026-09-30 追加：折叠窗口的「上下文自适应」+ 缓存命中采集
//
//  起因：折叠是**就地改写本轮历史**，而服务端前缀缓存是「某处一变、从该点往后全部失效」。
//  实测（23.8K tokens 前缀，opencode 网关 / deepseek-v4.1-flash）：
//    不改写 → 命中 99.5%；折叠**中间**位置 → 69.4%；折叠**末尾** → 98.9%；纯追加 → 88.1%。
//  而滑窗被折掉的永远是**本轮最早那条**（位置最靠前）→ 每折一次都让本轮后面一大截失效。
//  所以窗口够大时（本项目默认 1M）不该折 —— 由 otherKeepForContext 决定；窗口小时仍按旧行为。
// ============================================================

test('otherKeepForContext：≥256K 不折叠、≥128K 放宽到 12、再小维持 3', () => {
  assert.equal(otherKeepForContext(1024 * 1024), Infinity, '1M 窗口（本项目默认）→ 不折叠')
  assert.equal(otherKeepForContext(LARGE_CONTEXT_THRESHOLD), Infinity, '阈值上取等号也算"够大"')
  assert.equal(otherKeepForContext(MID_CONTEXT_THRESHOLD), OTHER_TOOL_RESULT_WINDOW_MID)
  assert.equal(otherKeepForContext(200 * 1024), OTHER_TOOL_RESULT_WINDOW_MID)
  assert.equal(otherKeepForContext(128000), TOOL_RESULT_WINDOW, '128000 < 128K(131072) → 落回默认窗口')
  assert.equal(otherKeepForContext(undefined), TOOL_RESULT_WINDOW, '窗口未知时保守沿用旧行为')
  assert.equal(OTHER_TOOL_RESULT_WINDOW_MID, 12)
})

test('窗口够大（Infinity）时其他类结果一条都不折 —— 前缀缓存优先', () => {
  const keep = otherKeepForContext(1024 * 1024)
  const msgs = [{ role: 'user', content: '开始' }]
  for (let i = 0; i < 5; i++) pushCall(msgs, `b${i}`, 'browser_snapshot', 2000, `{"path":"C:/p${i}"}`)
  const folded = foldOldToolResults(msgs, 1, keep, TOOL_RESULT_FOLD_MIN, { contextWindow: 1024 * 1024 })
  assert.equal(folded, 0, '不折叠 → 0 条被改写（这正是为了保住前缀缓存）')
  const toolMsgs = msgs.filter((m) => m.role === 'tool')
  assert.equal(toolMsgs.length, 5)
  for (const m of toolMsgs) assert.equal(m.content.length, 2000, '每条都应保持全文，不能被就地改写')
})

test('cachedTokensOf：兼容网关与官方两种字段名，取不到返回 0', () => {
  assert.equal(cachedTokensOf({ prompt_tokens_details: { cached_tokens: 3072 } }), 3072)
  assert.equal(cachedTokensOf({ prompt_cache_hit_tokens: 2944 }), 2944)
  assert.equal(cachedTokensOf({ prompt_cache_hit_tokens: 0 }), 0)
  assert.equal(cachedTokensOf({ prompt_tokens: 100 }), 0, '没有缓存字段 → 0，不要瞎猜')
  assert.equal(cachedTokensOf(null), 0)
  assert.equal(cachedTokensOf(undefined), 0)
})
