// 上下文压缩：摘要器必须看得见「工具活动台账」—— 核心回归测试（2026-10-04）
//
// 背景（第三轮评估实测确认的 P1-1）：
//   1. 渲染层落盘的历史只有 { role, content }（src/stores/app.js 的 history.map），
//      工具调用与结果从不进 messages；
//   2. chat.js 把这份 history 交给 maybeCompactHistory；
//   3. context.js 的 serializeMessagesForSummary 直接序列化它。
//   于是压缩输入里**完全没有工具活动** —— 摘要出来的只是「聊了什么」，不是「做了什么」。
//   压缩后模型不知道代码改到哪一步：重复 read_file 已改过的文件、重新分析已得出的结论，
//   甚至把已完成的改动覆盖掉。压缩省下的 token 远少于「失忆后重来一遍」的代价。
//
//   修法（刻意不把工具结果塞进 messages 数组 —— 那会破坏「只在 user 处切分」的前提，
//   切出 assistant.tool_calls 与 tool 结果被拆散的非法序列）：另开一条 sidecar 台账，
//   压缩时作为**独立文本段**喂给摘要器。
//
// 本文件锁住 4 条：
//   1) 压缩请求体里**真的带上了**台账文本（含改过的文件路径）——这是本修复的核心断言
//   2) 摘要骨架与「逐字保留路径」的硬要求进了 system 提示词
//   3) 写盘前查 signal：本次运行已被中止时**不写**摘要 sidecar（否则退化的启发式摘要
//      会覆盖掉新运行刚写好的好摘要，并一直留在 sidecar 里污染后续所有压缩）
//   4) contextWindow 参数真的被用上（多模型配置下，激活 profile 未必是发请求的那个）
//
// context.js 此前**没有任何测试覆盖**（所有测试都 stub 掉它）。本文件用桩把依赖顶掉。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CONTEXT = path.join(__dirname, '..', 'electron', 'context.js')
const CTX_DIR = path.dirname(CONTEXT)

const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-ctx-'))
const CONV = 'conv-compact-test'

