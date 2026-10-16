// read_image（本机图片文件 → 视觉载荷）回归测试（2026-10-05）
//
// 背景（用户真实会话，staging 证据：`userData/conversations/<id>.activity.json`）：
// 用户用**开发角色**改页面，图是 `curl` 从内网 wiki 落到磁盘的 PNG。当时的现场是——
//   1) dev 的工具白名单里**一个 browser_* 都没有**，chat.js 也没下发任何"看图"入口；
//   2) 台账里那条 `read_file → jt015_button.png` 的 note 是「读取 423/1245 行」——
//      也就是把 PNG 当 UTF-8 读成了 1245 行乱码；
//   3) 模型于是判"我读不出这张图"，转去用 PowerShell 调 Windows.Media.Ocr 抠文字，烧掉一整轮。
//
// 本文件锁住 5 条：
//   1) read_image 把本机图片真的塞进了侧通道（并被标注成"你会看到它"）
//   2) **dev 角色也能用**（这是本次事故的关键 —— dev 没有 browser_*，但必须能看本机图片）
//   3) 视觉配置未开启时：**明确报错 + 指路**，绝不静默丢弃（也不假装成功）
//   4) read_file 撞上图片文件 → 直接拒绝并指向 read_image（不再返回乱码）
//   5) 参数容错：path（单张）/ paths（多张）都接受，去重、上限 4 张
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const ELECTRON = path.join(__dirname, '..', 'electron')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-readimg-'))
const CONV = 'conv-read-image'

// ---- 桩：这一组只跑 tools/index.js 的 handler，不跑 chat 循环 ----
let visionOn = true
const stateStub = {
  settings: { role: 'dev', allowedDirs: [TMP], skillsDir: TMP, memoryDir: TMP, autoExecute: true },
  attachedFilePaths: new Set(),
  chatRuns: new Map(),
  todos: new Map(),
  mainWindow: null,
}
const stub = (request, exports) => {
  const id = require.resolve(request, { paths: [ELECTRON] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}
// nativeImage 是桩（真实实现只在 Electron 里有）。默认返回一张 800×600 的"小图"，
// 于是 <1MB 的文件走「尺寸不大 → 原样 base64 内联」分支；下面有一例把尺寸调大，
// 用来验证「大图必须落回 JPEG」这条判断（它在真实运行时实测踩过坑）。
let mockMaxDim = 800
const pngDataUrl = () => `data:image/png;base64,${'A'.repeat(mockMaxDim > 1280 ? 2_000_000 : 64)}`
const mockImage = () => ({
  getSize: () => ({ width: mockMaxDim, height: Math.round(mockMaxDim * 0.75) }),
  resize: () => ({ toDataURL: pngDataUrl, toJPEG: () => Buffer.from('JPEG_BYTES') }),
  toDataURL: pngDataUrl,
  toJPEG: () => Buffer.from('JPEG_BYTES'),
})
stub('electron', {
  app: { getPath: () => TMP },
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  nativeImage: { createFromPath: () => mockImage(), createFromBuffer: () => mockImage() },
  shell: { openPath: async () => '' },
  Notification: function Notification() {},
})
stub('./state', stateStub)
stub('./settings', {
  HARNESS_ROOT: path.join(ELECTRON, '..', 'harness'),
  getBrowserDownloadsDir: () => TMP,
  getTestOutputDir: () => TMP,
  getCommandOutputDir: () => TMP,
  getErpKbRoot: () => TMP,
  getLegalKbRoot: () => TMP,
  getProductOutputDir: () => TMP,
  getExcelOutputDir: () => TMP,
  getLegalOutputDir: () => TMP,
  resolvePlaceholders: (s) => s,
  // 视觉闸门读的就是这个（profile.vision）
  getActiveProfile: () => ({ apiKey: 'sk-test', baseUrl: 'http://x/v1', model: 'm', contextWindow: 1e6, vision: visionOn }),
  ensureDir: (d) => d,
})
stub('./windows', { hardenWindow: () => {} })
stub('./tools/skills', { listAllSkills: () => [], readSkillByName: () => ({}) })
stub('./tools/shell', { executeCommand: async () => '{}', killAllChildren: () => {} })
stub('./tools/network', { searchWeb: async () => '{}' })
stub('./tools/search', { grepCode: async () => '{}', globFiles: async () => '{}' })
stub('./tools/todo', { updateTodos: () => ({ ok: true, todos: [] }) })
stub('./tools/legal-npc-search', { legalNpcSearch: async () => '{}' })
stub('./tools/download', { downloadUrl: async () => '{}' })
stub('./conversations', { searchConversationHistory: async () => [] })
stub('./browser-test', { screenshot: async () => ({ path: path.join(TMP, 's.png'), width: 100, height: 100 }) })
stub('./chat', {})
stub('./sub-agent', { handleSpawnSubAgent: async () => '{}', handleGetSubAgentResults: async () => '{}' })
stub('./agents-md', { recordPathTouched: () => {}, buildAgentsMdSection: () => '' })
// 注意：'./tool-images' 与 './fs-safe' 都**不桩** —— 侧通道与图片编码就是被测对象

const { TOOL_HANDLERS } = require(path.join(ELECTRON, 'tools', 'index.js'))
const toolImages = require(path.join(ELECTRON, 'tool-images'))
const fsSafe = require(path.join(ELECTRON, 'tools', 'fs-safe.js'))

// 造几个真实的小文件（<1MB，走"直接 base64 内联"分支，不需要 nativeImage）
const PNG = path.join(TMP, 'shot.png')
const JPG = path.join(TMP, 'a.jpg')
const TXT = path.join(TMP, 'notes.md')
fs.writeFileSync(PNG, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2000, 7)]))
fs.writeFileSync(JPG, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1500, 9)]))
fs.writeFileSync(TXT, '# 说明文档\n这里是正文。')

