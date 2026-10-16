// 会话归档回归测试（Markdown 结构 / 文件名清洗 / 非破坏性 / 弹窗路径）
//
// 背景：侧边栏每条历史记录新增「归档」按钮，把该会话导出为 .md 文件并弹窗告知保存路径。
// 这个功能有四个容易回归的点，这里逐一锁住：
//   1) 文件名必须清洗 Windows 非法字符 —— 标题取自首条用户消息，什么字符都可能有，
//      不清洗会直接写盘失败（`\/:*?"<>|`）。
//   2) 正文是 AI 输出的 Markdown，其标题必须整体降一级（否则和结构标题「## N · 用户」同级、
//      大纲错乱），但**不能**把代码围栏内的行首 `#` 注释一起改掉。
//   3) 归档必须是非破坏性的 —— 不能动会话索引、不能动消息文件（与「删除」严格区分）。
//   4) 弹窗 detail 必须带完整路径，否则用户找不到文件。
//
// conversations.js 是 CJS 且加载时 require('electron')，故用桩模块顶掉 electron / state / ai / context，
// 并借 registerIpc() 捕获注册的 handler，在临时 userData 目录上跑真实的归档流程（含写盘与弹窗）。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CONV = path.join(__dirname, '..', 'electron', 'conversations.js')
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ai-archive-'))
const CONV_DIR = path.join(USER_DATA, 'conversations')
const ARCHIVE_DIR = path.join(USER_DATA, 'archives')

const handlers = {}
let lastDialog = null

function loadConversations() {
  const stub = (request, exports) => {
    const id = require.resolve(request, { paths: [path.dirname(CONV)] })
    require.cache[id] = { id, filename: id, loaded: true, exports }
  }
  stub('electron', {
    app: { getPath: () => USER_DATA },
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn } },
    dialog: {
      // 归档只支持两种调用形态：(win, options) 或 (options)（无窗口时）
      showMessageBox: async (...args) => {
        lastDialog = args.length === 1 ? args[0] : args[1]
        return { response: 1 } // 1 = 知道了，不触发资源管理器
      },
    },
    shell: { showItemInFolder: () => {} },
  })
  stub('./ai', { generateConversationTitle: async () => null })
  stub('./context', { deleteConvSummary: () => {} })
  stub('./state', { pendingTitleFor: new Set(), mainWindow: null, settings: {} })

  delete global.__localAiConvDir // 会话目录按 userData 惰性缓存，换目录前必须清
  delete require.cache[require.resolve(CONV)]
  const mod = require(CONV)
  mod.registerIpc()
  return mod
}

const conversations = loadConversations()

// 落一份会话索引 + 消息文件，模拟历史上已存在的会话
function seedConversation({ id, title, createdAt, updatedAt, messages }) {
  fs.mkdirSync(CONV_DIR, { recursive: true })
  const indexPath = path.join(CONV_DIR, 'index.json')
  const list = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf-8')) : []
  list.push({ id, title, createdAt, updatedAt, messageCount: messages.length })
  fs.writeFileSync(indexPath, JSON.stringify(list, null, 2), 'utf-8')
  fs.writeFileSync(path.join(CONV_DIR, `${id}.json`), JSON.stringify(messages, null, 2), 'utf-8')
}

function readIndexRaw() {
  return fs.readFileSync(path.join(CONV_DIR, 'index.json'), 'utf-8')
}

const archive = (id, messages) => handlers['conversations:archive'](null, id, messages)

