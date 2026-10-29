// read_file 的返回上限回归测试 —— 2026-10-04
//
// 背景（第三轮评估实测确认的 P1）：不传 offset/limit 时 readFileWithRange 直接返回**整份文件**，
// 唯一闸是 readFileSafe 的 10MB（≈250 万 token）——一次调用就能把上下文窗口打爆，
// 紧接着 chat.js 抛 API error 400，**整轮工作全部作废**。
// 而 tool description 当时还写着 "read it ONCE and completely — do NOT split"，
// 等于在鼓励这个行为（那句是针对「模型养成 15 行分块读习惯」写的反向补丁，矫枉过正）。
//
// 本文件锁住 6 条不变量：
//   1) 小文件不传 offset/limit → 仍返回**裸字符串**（原行为逐字节不变，避免回归）
//   2) 超 2000 行的文件不传 offset/limit → 返回对象、truncated:true、nextOffset 可续读
//   3) 从 nextOffset 续读能把剩余部分读完（拼起来等于原文）
//   4) offset 越界 → **抛错**并带总行数（旧实现返回「空内容 + truncated:false」，模型会以为文件到此为止）
//   5) 单行超长（minified 文件）→ 内容非空 + lineTruncated:true（旧会返回空内容 ⇒ 死循环）
//   6) 传了 offset/limit 时行数上限仍然生效（防止 limit=999999 绕过保护）
//
// fs-safe.js 加载时 require('electron')，故用桩模块顶掉 electron / state / settings
// （写法同 tests/edit-file-diff.test.js）。
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
// readFileSafe 会读 HARNESS_ROOT 并在命中时做占位符替换；这里给一个不会匹配到临时文件的路径
stub('../settings', {
  settings: {},
  HARNESS_ROOT: path.join(os.tmpdir(), 'localai-harness-stub'),
  resolvePlaceholders: (s) => s,
})

const fsSafe = require(FS_SAFE)

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-read-'))
  const p = path.join(dir, name)
  fs.writeFileSync(p, content, 'utf-8')
  return p
}

test('小文件不传 offset/limit → 仍返回裸字符串，且默认带行号（2026-10-24 起）', () => {
  const src = 'line1\nline2\nline3\n'
  const f = tmpFile('small.js', src)
  const r = fsSafe.readFileWithRange(f, undefined, undefined)
  assert.equal(typeof r, 'string', '未超限且未分段时必须仍返回裸字符串（否则下游 JSON 包装与快照都会变）')
  assert.equal(r, '1\tline1\n2\tline2\n3\tline3\n4\t', '默认加「行号\\t」前缀，与 grep 的 file:line 口径一致')

  // 需要原样文本（整段拷贝）时可关掉行号
  const raw = fsSafe.readFileWithRange(f, undefined, undefined, { lineNumbers: false })
  assert.equal(raw, src)
})

test('⚠️ 正常大页面必须整份返回（2000 行上限曾把 1796 行的 Vue 页面判成"需续读"）', () => {
  // 真实事故（2026-10-04，用户报「任务弹窗没了」时查到的）：
  // 初版上限定 2000 行，而用户一个 1796 行的 Vue 页面在改造中加几段代码就超限 →
  // read_file 变成「只给前 2000 行 + 让模型续读」，模型在同一文件上反复读、烧掉大量轮次。
  // 这条用例把「正常源码文件不得被截断」钉死。
  const lines = []
  for (let i = 1; i <= 1796; i++) lines.push(`  <div class="row-${i}" :key="${i}">内容 ${i}</div>`)
  const f = tmpFile('BigPage.vue', lines.join('\n'))
  const r = fsSafe.readFileWithRange(f, undefined, undefined)
  assert.equal(typeof r, 'string', '1796 行的正常页面必须整份返回（裸字符串），不能被截断')
  assert.equal(r.split('\n').length, 1796)
})

test('大文件不传 offset/limit → 截断 + 明确告知 + nextOffset 可续读', () => {
  const TOTAL = 20000   // 超过行数兜底上限 8000
  const lines = []
  for (let i = 1; i <= TOTAL; i++) lines.push(`row ${i}`)
  const f = tmpFile('big.js', lines.join('\n'))

  const r = fsSafe.readFileWithRange(f, undefined, undefined)
  assert.equal(typeof r, 'object', '超限时应返回带元信息的对象')
  assert.equal(r.truncated, true)
  assert.equal(r.totalLines, TOTAL)
  assert.equal(r.offset, 1)
  assert.equal(r.limit, 8000, '默认行数兜底上限 8000')
  assert.equal(r.nextOffset, 8001)
  assert.match(r.note, /offset=8001/, 'note 里要给出续读指令（模型据此行动，不是靠猜）')
  // 内容确实是前 8000 行，且不是被静默切掉
  const got = r.content.split('\n')
  assert.equal(got.length, 8000)
  assert.equal(got[0], 'row 1')
  assert.equal(got[7999], 'row 8000')
})

