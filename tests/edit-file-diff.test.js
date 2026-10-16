// edit_file / write_file 的「改动差异回显」回归测试
//
// 背景：改完文件只回 {path, size}，模型不知道自己到底把什么写进了文件 ——
// 括号不配对、缩进错位、替换到错误位置这类错误它自己发现不了，只能再
// read_file 复查一遍，白烧一轮往返。fs-safe 现在回一段 unified diff 让它自查。
//
// 这里锁住六条不变量（前五条是正确性，第六条是"不能比没有更糟"）：
//   1) 单行/局部替换能出标准 unified diff，且带 @@ 行号与 ±3 行上下文
//   2) CRLF 文件：diff 里**不含 \r**（否则回显是一堆 ^M 噪声），且文件行尾不被改成 LF
//   3) replace_all 多处命中的改动**全部**出现在 diff 里（漏一处 = 模型误以为没改）
//   4) 新建文件标 created，且无尾部多余空行
//   5) 内容无变化时**不返回 diff 字段**（不制造无意义噪声）
//   6) 大改动被截断时：① 必须仍有内容（不能整块丢掉，否则"改了但没回显"比不返回更糟）
//      ② 必须标 truncated 并在尾部说明省略了多少
//
// 另有一条曾经真实踩过的坑，单独立 test 锁住：
//   7) 「先按总行数判预算、再剥公共前后缀」的顺序是错的 —— 5000 行文件改 1 行会
//      退化成「删 5000 加 5000」，回显出一份完全误导的 diff。
//      正确顺序是先剥前后缀再看规模。见下面「大文件改一行仍要精确」。
//
// fs-safe.js 加载时 require('electron')，故用桩模块顶掉 electron / state / settings，
// 使其能在纯 Node 下被 require（写法同 tests/edit-file-eol.test.js）。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const FS_SAFE = path.join(__dirname, '..', 'electron', 'tools', 'fs-safe.js')

function stub(request, exports) {
  const id = require.resolve(request, { paths: [path.dirname(FS_SAFE)] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

stub('electron', {
  ipcMain: { handle() {} },
  dialog: {},
  BrowserWindow: class {},
  nativeImage: {},
  shell: {},
})
// role:'dev' → isPathAllowed 直接放行，测试不必配授权目录
stub('../state', {
  settings: { role: 'dev', allowedDirs: [], skillsDir: '', memoryDir: '' },
  attachedFilePaths: new Set(),
})
stub('../settings', { settings: {} })

const fsSafe = require(FS_SAFE)

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-diff-'))
  const p = path.join(dir, name)
  fs.writeFileSync(p, content, 'utf-8')
  return p
}

test('单行替换 → 标准 unified diff，带 @@ 行号与上下文', () => {
  const f = tmpFile('a.js', 'line1\nline2\nline3\nline4\nline5\n')
  const r = fsSafe.editFileSafe(f, 'line3', 'line3-CHANGED')

  assert.ok(r.diff, '应回显 diff')
  const lines = r.diff.split('\n')
  assert.match(lines[0], /^@@ -1,5 \+1,5 @@$/, '首行应是 hunk 头且行号正确')
  assert.ok(lines.includes('-line3'), '应含删除行')
  assert.ok(lines.includes('+line3-CHANGED'), '应含新增行')
  // 上下文：变更行上下各 3 行都在
  assert.ok(lines.includes(' line1'))
  assert.ok(lines.includes(' line5'))
  assert.equal(r.diffTruncated, undefined, '小改动不该标截断')
  // 原有返回字段不能少
  assert.equal(r.replacedCount, 1)
  assert.ok(r.path)
})

test('CRLF 文件：diff 不含 \\r，且写回后行尾仍是 CRLF', () => {
  const f = tmpFile('crlf.js', 'const a = 1\r\nconst b = 2\r\nconst c = 3\r\n')
  // 模型通常给 LF 的 old_string，走 EOL 兜底路径
  const r = fsSafe.editFileSafe(f, 'const b = 2\n', 'const b = 200\n')

  assert.equal(r.eolAdjusted, true, '应走 EOL 兜底路径')
  assert.ok(r.diff, '兜底路径同样要回显 diff')
  assert.ok(!r.diff.includes('\r'), 'diff 里绝不能混入 \\r（否则模型看到一堆 ^M）')
  assert.ok(r.diff.includes('-const b = 2'))
  assert.ok(r.diff.includes('+const b = 200'))
  // 关键：不能因为生成 diff 就把文件行尾改成 LF
  assert.ok(fs.readFileSync(f, 'utf-8').includes('\r\n'), '文件行尾必须仍是 CRLF')
})

test('replace_all 多处命中 → 每一处改动都出现在 diff 里', () => {
  const f = tmpFile('multi.js', 'X = 1\nfoo\nX = 1\nbar\nX = 1\n')
  const r = fsSafe.editFileSafe(f, 'X = 1', 'X = 99', true)

  assert.equal(r.replacedCount, 3)
  const added = r.diff.split('\n').filter((l) => l.startsWith('+X'))
  assert.equal(added.length, 3, '3 处命中必须全部回显，漏一处模型会以为没改')
})

test('新建文件 → 标 created，diff 无尾部多余空行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-diff-'))
  const f = path.join(dir, 'new.js')
  const r = fsSafe.writeFileSafe(f, 'function hi() {}\n')

  assert.equal(r.created, true)
  assert.ok(r.diff.includes('+function hi() {}'))
  // 'function hi() {}\n' 按行拆分会多出一个空元素，不该显示成一行只有前缀的空行
  for (const line of r.diff.split('\n')) {
    assert.ok(line.trim() !== '', `不该出现空行，实际: ${JSON.stringify(r.diff)}`)
  }
})

