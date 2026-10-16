// 网页取图 → 下一轮 user 消息的注入路径（chat.js）回归测试
//
// 背景（2026-10-05）：模型能"看见"的图片原先只有两条入口 —— 用户贴 https 图片直链、
// 用户发本地图片附件，且都在请求组装那一刻一次性完成、只作用于最后一条 user 消息。
// 工具（browser_read_images）在网页里抓到的图**没有通道**：Chat Completions 的
// role:'tool' 只能放字符串（Anthropic tool_result / OpenAI Responses API 才支持图像）。
// 于是新增了 tool-images 侧通道：工具把编码好的 image_url part 暂存，chat.js 在下一轮
// 请求里把它注入 user 消息。
//
// 本文件锁住 5 条（都是"错了会很隐蔽"的点）：
//   1) 有图时：图片真的进了下一轮请求体，且带上了文字清单（模型得知道每张图是什么）
//   2) **绝不出现连续两条 user 消息**（部分网关直接 400）——
//      提醒文本（任务清单/轮次预算）与图片必须合并进同一条
//   3) 图片只注入一次（take 即清，后续轮次不再重复计费）
//   4) vision 未开启时：工具不下发、图片不注入（纯文本模型收到 image_url 会 400）
//   5) 用户自己带了图片附件（数组 content）时提醒不新开 user 消息（旧实现会踩）
//
// 桩法与 chat-tool-parallel.test.js 一致：把依赖塞进 require.cache 后再 require chat.js。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const CHAT = path.join(__dirname, '..', 'electron', 'chat.js')
const CONV = 'conv-tool-images'
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-toolimg-'))

// 侧通道要用**真模块**（它就是被测对象之一：暂存/取出/清空）
const toolImages = require(path.join(__dirname, '..', 'electron', 'tool-images'))

let currentFetch = null
let currentCompact = null
let currentExec = null
let currentProfile = { apiKey: 'sk-test', baseUrl: 'http://127.0.0.1/v1', model: 'test-model', contextWindow: 128000, vision: false }
let currentUserImages = []
const sent = []
const bodies = []
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

const FAKE_TOOLS = ['read_file', 'read_image', 'browser_open', 'browser_read_images'].map((name) => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
}))