const ctx = () => ({ convId: CONV, profileId: 'p1' })
const callReadImage = async (args) => JSON.parse(await TOOL_HANDLERS.read_image(args, ctx()))
const callReadFile = (args) => TOOL_HANDLERS.read_file(args, ctx())

test.beforeEach(() => {
  visionOn = true
  stateStub.settings.role = 'dev'
  toolImages.clearImages(CONV)
})

test('read_image(path)：图片进侧通道，返回值告诉模型"你马上能看到"', async () => {
  const out = await callReadImage({ path: PNG })
  assert.equal(out.success, true)
  assert.equal(out.result.delivered, 1)
  assert.match(out.result.note, /你马上就能直接看到/)
  assert.equal(toolImages.pendingCount(CONV), 1)

  const taken = toolImages.takeImages(CONV)
  assert.equal(taken.length, 1)
  assert.match(taken[0].part.image_url.url, /^data:image\/png;base64,/)
  assert.ok(taken[0].label.includes('shot.png'), '清单里要带文件名，模型才知道哪张是哪张')
  assert.match(toolImages.renderImageNote(taken), /你可以直接看到/)
})

test('dev 角色也能用（本次事故的关键：dev 没有 browser_*，但必须能看本机图片）', async () => {
  stateStub.settings.role = 'dev'
  const out = await callReadImage({ path: JPG })
  assert.equal(out.success, true, 'dev 读本机图片必须放行 —— 它本来就绕过授权目录白名单')
  assert.equal(out.result.delivered, 1)
})

test('视觉配置未开启：明确报错 + 指路，且不进侧通道（绝不静默丢弃）', async () => {
  visionOn = false
  const out = await callReadImage({ path: PNG })
  assert.equal(out.success, false)
  assert.equal(out.visionDisabled, true)
  assert.match(out.error, /支持读图（多模态）/, '错误里必须点明去哪个开关打开')
  assert.match(out.error, /设置 → 模型配置/, '必须给出可执行下一步')
  assert.match(out.error, /不要用 OCR/, '必须禁止 OCR 绕路')
  assert.equal(toolImages.pendingCount(CONV), 0, '没开启时一张都不该暂存（否则下一轮会凭空多出图片）')
})

test('read_file 撞上图片文件 → 直接拒绝并指向 read_image（不再返回 1245 行乱码）', async () => {
  let err = null
  try { callReadFile({ path: PNG }) } catch (e) { err = e }
  assert.ok(err, '必须抛错（旧行为是返回满屏乱码，模型会以为"读出来了但没内容"）')
  assert.match(err.message, /是图片文件/)
  assert.match(err.message, /read_image/)
  assert.ok(err.message.includes(PNG), '要把可直接复制的绝对路径给出去')
  // 文本文件不受影响
  assert.match(callReadFile({ path: TXT }), /说明文档/)
})

