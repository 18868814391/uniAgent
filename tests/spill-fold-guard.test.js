// ============================================================
//  tests/spill-fold-guard.test.js —— spill 落盘过的结果不被窗口化折叠
//
//  为什么单独一条：折叠是 `[已折叠 · 原 X 字符] …`，spill 是
//  `【超大结果已落盘】… 落盘路径：<path>`。前者把定位符一起压掉 ——
//  模型既看不到预览、也拿不到文件路径，只能重新调用工具，
//  spill 的全部意义（原文在盘上、随时可取）当场作废。
//
//  这条不变量横跨两个模块（chat.js 的 foldOldToolResults + spill.js 的替换文案），
//  所以放在独立文件里、只断言这两者的配合，不去动 chat 其他的桩。
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const ELECTRON_DIR = path.join(__dirname, '..', 'electron')
const CHAT = path.join(ELECTRON_DIR, 'chat.js')

const stub = (request, exports) => {
  const id = require.resolve(request, { paths: [ELECTRON_DIR] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

stub('electron', {
  app: { getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'localai-spill-guard-')) },
  ipcMain: { handle() {}, on() {} },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }), getAllWindows: () => [] },
})
// state 桩：spill 的预算从这里取，用例要能覆写它
const stateStub = { settings: {}, chatRuns: new Map(), subAgents: new Map(), subAgentsPending: new Map(), mainWindow: null }
stub('./state', stateStub)
stub('./tool-schemas', { TOOLS_DEFINITION: [] })
const realNetRetry = require(path.join(ELECTRON_DIR, 'net-retry.js'))
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
stub('./tools/fs-safe', { buildImageParts: async () => [], addImagePartsToLatestUser: (msgs) => msgs, imageMimeForPath: () => null })
stub('./tools', { executeToolCall: async () => '{}', killAllChildren: () => {} })
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
const spill = require(path.join(ELECTRON_DIR, 'spill.js'))

// 造一条 assistant(tool_calls) + 一条 tool 结果
function pushCall(msgs, id, name, content, args = '{}') {
  msgs.push({
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
  })
  msgs.push({ role: 'tool', tool_call_id: id, content })
}

test('spill 过（首尾预览形态）的结果不再被折叠：落盘路径必须保住', () => {
  const replacement = [
    '【超大结果已落盘】browser_get_page 的结果共 900000 字符，超过单次内联预算（307200 字符），原文已保存到本地文件。',
    '落盘路径：C:\\Users\\x\\AppData\\Roaming\\local-ai\\spill\\session-abc\\x-browser_get_page.txt',
    '',
    '【首部预览 · 前 2000 字符】',
    'A'.repeat(2000),
    '',
    '…（中间省略 897000 字符）…',
    '',
    '【尾部预览 · 后 1000 字符】',
    'Z'.repeat(1000),
  ].join('\n')

  const msgs = [{ role: 'user', content: '开始' }]
  // 5 条普通大结果 + 1 条 spill 形态的，窗口 3 → 早期普通结果该折，spill 的不该动
  for (let i = 0; i < 5; i++) pushCall(msgs, `b${i}`, 'browser_snapshot', 'B'.repeat(3000))
  pushCall(msgs, 'spilled', 'browser_get_page', replacement)
  for (let i = 5; i < 8; i++) pushCall(msgs, `b${i}`, 'browser_snapshot', 'B'.repeat(3000))

  chat.foldOldToolResults(msgs, 1, 3, 800, { contextWindow: 32 * 1024 })

  const spilledMsg = msgs.find((m) => m.tool_call_id === 'spilled')
  assert.equal(spilledMsg.content, replacement, 'spill 形态的结果必须逐字保持原样')
  assert.match(spilledMsg.content, /落盘路径：/, '定位符不能被折叠掉')
  assert.ok(spilledMsg.content.startsWith('【超大结果已落盘】'))
})

test('同一目标去重也不会吃掉 spill 形态的结果', () => {
  const spilled = '【超大结果已落盘】read_file 的结果共 500000 字符……\n落盘路径：C:\\tmp\\a.txt'
  const msgs = [{ role: 'user', content: '开始' }]
  // 同一个路径读了两次：第 1 次被 spill 落盘，第 2 次是普通全文
  pushCall(msgs, 'first', 'read_file', spilled, '{"path":"C:/same.vue"}')
  pushCall(msgs, 'second', 'read_file', 'X'.repeat(2000), '{"path":"C:/same.vue"}')

  chat.foldOldToolResults(msgs, 1, 3, 800, { contextWindow: 32 * 1024 })

  const first = msgs.find((m) => m.tool_call_id === 'first')
  assert.equal(first.content, spilled, '被去重命中的 spill 结果同样要保住定位符')
})

test('普通结果照旧被折叠（豁免只针对 spill 形态，没放宽整体行为）', () => {
  const msgs = [{ role: 'user', content: '开始' }]
  for (let i = 0; i < 5; i++) pushCall(msgs, `b${i}`, 'browser_snapshot', 'B'.repeat(3000))
  const folded = chat.foldOldToolResults(msgs, 1, 3, 800, { contextWindow: 32 * 1024 })
  assert.equal(folded, 2)
  assert.ok(msgs.find((m) => m.tool_call_id === 'b0').content.startsWith('[已折叠'))
})

test('spill 的替换文案以 【超大结果已落盘】 开头 —— chat.js 的豁免判据依赖这个前缀', () => {
  // 两处必须一致：改动文案就等于静默废掉上面的豁免
  const prev = stateStub.settings.spillMaxInlineChars
  stateStub.settings.spillMaxInlineChars = 10
  try {
    const out = spill.maybeSpillToolResult({
      conversationId: 'c-prefix',
      toolName: 'execute_command',
      callId: 'call_1',
      content: 'X'.repeat(500),
    })
    assert.ok(out, '应触发 spill')
    assert.ok(out.startsWith('【超大结果已落盘】'), '替换文案的前缀是 chat.js 判据的一部分，必须一致')
  } finally {
    stateStub.settings.spillMaxInlineChars = prev
  }
})