stub('electron', {
  app: { getPath: () => USERDATA },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn }, on: (ch, fn) => { handlers[ch] = fn } },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }), getAllWindows: () => [] },
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
  getActiveProfile: () => currentProfile,
  getApiBaseUrl: () => 'http://127.0.0.1/v1',
  // 用真的 buildSystemPrompt 需要拉起整个 settings 模块（harness/electron app 等），
  // 这里只关心消息装配，提示词返回常量即可（vision 段的测试在 system-prompt 那侧另算）。
  buildSystemPrompt: () => 'system',
})
stub('./context', {
  estimateTokens: () => 0,
  estimateMessagesTokens: () => 0,
  getModelContextWindow: () => 128000,
  maybeCompactHistory: (...args) => currentCompact(...args),
})
// 用户消息侧的图片通道：默认无图；需要时把 parts 真的拼进最后一条 user 消息（模拟真实实现）
stub('./tools/fs-safe', {
  buildImageParts: async () => currentUserImages,
  addImagePartsToLatestUser: (msgs, parts) => {
    if (!parts || !parts.length) return msgs
    const out = msgs.map((m) => ({ ...m }))
    const i = out.map((m) => m.role).lastIndexOf('user')
    if (i < 0) return out
    out[i] = { ...out[i], content: [{ type: 'text', text: String(out[i].content || '') }, ...parts] }
    return out
  },
  imageMimeForPath: () => null,
})
stub('./tools', {
  executeToolCall: async (tc) => {
    const name = tc.function.name
    const out = currentExec ? await currentExec(name) : 'ok'
    return typeof out === 'string' ? out : JSON.stringify(out)
  },
  killAllChildren: () => {},
})
// 强制每轮都有"提醒文本"，才能验证「提醒 + 图片必须合并成同一条 user 消息」
stub('./tools/todo', {
  clearTodos: () => {},
  renderTodoSection: () => '【任务清单】\n1. [in_progress] 看看这个页面的图片',
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
chat.registerIpc()

// ---- 辅助 ----
const sse = (obj) => `data: ${JSON.stringify(obj)}\n`
const imgPart = (tag) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,IMG_${tag}` } })
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
const stopChunk = (text = '看完了') => sse({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })

function mockFetch(rounds) {
  return async (_url, init) => {
    bodies.push(init && init.body ? JSON.parse(init.body) : null)
    const spec = rounds.length ? rounds.shift() : [stopChunk()]
    // 支持 { fail: { status, text } }：模拟服务端拒收图片（纯文本模型收到 image_url）
    if (spec && spec.fail) {
      return { ok: false, status: spec.fail.status || 400, text: async () => spec.fail.text || 'Bad Request' }
    }
    const chunks = spec
    let i = 0
    const enc = new TextEncoder()
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined }),
        }),
      },
    }
  }
}

const makeEvent = () => ({ sender: { send: (ch, payload) => sent.push({ ch, payload }) } })
const errorOf = () => sent.find((e) => e.ch === 'chat:error')

// 让 read_image 走通（真塞一张图进侧通道），其余工具返回 ok
const stashViaReadImage = async (name) => {
  if (name !== 'read_image') return 'ok'
  toolImages.stashImages(CONV, [{ label: 'shot.png — C:\\tmp\\shot.png', part: imgPart('L') }])
  return { success: true, result: { delivered: 1 } }
}
const payload = () => ({
  conversationId: CONV,
  messages: [{ role: 'user', content: '看看这个页面 https://demo.local/list' }],
  profileId: 'test-profile',
  autoExecute: true,
})

const userText = (m) => (typeof m.content === 'string'
  ? m.content
  : (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n'))
const imagePartsOf = (m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url') : [])
const lastUser = (msgs) => {
  const i = msgs.map((m) => m.role).lastIndexOf('user')
  return i < 0 ? null : msgs[i]
}
// 连续两条 user 消息会让部分网关直接 400 —— 每个请求体都必须过这一关
function assertNoConsecutiveUsers(msgs, where) {
  for (let i = 1; i < msgs.length; i++) {
    assert.ok(
      !(msgs[i].role === 'user' && msgs[i - 1].role === 'user'),
      `${where}：出现连续两条 user 消息（第 ${i} 条）—— 部分网关会直接 400`,
    )
  }
}

test.beforeEach(() => {
  sent.length = 0
  bodies.length = 0
  stateStub.chatRuns = new Map()
  stateStub.settings = { allowedDirs: [], role: 'general', autoExecute: true, todosEnabled: true, subAgentsEnabled: true }
  currentProfile = { apiKey: 'sk-test', baseUrl: 'http://127.0.0.1/v1', model: 'test-model', contextWindow: 128000, vision: false }
  currentUserImages = []
  currentFetch = null
  currentCompact = async () => null
  currentExec = async () => 'ok'
  toolImages.clearImages(CONV)
})

test('vision 开启：本轮抓到的图注入下一轮 user 消息（含文字清单），且只注入一次', async () => {
  currentProfile.vision = true
  // 工具实现：真把两张图暂存进侧通道（与 tools/index.js 的 browser_read_images 同款）
  currentExec = async (name) => {
    if (name !== 'browser_read_images') return 'ok'
    const stash = toolImages.stashImages(CONV, [
      { label: '列表页横幅（1200×300）— https://demo.local/a.png', part: imgPart('A') },
      { label: '状态分布图（800×600）— https://demo.local/b.png', part: imgPart('B') },
    ])
    return { success: true, result: { delivered: stash.accepted, images: [{ index: 1 }, { index: 2 }], note: '已把 2 张图作为图像发给你' } }
  }
  currentFetch = mockFetch([
    [tcChunk([{ id: 'call_img', name: 'browser_read_images', args: { max: 3 } }])],
    [stopChunk()],
  ])

  await chat.handleChatSend(makeEvent(), payload())

  assert.equal(bodies.length, 2, '应当是「工具调用轮 + 收尾轮」两次请求')
  const first = bodies[0].messages
  const second = bodies[1].messages
  assertNoConsecutiveUsers(first, '第 1 轮')
  assertNoConsecutiveUsers(second, '第 2 轮')

  // 第 1 轮（发起工具调用那一轮）：图片还不存在，一个 image_url 都不该有
  assert.ok(!first.some((m) => imagePartsOf(m).length), '图片不该出现在第 1 轮请求里')

  // 第 2 轮：tool 消息只能是字符串内容（图片走不了这条通道），图片改从 user 消息注入
  const toolMsg = second.find((m) => m.role === 'tool')
  assert.ok(toolMsg && typeof toolMsg.content === 'string', 'tool 消息的 content 必须是字符串')
  assert.ok(!toolMsg.content.includes('data:image'), 'base64 绝不能塞进工具结果（会按字符计费）')

  const injected = lastUser(second)
  assert.ok(injected, '第 2 轮应当有 user 消息')
  const imgs = imagePartsOf(injected)
  assert.equal(imgs.length, 2, '两张图都该注入')
  assert.match(imgs[0].image_url.url, /^data:image\/jpeg;base64,IMG_A$/)
  // 文字清单：模型得知道每张图是什么、从哪来
  assert.match(userText(injected), /【图片】/)
  assert.match(userText(injected), /列表页横幅（1200×300）— https:\/\/demo\.local\/a\.png/)
  // 提醒文本必须和图片在**同一条**消息里（合并，不是另开一条）
  assert.match(userText(injected), /【任务清单】/)

  // 只注入一次：侧通道已清空，收尾轮之后不可能再有
  assert.equal(toolImages.pendingCount(CONV), 0)
})

test('vision 关闭：工具不下发，任何一轮都不出现 image_url', async () => {
  currentProfile.vision = false
  currentExec = async (name) => {
    if (name === 'browser_read_images') toolImages.stashImages(CONV, [{ label: 'x', part: imgPart('X') }])
    return 'ok'
  }
  currentFetch = mockFetch([
    [tcChunk([{ id: 'call_img', name: 'browser_read_images', args: {} }])],
    [stopChunk()],
  ])

  await chat.handleChatSend(makeEvent(), payload())

  for (const body of bodies) {
    const names = (body.tools || []).map((t) => t.function.name)
    assert.ok(!names.includes('browser_read_images'), 'vision 关闭时不该下发取图工具')
    for (const m of body.messages) {
      assert.equal(imagePartsOf(m).length, 0, 'vision 关闭时一条 image_url 都不该发出')
    }
  }
  // 万一是"文本形态工具调用"绕过下发过滤调到的（chat.js 有兜底还原），也必须清干净
  assert.equal(toolImages.pendingCount(CONV), 0, 'vision 关闭时残留的待注入图片必须被清掉')
})

test('vision 开启但没抓到图：消息形状与加图片通道之前完全一致（content 保持字符串）', async () => {
  currentProfile.vision = true
  currentExec = async () => ({ success: true, result: { delivered: 0, images: [], note: '页面里没有找到符合条件的图片' } })
  currentFetch = mockFetch([
    [tcChunk([{ id: 'call_img', name: 'browser_read_images', args: {} }])],
    [stopChunk()],
  ])

  await chat.handleChatSend(makeEvent(), payload())

  // assistant(tool_calls) 的 content 本来就是 null，只看 user 消息：
  // 没抓到图时绝不该有数组 content（保持与加图片通道之前完全一致的消息形状）
  for (const body of bodies) {
    for (const m of body.messages.filter((x) => x.role === 'user')) {
      assert.equal(typeof m.content, 'string', `无图时 user 消息必须保持字符串 content（实测是 ${Array.isArray(m.content) ? '数组' : typeof m.content}）`)
    }
  }
})

test('用户自己带了图片附件（数组 content）：提醒追加进同一条消息，不新开 user', async () => {
  currentProfile.vision = true
  // 用户消息侧：本轮用户附了一张图 → chat.js 会把最后一条 user 变成数组 content
  currentUserImages = [imgPart('USER')]
  currentFetch = mockFetch([[stopChunk()]])

  await chat.handleChatSend(makeEvent(), payload())

  const msgs = bodies[0].messages
  assertNoConsecutiveUsers(msgs, '用户带图 + 有提醒')
  const last = lastUser(msgs)
  assert.ok(Array.isArray(last.content), '用户附件图片应当让最后一条 user 变成数组 content')
  assert.equal(imagePartsOf(last).length, 1)
  assert.match(userText(last), /【任务清单】/, '提醒文本必须并进这条消息的 text part')
})

// ============================================================
//  回归（2026-10-05 用户真实会话）：视觉工具到底有没有下发
//  用户用**开发角色**改 your-frontend 页面，图是从内网 wiki 下载到本地磁盘的 PNG，
//  结果模型全程自称"没有把图片喂给模型的工具通道"，最后转去抠 OCR。
//  取证（userData/conversations/<id>.activity.json）：三个会话里 browser_read_images 调用 0 次
//  —— 不是被拦，而是 dev 的 DEV_TOOL_NAMES 白名单里一个 browser_* 都没有，工具压根没下发。
//  所以这里把「哪个角色 + 什么配置 → 下发哪些视觉工具」钉死。
// ============================================================
const toolNamesOf = (body) => (body.tools || []).map((t) => t.function.name)

test('默认助手 + 读图开启：本机取图与网页取图两个工具都下发', async () => {
  currentProfile.vision = true
  stateStub.settings.role = 'dev'
  currentFetch = mockFetch([[stopChunk()]])

  await chat.handleChatSend(makeEvent(), payload())

  const names = toolNamesOf(bodies[0])
  assert.ok(names.includes('read_image'), '要能看本机图片文件')
  assert.ok(names.includes('browser_read_images'), '开源版不做工具收窄，网页取图工具也要下发')
})

test('dev 角色 + 读图关闭：连 read_image 也不下发（纯文本模型收图片会 400）', async () => {
  currentProfile.vision = false
  stateStub.settings.role = 'dev'
  currentFetch = mockFetch([[stopChunk()]])

  await chat.handleChatSend(makeEvent(), payload())

  const names = toolNamesOf(bodies[0])
  assert.equal(names.includes('read_image'), false)
  assert.equal(names.includes('browser_read_images'), false)
})

test('通用角色：读图关闭时两个视觉工具都不下发，开启则两个都在', async () => {
  stateStub.settings.role = 'general'

  currentProfile.vision = false
  currentFetch = mockFetch([[stopChunk()]])
  await chat.handleChatSend(makeEvent(), payload())
  let names = toolNamesOf(bodies[0])
  assert.equal(names.includes('read_image'), false)
  assert.equal(names.includes('browser_read_images'), false)

  sent.length = 0
  bodies.length = 0
  stateStub.chatRuns = new Map()
  currentProfile.vision = true
  currentFetch = mockFetch([[stopChunk()]])
  await chat.handleChatSend(makeEvent(), payload())
  names = toolNamesOf(bodies[0])
  assert.ok(names.includes('read_image'), '通用角色：本机图片走 read_image')
  assert.ok(names.includes('browser_read_images'), '通用角色：网页图片走 browser_read_images')
})

// ============================================================
//  回归（2026-10-05）：勾了「支持读图」但配的其实是纯文本模型 → 服务端 400
//  用户实测就出现过（勾在 deepseek-flash 上）。网关回的 400 语焉不详，用户看到的是
//  "AI 突然报错"，完全联想不到跟自己勾的那个开关有关，只会觉得"还是看不到图"。
//  所以：请求里带了图片且服务端像是拒收图片时，错误信息要直接给出可执行的诊断。
// ============================================================
test('服务端因图片报错时，错误信息里带上「模型不支持图片」的诊断', async () => {
  currentProfile.vision = true
  stateStub.settings.role = 'dev'
  currentExec = stashViaReadImage
  currentFetch = mockFetch([
    [tcChunk([{ id: 'call_img', name: 'read_image', args: { path: 'C:\\tmp\\shot.png' } }])],
    { fail: { status: 400, text: '{"error":{"message":"invalid content type: image_url is not supported by this model"}}' } },
  ])

  await chat.handleChatSend(makeEvent(), payload())

  const err = errorOf()
  assert.ok(err, '第二轮应当报错结束')
  assert.match(err.payload.message, /\[本地提示\]/, '必须给出本地诊断，否则用户只会看到网关的原始 400')
  assert.match(err.payload.message, /多模态|支持读图/, '要指向那个开关 / 模型选择')
})

test('不含图片的请求报错时**不**乱贴图片诊断（避免误导）', async () => {
  currentProfile.vision = true
  stateStub.settings.role = 'dev'
  currentExec = async () => 'ok'   // 不塞图
  currentFetch = mockFetch([
    [tcChunk([{ id: 'call_r', name: 'read_file', args: { path: 'a.md' } }])],
    { fail: { status: 400, text: '{"error":{"message":"invalid content type: image_url is not supported by this model"}}' } },
  ])

  await chat.handleChatSend(makeEvent(), payload())

  const err = errorOf()
  assert.ok(err)
  assert.equal(err.payload.message.includes('[本地提示]'), false, '没带图片就不该扯到读图配置')
})