test('内容无变化 → 不返回 diff 字段（不制造噪声）', () => {
  const f = tmpFile('same.js', 'a\nb\nc\n')
  const r = fsSafe.writeFileSafe(f, 'a\nb\nc\n')
  assert.equal(r.diff, undefined, '没改动就不该回显 diff')
  assert.equal(r.created, undefined)
})

test('大改动被截断：仍有内容 + 标 truncated + 说明省略量', () => {
  // 20 处零散改动（每处间隔 10 行 > 2×上下文，故会拆成 20 个 hunk，超 DIFF_MAX_HUNKS）
  const lines = []
  for (let i = 0; i < 200; i++) lines.push(`const v${i} = ${i}`)
  const f = tmpFile('big.js', lines.join('\n') + '\n')
  const after = lines.slice()
  for (let i = 0; i < 20; i++) after[i * 10] = `const v${i * 10} = CHANGED`

  const r = fsSafe.writeFileSafe(f, after.join('\n') + '\n')

  assert.equal(r.diffTruncated, true, '必须标截断')
  // 最关键：不能整块丢掉 —— 丢了就等于「改了但一个字没回显」，比不返回 diff 更糟
  assert.ok(r.diff.split('\n').length > 10, '截断后仍要展示一部分改动')
  assert.ok(r.diff.includes('CHANGED'), '截断后的内容里要真的能看到改动')
  assert.match(r.diff, /未展示/, '必须明确告知有内容未展示')
  // 这段文本会显示在聊天区的工具明细里（用户可见），不能出现"请 read_file"这类
  // 只对模型说的话 —— 那句引导放工具 description 里，不放这里。
  assert.ok(!/read_file/.test(r.diff), '尾部提示不该出现只对模型说的指令')
})

test('大文件改一行仍要精确（曾因「先判预算再剥前后缀」而误报全量删除）', () => {
  const lines = []
  for (let i = 0; i < 5000; i++) lines.push(`item ${i}`)
  const f = tmpFile('mid.js', lines.join('\n') + '\n')

  const r = fsSafe.editFileSafe(f, 'item 2500', 'item 2500 EDITED')

  // 剥掉公共前后缀后中段只剩 1 行，5000 行的大文件也必须走精确 LCS
  const out = r.diff.split('\n')
  assert.equal(out.length, 9, `应为 1 hunk + ±3 上下文，实际 ${out.length} 行`)
  assert.match(out[0], /^@@ -2498,7 \+2498,7 @@$/, 'hunk 行号应指向改动处')
  assert.ok(r.diff.includes('-item 2500'))
  assert.ok(r.diff.includes('+item 2500 EDITED'))
  assert.ok(!r.diff.includes('-item 0'), '不能把未改动的行报成删除')
})