function stub(request, exports) {
  const id = require.resolve(request, { paths: [CTX_DIR] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

// callJson 的桩：只记录请求体，返回一个固定摘要
let jsonCalls = []
let summaryToReturn = '## 用户诉求\n把订单页的字段改掉\n\n## 已完成\n改过 src/pages/order/index.vue'

stub('electron', { app: { getPath: () => USERDATA } })
stub('./state', { settings: {} })
stub('./settings', {
  MIN_CONTEXT_WINDOW: 4096,
  MODEL_CONTEXT_WINDOWS: { 'test-model': 128000 },
  DEFAULT_CONTEXT_WINDOW: 128000,
})
stub('./tool-schemas', { TOOLS_DEFINITION: [] })
stub('./ai', {
  callJson: async (req) => {
    jsonCalls.push(req)
    return { summary: summaryToReturn }
  },
})
// 不桩 './tool-activity' —— 用真的，才能验证「写进去的台账真的被读出来喂给了摘要器」

const context = require(CONTEXT)
const toolActivity = require(path.join(CTX_DIR, 'tool-activity.js'))
// 与 context.js 看到的是同一个对象（require.cache 已被上面的 stub 替换）
const stateStub = require(path.join(CTX_DIR, 'state.js'))

const events = []
const makeEvent = () => ({ sender: { send: (ch, payload) => events.push({ ch, payload }) } })

// 造一段「长到必须压缩」的历史：6 轮用户对话，每轮正文都够长
function longHistory() {
  const filler = '这是一段用来把上下文撑到压缩阈值以上的正文。'.repeat(40)
  const msgs = []
  for (let i = 1; i <= 6; i++) {
    msgs.push({ role: 'user', content: `第 ${i} 轮：${filler}` })
    msgs.push({ role: 'assistant', content: `第 ${i} 轮回答：${filler}` })
  }
  return msgs
}

function reset(globalWindow) {
  jsonCalls = []
  events.length = 0
  fs.rmSync(path.join(USERDATA, 'conversations'), { recursive: true, force: true })
  stateStub.settings = { contextWindow: globalWindow }
}

test('核心：压缩请求体里带上了工具活动台账（含改过的文件路径）', async () => {
  reset(4096)
  // 本轮之前 AI 实际做过的事
  toolActivity.appendToolActivity(CONV, [
    toolActivity.describeToolActivity('read_file', { path: 'src/pages/order/index.vue' }, '{"success":true,"content":"x"}'),
    toolActivity.describeToolActivity('edit_file', { path: 'src/pages/order/index.vue' }, '{"success":true,"result":{"replacedCount":2}}', 1),
    toolActivity.describeToolActivity('execute_command', { command: 'npm test' }, '{"success":false,"exitCode":1,"stderr":"2 tests failed"}', 2),
  ])

  const out = await context.maybeCompactHistory({
    event: makeEvent(),
    conversationId: CONV,
    messages: longHistory(),
    apiKey: 'sk-test',
    model: 'test-model',
    systemContent: '你是助手',
    contextWindow: 4096,
    signal: { aborted: false },
  })

  assert.ok(out, '超阈值时应当压缩')
  assert.equal(jsonCalls.length, 1, '应当发出一次摘要请求')

  const userMsg = jsonCalls[0].messages.find((m) => m.role === 'user').content
  assert.match(userMsg, /工具活动台账|AI 实际执行过的工具操作/, '请求体里必须有台账段')
  assert.match(userMsg, /src\/pages\/order\/index\.vue/, '台账要带上改过/读过的文件路径')
  assert.match(userMsg, /edit_file/, '要能看出用过哪个工具')
  assert.match(userMsg, /npm test/, '命令也要在台账里')
  assert.match(userMsg, /✗|失败/, '失败的尝试要标出来（避免后面重复尝试）')

  // 摘要真的被注入了 system
  assert.match(out[0].content, /更早对话摘要/)
  assert.match(out[0].content, /已完成的改动|已完成/)
  assert.ok(out.length > 1, '还应带上最近几轮原文')
})

test('摘要 system 提示词带固定骨架 + 逐字保留路径的硬要求', async () => {
  reset(4096)
  await context.maybeCompactHistory({
    event: makeEvent(),
    conversationId: CONV,
    messages: longHistory(),
    apiKey: 'sk-test',
    model: 'test-model',
    systemContent: '你是助手',
    contextWindow: 4096,
    signal: { aborted: false },
  })
  const sys = jsonCalls[0].messages.find((m) => m.role === 'system').content
  for (const section of ['## 用户诉求', '## 已完成', '## 未完成', '## 关键文件与位置', '## 关键结论与决策', '## 已试过且不成立的做法', '## 下一步']) {
    assert.ok(sys.includes(section), `骨架缺少小节：${section}`)
  }
  assert.match(sys, /逐字保留/, '必须明确要求路径/函数名逐字保留，不要概括')
})

test('写盘前查 signal：本次运行已被中止 → 不写摘要 sidecar', async () => {
  reset(4096)
  const before = context.readConvSummary(CONV)
  const out = await context.maybeCompactHistory({
    event: makeEvent(),
    conversationId: CONV,
    messages: longHistory(),
    apiKey: 'sk-test',
    model: 'test-model',
    systemContent: '你是助手',
    contextWindow: 4096,
    signal: { aborted: true },   // 被新请求取代
  })
  assert.equal(out, null, '已中止应返回 null')
  assert.equal(context.readConvSummary(CONV), before, '不得写入摘要（否则退化的启发式摘要会覆盖更好的版本）')
})

test('contextWindow 参数真的被用上（多模型配置下不能读全局激活 profile）', async () => {
  // ① 全局窗口很大、本次请求窗口很小 → 应按「小窗口」触发压缩
  reset(1024 * 1024)
  const compacted = await context.maybeCompactHistory({
    event: makeEvent(),
    conversationId: CONV,
    messages: longHistory(),
    apiKey: 'sk-test',
    model: 'test-model',
    systemContent: '你是助手',
    contextWindow: 4096,
    signal: { aborted: false },
  })
  assert.ok(compacted, '必须按传入的 4096 触发压缩；若读了全局 1M 就不会压缩（说明参数又被忽略）')

  // ② 全局窗口很小、本次请求窗口很大 → 应按「大窗口」不压缩
  reset(4096)
  const notCompacted = await context.maybeCompactHistory({
    event: makeEvent(),
    conversationId: CONV,
    messages: longHistory(),
    apiKey: 'sk-test',
    model: 'test-model',
    systemContent: '你是助手',
    contextWindow: 1024 * 1024,
    signal: { aborted: false },
  })
  assert.equal(notCompacted, null, '大窗口下不该压缩；若读了全局 4096 就会压缩')
})

// 图片载荷的 token 估算（2026-10-05，与「网页取图 → 注入下一轮 user 消息」同批改动）
// 背景：消息的 content 现在可能是数组（text part + image_url part）。若沿用
// estimateTokens(String(content))，base64 会被当成普通 ASCII 按 3 字符/token 计 ——
// 一张 200KB 的降采样图 ≈ 7 万"token"，1MB 载荷直接虚高到 35 万，输入区的
// 「上下文占用」会显示成爆窗（实际只有几 k），用户会以为出了故障。
test('estimateMessagesTokens：图片 part 按真实成本计，不按 base64 字符数虚高', () => {
  const bigBase64 = 'A'.repeat(400 * 1024)   // ≈400KB base64 的单张图
  const msgs = [
    { role: 'user', content: '看看这几张图' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '这是页面截图' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bigBase64}` } },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bigBase64}` } },
      ],
    },
    { role: 'assistant', content: '看到了' },
  ]
  const total = context.estimateMessagesTokens(msgs)
  // 两张图 = 2 × 1500 = 3000；三段文字合计远小于 1k → 总额必须是个小数字
  assert.ok(total > 3000, `图片成本要算进去（实测 ${total}）`)
  assert.ok(total < 5000, `不能按 base64 字符数计费（实测 ${total}，若 >10 万说明又在 String(content) 了）`)
  // 纯字符串消息的行为必须不变
  assert.equal(
    context.estimateMessagesTokens([{ role: 'user', content: 'abc' }]),
    context.estimateTokens('abc'),
  )
})

test('getModelContextWindow：显式传入的窗口优先于全局配置', () => {
  stateStub.settings = { contextWindow: 128000 }
  assert.equal(context.getModelContextWindow('test-model', 256000), 256000)
  // 不合法/缺省 → 回落到全局配置
  assert.equal(context.getModelContextWindow('test-model', undefined), 128000)
  assert.equal(context.getModelContextWindow('test-model', 100), 128000, '低于 MIN_CONTEXT_WINDOW 视为无效')
  stateStub.settings = {}
  assert.equal(context.getModelContextWindow('test-model'), 128000, '没有全局配置时用内置模型表')
})
