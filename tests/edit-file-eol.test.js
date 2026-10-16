// edit_file 的「忽略行尾差异」兜底回归测试
//
// 背景（2026-09-28）：模型给出的 old_string 经常是 LF，而 Windows 仓库里的文件是 CRLF，
// 精确匹配直接失败 → 模型只能重新 read_file 再来一次，白烧一轮往返。
// fs-safe.editFileSafe 现在多两级兜底：
//   ① 忽略行尾按行匹配（保持文件原有行尾风格，不动无关行）；
//   ② 仍匹配不上时，把原文里最相似的行号回给模型。
//
// 这里锁住四条不变量：
//   1) LF 的 old_string 能改到 CRLF 的文件，且改完仍是 CRLF、无关行逐字节不变
//   2) 能精确匹配时仍走原路径（不引入 eolAdjusted 之类的副作用）
//   3) 兜底路径下 replace_all 会替换全部命中
//   4) 匹配失败的错误信息里带最相似行号（省掉模型一轮 read_file）
//
// fs-safe.js 加载时 require('electron')，故用桩模块顶掉 electron / state / settings，
// 使其能在纯 Node 下被 require（写法同 tests/model-default.test.js）。
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
  mdPreviewWindows: [],
})
stub('../settings', {
  HARNESS_ROOT: path.join(__dirname, '..', 'harness'),
  resolvePlaceholders: (s) => s,
  getErpKbRoot: () => '',
  getLegalKbRoot: () => '',
  getProductOutputDir: () => '',
  getTestOutputDir: () => '',
  getExcelOutputDir: () => '',
  getLegalOutputDir: () => '',
  getBrowserDownloadsDir: () => '',
})
stub('../windows', { hardenWindow() {} })
stub('../repodirs', { getRoleRepoRoot: () => '' })

const { editFileSafe } = require(FS_SAFE)

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-eol-'))
  const f = path.join(dir, name)
  fs.writeFileSync(f, content)
  return f
}

test('LF 的 old_string 能改 CRLF 文件，且保持 CRLF、无关行不变', () => {
  const f = tmpFile('crlf.js', 'line1\r\nconst a = 1\r\nline3\r\n')
  const r = editFileSafe(f, 'const a = 1\n', 'const a = 2\n')
  assert.equal(r.replacedCount, 1)
  assert.equal(r.eolAdjusted, true)
  assert.equal(fs.readFileSync(f, 'utf-8'), 'line1\r\nconst a = 2\r\nline3\r\n')
})

test('多行 + 带缩进：行尾差异兜底同样成立', () => {
  const f = tmpFile('multi.js', 'function f() {\r\n  return 1\r\n}\r\n')
  const r = editFileSafe(f, 'function f() {\n  return 1\n}\n', 'function f() {\n  return 2\n}\n')
  assert.equal(r.eolAdjusted, true)
  assert.equal(fs.readFileSync(f, 'utf-8'), 'function f() {\r\n  return 2\r\n}\r\n')
})

test('LF 文件（无行尾差异）仍走精确匹配路径', () => {
  const f = tmpFile('lf.js', 'x\ny\nz\n')
  const r = editFileSafe(f, 'y\n', 'Y\n')
  assert.equal(r.replacedCount, 1)
  assert.equal(r.eolAdjusted, undefined, '精确匹配不应被标记为行尾兜底')
  assert.equal(fs.readFileSync(f, 'utf-8'), 'x\nY\nz\n')
})

test('兜底路径下 replace_all 替换全部命中', () => {
  const f = tmpFile('all.txt', 'a\r\na\r\na\r\n')
  const r = editFileSafe(f, 'a\n', 'b\n', true)
  assert.equal(r.replacedCount, 3)
  assert.equal(fs.readFileSync(f, 'utf-8'), 'b\r\nb\r\nb\r\n')
})

test('兜底路径下命中多处且未开 replace_all → 报不唯一', () => {
  const f = tmpFile('dup.txt', 'a\r\na\r\n')
  assert.throws(() => editFileSafe(f, 'a\n', 'b\n'), /不唯一/)
  assert.equal(fs.readFileSync(f, 'utf-8'), 'a\r\na\r\n', '报错时不得改动文件')
})

test('匹配不上时错误信息带最相似行号', () => {
  const f = tmpFile('miss.js', 'import fs from fs\nconst fooBar = 111\nconst other = 2\n')
  let msg = ''
  try {
    editFileSafe(f, 'const fooBar = 999\n', 'const fooBar = 0\n')
  } catch (e) {
    msg = e.message
  }
  assert.match(msg, /第 2 行/)
  assert.match(msg, /const fooBar = 111/)
  assert.equal(fs.readFileSync(f, 'utf-8'), 'import fs from fs\nconst fooBar = 111\nconst other = 2\n')
})
