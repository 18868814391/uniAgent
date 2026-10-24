// ============================================================
//  tests/spill.test.js —— 超大工具结果落盘（electron/spill.js）
//
//  锁住四条不变量：
//   1) 未超预算 → 不落盘、返回 null（调用方保持原文内联）
//   2) 超预算 → 原文逐字节落盘，返回给模型的文本里有**首部/尾部预览 + 落盘路径 + 检索提示**
//   3) 落盘失败 → 降级为原文内联，绝不把一次成功的工具调用变成报错
//   4) 文件名收窄成单个安全路径段（suggestedName 是提示，不是路径）；会话清理整目录删掉
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const ELECTRON_DIR = path.join(__dirname, '..', 'electron')

// userData 指到临时目录（spill 惰性 require electron 取 app.getPath）
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-spill-'))
const stub = (request, exports) => {
  const id = require.resolve(request, { paths: [ELECTRON_DIR] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}
stub('electron', { app: { getPath: () => userDataDir } })

// state.settings 由用例逐个覆写（spill 的预算来自这里）
const stateStub = { settings: {} }
stub('./state', stateStub)

const spill = require(path.join(ELECTRON_DIR, 'spill.js'))

test.beforeEach(() => {
  stateStub.settings = {}
})

const bigText = (len) => 'H'.repeat(len)

test('未超预算：不落盘，返回 null（保持原文内联）', () => {
  // 默认预算 300K，这里给 1K 结果
  const out = spill.maybeSpillToolResult({
    conversationId: 'c-small',
    toolName: 'read_file',
    callId: 'call_1',
    content: bigText(1024),
  })
  assert.equal(out, null)
  assert.equal(fs.existsSync(spill.sessionDir('c-small')), false, '不该为一个普通结果建目录')
})

test('超预算：原文完整落盘，模型拿到首尾预览 + 路径 + 检索提示', () => {
  stateStub.settings.spillMaxInlineChars = 5000
  // 必须**严格超过** 5000（预算是字符数，等于预算时仍保持内联）
  const content = 'HEAD'.repeat(250) + 'MIDDLE'.repeat(1000) + 'TAIL'.repeat(250) // 1000 + 6000 + 1000
  const out = spill.maybeSpillToolResult({
    conversationId: 'c-big',
    toolName: 'browser_get_page',
    callId: 'call_9',
    content,
  })
  assert.ok(out && typeof out === 'string', '超预算必须返回替换文本')
  assert.ok(out.length < content.length, '替换后必须显著变短')

  // 首尾预览 + 省略说明
  assert.match(out, /【超大结果已落盘】/)
  assert.match(out, /首部预览/)
  assert.match(out, /尾部预览/)
  assert.match(out, /中间省略 \d+ 字符/)
  assert.ok(out.includes(content.slice(0, 50)), '首部预览必须来自原文开头')
  assert.ok(out.includes(content.slice(-50)), '尾部预览必须来自原文结尾')
  // 中段必须真的没内联：以省略字符数为准（首部预览本来就含开头那截 MIDDLE，不能按关键词判断）
  const elided = Number(/中间省略 (\d+) 字符/.exec(out)[1])
  assert.equal(elided, content.length - spill.PREVIEW_HEAD_CHARS - spill.PREVIEW_TAIL_CHARS)
  assert.ok(elided > content.length / 2, '省略的必须是大头，预览只占两端')

  // 落盘路径存在，且内容**逐字节等于原文**（这是"信息没丢"的全部依据）
  const locator = /落盘路径：(.*)/.exec(out)[1].trim()
  assert.equal(fs.existsSync(locator), true, `落盘文件应存在：${locator}`)
  assert.equal(fs.readFileSync(locator, 'utf-8'), content, '落盘内容必须与原文完全一致')
  // 检索提示要指到具体机制，不能只说"去读文件"
  assert.match(out, /read_file/)
  assert.match(out, /grep_code/)
})

test('落盘失败：降级为原文内联，不抛也不把成功调用变成报错', () => {
  stateStub.settings.spillMaxInlineChars = 10
  // 让写盘必然失败：把 spill 根指向一个「已存在的文件」当目录用
  const blockedRoot = path.join(userDataDir, 'blocked-root')
  fs.writeFileSync(blockedRoot, 'not a dir')
  global.__localAiSpillRoot = blockedRoot
  try {
    const out = spill.maybeSpillToolResult({
      conversationId: 'c-fail',
      toolName: 'execute_command',
      callId: 'call_x',
      content: bigText(1000),
    })
    assert.equal(out, null, '存不下就返回 null，由调用方保持原文内联')
  } finally {
    global.__localAiSpillRoot = undefined
  }
})

test('suggestedName 只当命名提示：路径分隔符 / 非法字符被收窄成单个安全段', () => {
  assert.equal(spill.safeSegment('../../etc/passwd'), 'passwd')
  assert.equal(spill.safeSegment('C:\\Windows\\System32\\config'), 'config')
  assert.equal(spill.safeSegment('a/b:c*d?"e<f>g|h'), 'b_c_d__e_f_g_h')
  assert.equal(spill.safeSegment('   '), 'result')
  assert.ok(spill.safeSegment('x'.repeat(200)).length <= 48)

  stateStub.settings.spillMaxInlineChars = 10
  const out = spill.maybeSpillToolResult({
    conversationId: 'c-name',
    toolName: 'read_file',
    callId: '../../boom',
    content: bigText(200),
  })
  const locator = /落盘路径：(.*)/.exec(out)[1].trim()
  assert.equal(path.dirname(locator), spill.sessionDir('c-name'), '文件必须落在会话目录里，不能被提升出去')
})

test('非字符串结果不参与 spill（图片/对象等由各自的通道处理）', () => {
  stateStub.settings.spillMaxInlineChars = 1
  assert.equal(spill.maybeSpillToolResult({ conversationId: 'c', toolName: 't', content: { a: 1 } }), null)
  assert.equal(spill.maybeSpillToolResult({ conversationId: 'c', toolName: 't', content: null }), null)
})

test('spillMaxInlineChars = 0 表示关闭；clearSession 删掉整个会话目录', () => {
  stateStub.settings.spillMaxInlineChars = 0
  assert.equal(spill.maxInlineChars(), Infinity)
  assert.equal(
    spill.maybeSpillToolResult({ conversationId: 'c-off', toolName: 't', callId: 'c', content: bigText(100000) }),
    null,
    '关闭后多长的结果都不落盘',
  )

  stateStub.settings.spillMaxInlineChars = 10
  spill.maybeSpillToolResult({ conversationId: 'c-clean', toolName: 't', callId: 'c', content: bigText(100) })
  assert.equal(fs.existsSync(spill.sessionDir('c-clean')), true)
  assert.equal(spill.clearSession('c-clean'), true)
  assert.equal(fs.existsSync(spill.sessionDir('c-clean')), false)
  assert.equal(spill.clearSession('c-clean'), false, '重复清理是安全的')
})

test('不同会话的落盘互不干扰（目录按会话 hash 分桶）', () => {
  stateStub.settings.spillMaxInlineChars = 10
  const a = spill.sessionDir('conv-a')
  const b = spill.sessionDir('conv-b')
  assert.notEqual(a, b)
  assert.ok(a.includes('session-'))
  assert.equal(spill.sessionDir('conv-a'), a, '同一会话的目录必须稳定（幂等）')
})