test('归档生成 Markdown：头部元信息 / 分角色消息数 / 中断标记 / 空消息占位', async () => {
  const id = 'conv-basic'
  const messages = [
    { role: 'user', content: '帮我看看【上半年运费分析】v2.xlsx 的字段' },
    { role: 'assistant', content: '```python\nimport openpyxl\n```\n\n字段有这些' },
    { role: 'assistant', content: '半截回答', partial: true },
    { role: 'user', content: '' },
  ]
  seedConversation({ id, title: '运费分析', createdAt: 1757899200000, updatedAt: 1757985600000, messages })

  const indexBefore = readIndexRaw()
  const msgsBefore = fs.readFileSync(path.join(CONV_DIR, `${id}.json`), 'utf-8')

  const res = await archive(id)
  assert.equal(res.success, true)
  assert.ok(fs.existsSync(res.path), '归档文件应已落盘')
  assert.ok(res.path.startsWith(ARCHIVE_DIR), '归档目录应为 userData/archives')

  const md = fs.readFileSync(res.path, 'utf-8')
  assert.match(md, /^# 运费分析\n/)
  assert.match(md, /> 消息数：4（用户 2 \/ AI 2）/)
  assert.match(md, /> 会话 ID：conv-basic/)
  assert.match(md, /## 1 · 用户/)
  assert.match(md, /## 3 · AI/)
  assert.match(md, /⚠️ 该回答被中断，内容不完整/)
  assert.match(md, /（空消息）/)

  // 非破坏性：索引与消息文件逐字节不变，会话仍留在历史列表
  assert.equal(readIndexRaw(), indexBefore, '归档不得改动会话索引')
  assert.equal(fs.readFileSync(path.join(CONV_DIR, `${id}.json`), 'utf-8'), msgsBefore, '归档不得改动消息文件')

  // 弹窗必须告知完整路径
  assert.deepEqual(lastDialog.buttons, ['打开所在文件夹', '知道了'])
  assert.ok(lastDialog.detail.includes(res.path), '弹窗 detail 应包含完整文件路径')
  assert.ok(lastDialog.detail.includes('仍保留在左侧历史列表中'), '弹窗应说明会话未被删除')
})

test('正文标题降一级，但代码围栏内的行首 # 注释不被改写', async () => {
  const id = 'conv-heading'
  const messages = [
    { role: 'user', content: '给个脚本' },
    {
      role: 'assistant',
      content: '## 字段清单\n\n### 明细\n\n```python\n# 行首注释不能被当成标题\nimport openpyxl\n```\n\n~~~sh\n# 另一种围栏同样要跳过\necho hi\n~~~',
    },
  ]
  seedConversation({ id, title: '标题降级', createdAt: Date.now(), updatedAt: Date.now(), messages })

  const res = await archive(id)
  const md = fs.readFileSync(res.path, 'utf-8')
  assert.match(md, /^### 字段清单$/m, '正文二级标题应降为三级')
  assert.match(md, /^#### 明细$/m, '正文三级标题应降为四级')
  assert.doesNotMatch(md, /^## 字段清单$/m, '不应残留与结构标题同级的正文标题')
  assert.match(md, /^# 行首注释不能被当成标题$/m, '代码围栏内 # 注释必须原样保留')
  assert.match(md, /^# 另一种围栏同样要跳过$/m, '~~~ 围栏同样要被跳过')
})

test('标题含 Windows 非法字符 → 清洗后仍能写盘', async () => {
  const id = 'conv-illegal'
  const messages = [{ role: 'user', content: 'a/b\\c:d*e?f"g<h>i|j 的会话' }]
  seedConversation({ id, title: 'x/y:z*报告?<v2>|草稿', createdAt: Date.now(), updatedAt: Date.now(), messages })

  const res = await archive(id)
  assert.equal(res.success, true)
  assert.ok(!/[\\/:*?"<>|]/.test(res.fileName), `文件名不应含非法字符：${res.fileName}`)
  assert.match(res.fileName, /^\d{8}_.+\.md$/, '文件名应为「创建日期_标题.md」')
})

test('同名归档不覆盖：再次归档生成 -2 后缀的新文件', async () => {
  const id = 'conv-dup'
  const messages = [{ role: 'user', content: '同一标题重复归档' }]
  seedConversation({ id, title: '重复标题', createdAt: Date.now(), updatedAt: Date.now(), messages })

  const first = await archive(id)
  const second = await archive(id)
  assert.equal(first.success, true)
  assert.equal(second.success, true)
  assert.notEqual(first.path, second.path, '第二次归档不应覆盖第一次的文件')
  assert.ok(fs.existsSync(first.path) && fs.existsSync(second.path))
  assert.match(second.fileName, /-2\.md$/)
})

test('优先使用渲染层传回的内存消息（会话正在流式时磁盘数据不完整）', async () => {
  const id = 'conv-memory'
  seedConversation({
    id,
    title: '内存优先',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [{ role: 'user', content: '磁盘上的旧消息' }],
  })

  const res = await archive(id, [
    { role: 'user', content: '磁盘上的旧消息' },
    { role: 'assistant', content: '还在流式输出的新内容' },
  ])
  const md = fs.readFileSync(res.path, 'utf-8')
  assert.match(md, /> 消息数：2（用户 1 \/ AI 1）/)
  assert.match(md, /还在流式输出的新内容/)
})

test('0 消息的会话被拒绝归档，并给出可读原因', async () => {
  const res = await archive('conv-empty', [])
  assert.equal(res.success, false)
  assert.match(res.error, /还没有任何消息/)
})

test('sanitizeFileName：空标题回退 / 超长截断 / 去掉结尾点与空格', () => {
  const { sanitizeFileName } = conversations
  assert.equal(sanitizeFileName('   '), '未命名会话')
  assert.equal(sanitizeFileName(''), '未命名会话')
  assert.equal(sanitizeFileName('结尾点. . '), '结尾点')
  assert.equal(sanitizeFileName('x'.repeat(60)).length, 40)
  assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j')
})