test('字符上限才是真正的闸：行数不多但单行很长时也该截断', () => {
  // 3000 行 × 100 字符 ≈ 300KB > 128KB：行数（3000 < 8000）没超，但字符数超了
  const line = 'x'.repeat(100)
  const lines = []
  for (let i = 1; i <= 3000; i++) lines.push(line)
  const f = tmpFile('wide.txt', lines.join('\n'))

  const r = fsSafe.readFileWithRange(f, undefined, undefined)
  assert.equal(typeof r, 'object')
  assert.equal(r.truncated, true)
  assert.ok(r.content.length <= 128 * 1024, `返回内容应受字符上限约束，实测 ${r.content.length}`)
  assert.ok(r.limit < 3000, '按字符预算提前收口')
  assert.ok(r.nextOffset > 1 && r.nextOffset <= 3000)
})

test('从 nextOffset 续读可以把剩余部分读完（拼起来等于原文）', () => {
  const TOTAL = 20000
  const lines = []
  for (let i = 1; i <= TOTAL; i++) lines.push(`row ${i}`)
  const f = tmpFile('resume.js', lines.join('\n'))

  let cursor = undefined
  const all = []
  for (let guard = 0; guard < 10; guard++) {
    // lineNumbers:false —— 这条用例验的是"续读能否覆盖全文"，行号会干扰逐行比对
    const seg = fsSafe.readFileWithRange(f, cursor, undefined, { lineNumbers: false })
    const content = typeof seg === 'string' ? seg : seg.content
    all.push(...content.split('\n'))
    if (typeof seg === 'string' || !seg.truncated) break
    cursor = seg.nextOffset
  }
  assert.equal(all.length, TOTAL, '按 nextOffset 循环续读应恰好覆盖全部行')
  assert.equal(all[0], 'row 1')
  assert.equal(all[TOTAL - 1], `row ${TOTAL}`)
})

test('offset 越界 → 抛错并带总行数（不再返回空内容 + truncated:false）', () => {
  const f = tmpFile('short.js', 'a\nb\nc\n')
  assert.throws(
    () => fsSafe.readFileWithRange(f, 99999, undefined),
    /越界/,
    'offset 越界必须报错，否则模型会以为文件到此为止',
  )
})

test('单行超长（minified）→ 内容非空 + lineTruncated，不返回空', () => {
  // 一行 300KB，超过 100KB 字符上限
  const f = tmpFile('min.js', 'X'.repeat(300 * 1024))
  const r = fsSafe.readFileWithRange(f, undefined, undefined)
  assert.equal(typeof r, 'object')
  assert.ok(r.content.length > 0, '必须给出内容 —— 返回空内容会让模型以为文件是空的')
  assert.equal(r.lineTruncated, true)
  assert.match(r.note, /超长单行|硬截断/)
})

test('显式传 limit=999999 时行数兜底上限仍然生效（防止绕过保护）', () => {
  const lines = []
  for (let i = 1; i <= 20000; i++) lines.push(`row ${i}`)
  const f = tmpFile('bypass.js', lines.join('\n'))
  const r = fsSafe.readFileWithRange(f, 1, 999999)
  assert.equal(r.limit, 8000, '单次上限不可被 limit 参数绕过')
  assert.equal(r.truncated, true)
})

test('正常分段读取的元信息仍然正确', () => {
  const lines = []
  for (let i = 1; i <= 100; i++) lines.push(`row ${i}`)
  const f = tmpFile('range.js', lines.join('\n'))
  const r = fsSafe.readFileWithRange(f, 11, 5, { lineNumbers: false })
  assert.equal(r.offset, 11)
  assert.equal(r.limit, 5)
  assert.equal(r.truncated, true, '第 11-15 行之后还有内容 → 仍标 truncated（语义是"没读完"）')
  assert.deepEqual(r.content.split('\n'), ['row 11', 'row 12', 'row 13', 'row 14', 'row 15'])
  assert.equal(r.totalLines, 100)

  // 带行号时编号必须从 offset 起，不能从 1 重来（否则模型按行号定位会全错）
  const numbered = fsSafe.readFileWithRange(f, 11, 5)
  assert.equal(numbered.lineNumbers, true)
  assert.deepEqual(numbered.content.split('\n'), [
    '11\trow 11', '12\trow 12', '13\trow 13', '14\trow 14', '15\trow 15',
  ])
})
