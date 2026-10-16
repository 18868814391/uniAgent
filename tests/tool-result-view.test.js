// 工具调用明细（聊天区可展开的 diff 面板）的渲染侧逻辑
//
// 为什么要有这个测试：这段逻辑跑在浏览器里，但它的**输入契约来自主进程**，
// 而且是两层嵌套 —— tools/index.js 把所有工具结果统一包成
//     { success: true, result: <工具自己的返回> }
// 所以 edit_file / write_file 的 `diff`、`created`、`replacedCount` 都在
// **parsed.result 里，不在顶层**。
//
// 第一版实现就按顶层的 `parsed.diff` 取值 —— 路径能正常显示、"查看改动"按钮
// 却永远不出现，且**完全静默**（没有报错、没有日志）。这类错误只有拿真实负载
// 跑一遍才看得见，所以这里锁死这个形状。
//
// 被测代码直接从 ChatView.vue 的标记区间里取出来（见该文件里的
// 「>>> 可抽取纯逻辑 开始/结束」）。这样做的原因：那几个函数是纯字符串逻辑，
// 却住在 .vue 文件里，而本项目跑测试的 Node 侧是 CJS、src 侧是 ESM，
// 直接 import .vue 走不通。标记区间一旦被挪走/改名，本文件会**大声失败**
// （不是静默跳过），所以不会变成"假绿"。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CHAT_VIEW = path.join(__dirname, '..', 'src', 'components', 'ChatView.vue')
const START = '// >>> 可抽取纯逻辑 开始'
const END = '// <<< 可抽取纯逻辑 结束'