test('中段整体重写 → 诚实退化并标注，不假装精细', () => {
  const lines = []
  for (let i = 0; i < 5000; i++) lines.push(`item ${i}`)
  const f = tmpFile('rewrite.js', lines.join('\n') + '\n')
  const all = lines.map((l) => `${l} // 改`) // 每行都改，剥完前后缀中段仍巨大

  const r = fsSafe.writeFileSafe(f, all.join('\n') + '\n')

  assert.equal(r.diffTruncated, true)
  assert.match(r.diff, /未展示/)
  assert.ok(r.diff.split('\n').length <= 85, '截断后行数应受 DIFF_MAX_LINES 约束')
})

test('性能：10000 行文件单行改动的 diff 计算应在百毫秒内', () => {
  const lines = []
  for (let i = 0; i < 10000; i++) lines.push(`row ${i}`)
  const f = tmpFile('perf.js', lines.join('\n') + '\n')

  const t0 = Date.now()
  const r = fsSafe.editFileSafe(f, 'row 5000', 'row 5000 EDITED')
  const elapsed = Date.now() - t0

  assert.ok(r.diff.includes('+row 5000 EDITED'))
  // 主进程里算 diff 卡一下就是整窗「未响应」，这里给一个宽松但能拦回归的上限
  assert.ok(elapsed < 2000, `耗时 ${elapsed}ms，过慢会拖住主进程`)
})

// ============================================================
//  2026-10-04 补：两个会静默产出错误结果的 edit_file 缺陷
// ============================================================

test('old_string 为空串 → 报错而不是死循环（曾冻结主进程）', () => {
  const f = tmpFile('empty-old.js', 'const a = 1\nconst b = 2\n')

  // 修复前：old_string='' 时 searchFrom 永不前进，indexOf('',n) 恒返回 n
  // → 主线程同步死循环，整窗「未响应」。这里必须抛错并保持文件不变。
  assert.throws(
    () => fsSafe.editFileSafe(f, '', 'INJECTED'),
    /不能为空/,
    '空 old_string 应立刻报错',
  )
  assert.equal(fs.readFileSync(f, 'utf-8'), 'const a = 1\nconst b = 2\n', '文件必须原封不动')
})

test('new_string 里的 $& / $` / 单引号 不被展开为「被匹配原文」（曾静默改坏代码）', () => {
  // 真实场景：模型写入 str.replace(/re/, "$&!") 这类含 $ 的代码。
  // 修复前 String.replace(old, newString) 会把 $& 当成 replacement pattern 展开，
  // 写入内容被篡改，而 diff 回显的还是篡改后的结果 → 模型自查不出来。
  const cases = [
    { from: 'foo(x);', to: 'foo(2);$&', expected: 'foo(2);$&' },
    { from: 'X', to: 'pre $` mid', expected: 'pre $` mid' },
    { from: 'X', to: "$' post", expected: "$' post" },
    { from: 'X', to: '$1$2', expected: '$1$2' },
  ]
  for (const c of cases) {
    const f = tmpFile('dollar.js', `head\n${c.from}\ntail\n`)
    fsSafe.editFileSafe(f, c.from, c.to)
    const got = fs.readFileSync(f, 'utf-8')
    assert.ok(
      got.includes(c.expected),
      `new_string=${JSON.stringify(c.to)} 应原样写入，实际文件内容：${JSON.stringify(got)}`,
    )
    // 且不能出现「被匹配原文被复制进来」的膨胀
    assert.ok(!got.includes(c.expected + c.from), '不得把被匹配原文插到替换结果后面')
  }
})

test('replace_all 分支同样不吃 $ 语义', () => {
  const f = tmpFile('dollar-all.js', 'X a X b X\n')
  const r = fsSafe.editFileSafe(f, 'X', 'Y$&', true)
  assert.equal(fs.readFileSync(f, 'utf-8'), 'Y$& a Y$& b Y$&\n')
  assert.equal(r.replacedCount, 3)
})