test('参数容错与上限：path / paths 都接受，去重、超 4 张报错、空参数报错', async () => {
  const two = await callReadImage({ paths: [PNG, JPG] })
  assert.equal(two.result.delivered, 2)
  toolImages.clearImages(CONV)

  // path + paths 同时给 → 合并去重
  const merged = await callReadImage({ path: PNG, paths: [PNG, JPG] })
  assert.equal(merged.result.delivered, 2, '同一路径只读一次')
  toolImages.clearImages(CONV)

  const tooMany = await callReadImage({ paths: [PNG, JPG, PNG, JPG, TXT].map((p, i) => (i < 4 ? path.join(TMP, `dup${i}.png`) : p)) })
  assert.equal(tooMany.success, false)
  assert.match(tooMany.error, /最多 4 张/)

  const empty = await callReadImage({})
  assert.equal(empty.success, false)
  assert.match(empty.error, /缺少图片路径/)
})

test('读不成功的那些逐条给出原因，成功的照常交付（不因一张坏图整批失败）', async () => {
  const missing = path.join(TMP, '不存在的图.png')
  const out = await callReadImage({ paths: [PNG, missing, TXT] })
  assert.equal(out.result.delivered, 1, '能读的那张要交付')
  assert.equal(out.result.failed.length, 2)
  assert.match(out.result.failed[0].reason, /不存在|Access denied/)
  assert.match(out.result.failed[1].reason, /不是受支持的图片格式/)
})

// ============================================================
//  回归（2026-10-05 真实 Electron 冒烟抓到的）：大图必须落回 JPEG
//  实测数据：4.6MB 的 2000×1500 PNG 降到 1280 后，按 PNG 无损编码出来是 **2,492,014 字符**，
//  直接顶穿 tool-images 的单轮字符预算 → 图片被静默丢弃 → 模型只会说"我看不到图"。
//  同一张图 JPEG q82 只有约 46~72 万字符。所以：PNG 只在"确实小"时保留，大图一律 JPEG。
// ============================================================
test('大尺寸 PNG 落回 JPEG（否则会被单轮预算静默丢弃，模型就成了"看不到图"）', () => {
  mockMaxDim = 2000
  // ⚠️ 必须换一个路径：localImagePart 有「路径:mtime:大小」的载荷缓存（重试/压缩重跑/续聊受益），
  // 用同一个文件会命中上面测试留下的缓存，测到的还是那次的结果（本次实测踩过）。
  const bigPath = path.join(TMP, 'big-dim.png')
  fs.copyFileSync(PNG, bigPath)
  try {
    const part = fsSafe.localImagePart(bigPath)
    assert.ok(part, '大图也必须能产出一个 part')
    assert.match(part.image_url.url, /^data:image\/jpeg;base64,/, '大图不能再按 PNG 无损内联')
    assert.ok(part.image_url.url.length < 1024 * 1024, `体积要受控（实测 ${part.image_url.url.length} 字符）`)
    assert.ok(part.image_url.url.length <= toolImages.MAX_INJECT_CHARS, '必须落在侧通道的单轮预算之内，否则会被丢掉')
    assert.equal(toolImages.stashImages(CONV, [{ label: 'big', part }]).accepted, 1, '大图必须真的能进侧通道')
    toolImages.clearImages(CONV)
  } finally {
    mockMaxDim = 800
  }
})

test('尺寸不大时仍走"原样 base64"快路径（不重编码，保持画质与速度）', () => {
  mockMaxDim = 800
  const part = fsSafe.localImagePart(PNG)
  assert.match(part.image_url.url, /^data:image\/png;base64,/)
  // 原样内联 = 文件字节的 base64，长度应与文件大小成固定比例（而不是被重编码成小 JPEG）
  assert.ok(part.image_url.url.length > fs.statSync(PNG).size, '快路径应当来自原文件字节')
})

test('fs-safe 仍然导出 read_image 依赖的两个入口（改动时别把导出删了）', () => {
  assert.equal(typeof fsSafe.localImagePart, 'function')
  assert.equal(typeof fsSafe.imageMimeForPath, 'function')
  assert.equal(fsSafe.MAX_IMAGES_PER_MESSAGE, 4)
})