// 取出标记区间并求值，得到那批纯函数
function loadHelpers() {
  const src = fs.readFileSync(CHAT_VIEW, 'utf-8')
  const i = src.indexOf(START)
  const j = src.indexOf(END)
  assert.ok(i >= 0, `ChatView.vue 里找不到开始标记「${START}」—— 标记被挪走或改名了，请同步本测试`)
  assert.ok(j > i, `ChatView.vue 里找不到结束标记「${END}」或位置不对，请同步本测试`)
  const block = src.slice(i, j)
  // 区间内只允许纯逻辑：出现 ref/computed/store 说明有人把有状态代码放进来了
  assert.ok(!/\bref\(|\bcomputed\(|\bstore\.|\bwatch\(/.test(block),
    '可抽取区间里出现了 ref/computed/store/watch —— 那部分必须留在区间之外')
  // eslint-disable-next-line no-new-func
  return new Function(block + '\n; return { parseToolResult, filePathOf, toolResultBody, toolCallInfo, diffLineClass }')()
}

const H = loadHelpers()

// 工具结果的两层形状（与 electron/tools/index.js 保持一致）：
//   JSON.stringify({ success: true, result: <工具返回> })
const wrapped = (inner) => JSON.stringify({ success: true, result: inner })
const toolCall = (name, args, inner) => ({
  name,
  args: typeof args === 'string' ? args : JSON.stringify(args),
  result: wrapped(inner),
  done: true,
})

test('diff 藏在 result 里（两层形状）也能取到 —— 这是第一版静默失效的那个 bug', () => {
  const diff = '@@ -1,3 +1,3 @@\n const a = 1\n-const b = 2\n+const b = 22'
  const tc = toolCall('edit_file', { path: '/x/demo.js' }, { path: '/x/demo.js', replacedCount: 1, diff })

  const parsed = H.parseToolResult(tc.result)
  const body = H.toolResultBody(parsed)

  assert.equal(parsed.success, true)
  assert.equal(typeof parsed.diff, 'undefined', 'diff 不该在顶层 —— 在顶层说明包裹层被改平了')
  assert.equal(body.diff, diff, '必须能从 parsed.result 里取到 diff')
})

test('嵌套形状被改平也能兼容（顶层直接带 diff）', () => {
  const tc = { name: 'edit_file', args: JSON.stringify({ path: '/x/a.js' }), result: JSON.stringify({ success: true, diff: 'X' }), done: true }
  assert.equal(H.toolResultBody(H.parseToolResult(tc.result)).diff, 'X')
})

test('文件路径从 args 里取；非文件工具给一行参数预览', () => {
  assert.equal(H.filePathOf(toolCall('edit_file', { path: 'C:/p/a.vue' }, {})), 'C:/p/a.vue')
  // 非文件工具没有 path
  assert.equal(H.filePathOf(toolCall('execute_command', { command: 'ls' }, {})), '')
  const info = H.toolCallInfo(toolCall('execute_command', { command: 'npm run test' }, { stdout: 'ok' }), null)
  assert.match(info, /npm run test/)
})

test('行说明带上「新建 / 替换 N 处 / 行尾兜底」这几种补充信息', () => {
  const created = toolCall('write_file', { path: 'C:/p/new.js', content: 'x' }, { path: 'C:/p/new.js', created: true })
  assert.match(H.toolCallInfo(created, H.parseToolResult(created.result)), /新建/)

  const multi = toolCall('edit_file', { path: 'C:/p/m.js' }, { replacedCount: 3 })
  assert.match(H.toolCallInfo(multi, H.parseToolResult(multi.result)), /替换 3 处/)

  const eol = toolCall('edit_file', { path: 'C:/p/m.js' }, { replacedCount: 1, eolAdjusted: true })
  assert.match(H.toolCallInfo(eol, H.parseToolResult(eol.result)), /行尾差异/)
})

test('工具失败时显示原因（此前这类信息在界面上完全没有出口）', () => {
  const failed = {
    name: 'edit_file',
    args: JSON.stringify({ path: 'C:/p/a.vue' }),
    result: JSON.stringify({ success: false, error: 'old_string 在文件中未找到（已尝试忽略行尾差异的按行匹配）' }),
    done: true,
  }
  const info = H.toolCallInfo(failed, H.parseToolResult(failed.result))
  assert.match(info, /^失败：/)
  assert.match(info, /未找到/)
})

test('非 JSON / 空结果不崩、不产生 diff', () => {
  assert.equal(H.parseToolResult('纯文本结果'), null)
  assert.equal(H.parseToolResult(''), null)
  assert.equal(H.parseToolResult(undefined), null)
  assert.equal(H.toolResultBody(null), null)
  // read_file 的结果可能是整份文件（很大）→ 不做 diff 展示
  const big = JSON.stringify({ success: true, content: 'x'.repeat(5000) })
  assert.equal(H.toolResultBody(H.parseToolResult(big)).diff, undefined)
})

test('超大字符串不解析（避免为拿一个 diff 去 parse 整份文件）', () => {
  const huge = 'x'.repeat(3 * 1024 * 1024)
  assert.equal(H.parseToolResult(huge), null, '超过阈值应直接跳过解析')
})

test('diff 逐行配色：@@ 头 / 新增 / 删除 / 上下文 / 截断提示', () => {
  assert.equal(H.diffLineClass('@@ -1,3 +1,3 @@'), 'diff-meta')
  assert.equal(H.diffLineClass('+const b = 22'), 'diff-add')
  assert.equal(H.diffLineClass('-const b = 2'), 'diff-del')
  assert.equal(H.diffLineClass(' const a = 1'), 'diff-ctx')
  assert.equal(H.diffLineClass('…（另有 3 处变更块未展示；以上只是部分改动）'), 'diff-note')
})

test('与主进程真实产出一致（拿 fs-safe 的真结果过一遍渲染逻辑）', () => {
  // 桩掉 electron 相关依赖，直接 require 真实的 fs-safe
  const FS_SAFE = path.join(__dirname, '..', 'electron', 'tools', 'fs-safe.js')
  const stub = (request, exports) => {
    const id = require.resolve(request, { paths: [path.dirname(FS_SAFE)] })
    require.cache[id] = { id, filename: id, loaded: true, exports }
  }
  stub('electron', { ipcMain: { handle() {} }, dialog: {}, BrowserWindow: class {}, nativeImage: {}, shell: {} })
  stub('../state', { settings: { role: 'dev', allowedDirs: [], skillsDir: '', memoryDir: '' }, attachedFilePaths: new Set() })
  stub('../settings', { settings: {} })
  const fsSafe = require(FS_SAFE)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-view-'))
  const file = path.join(dir, 'demo.js')
  fs.writeFileSync(file, 'const a = 1\nconst b = 2\nconst c = 3\n', 'utf-8')

  const res = fsSafe.editFileSafe(file, 'const b = 2', 'const b = 22')
  // toolCall() 内部已按 tools/index.js 的方式包成 {success:true, result:<工具返回>}，
  // 这里直接把它作为工具返回传入，不要再手动包一层（多包一层就变成三层，取不到 diff）
  const tc = toolCall('edit_file', { path: file, old_string: 'const b = 2', new_string: 'const b = 22' }, res)

  const parsed = H.parseToolResult(tc.result)
  const body = H.toolResultBody(parsed)
  assert.ok(body.diff, '真实产出必须能被渲染逻辑取到 diff')

  const lines = body.diff.split('\n')
  const classes = lines.map(H.diffLineClass)
  assert.ok(classes.includes('diff-add'), '应有新增行')
  assert.ok(classes.includes('diff-del'), '应有删除行')
  assert.ok(classes.includes('diff-meta'), '应有 hunk 头')
  assert.equal(H.filePathOf(tc), file, '路径应能从 args 解析出来')
})
