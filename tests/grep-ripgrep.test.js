// grep_code 的 ripgrep 分支（P1-1，2026-10-24）。
//
// 背景：自研扫描器 15s / 2 万条目预算会截断结果，模型于是"换关键词再搜一遍"；
// 且它没有上下文行 / files / count 模式。改用 rg 后：
//   · context 行（行号后带 `-`）—— 判断 if 条件、函数签名不必再 read_file
//   · output_mode=files/count —— "这个名字在几个文件里"不再吃掉几十条结果
// 本机找不到 rg 时本文件整体 skip（而不是失败）：那不是代码错，是环境没有。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SEARCH = path.join(__dirname, '..', 'electron', 'tools', 'search.js')

function stub(request, exports) {
  const id = require.resolve(request, { paths: [path.dirname(SEARCH)] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

stub('electron', {
  ipcMain: { handle() {} },
  dialog: {},
  BrowserWindow: class {},
  nativeImage: {},
  shell: {},
  app: { getPath: () => os.tmpdir() },
})
stub('../state', { settings: { role: 'dev', allowedDirs: [], skillsDir: '', memoryDir: '' } })
stub('../settings', {
  settings: {},
  HARNESS_ROOT: path.join(os.tmpdir(), 'localai-harness-stub'),
  resolvePlaceholders: (s) => s,
  getCommandOutputDir: () => os.tmpdir(),
})

const search = require(SEARCH)

// 造一个小工程：a.js 里有目标符号且带上下文，b.js 里没有
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-grep-'))
fs.mkdirSync(path.join(root, 'src'), { recursive: true })
fs.writeFileSync(path.join(root, 'src', 'a.js'), [
  'function before() {',
  '  return 1',
  '}',
  'function targetFn(arg) {',
  '  return arg',
  '}',
  'function after() {}',
].join('\n'))
fs.writeFileSync(path.join(root, 'src', 'b.js'), 'const other = 2\n')
// .gitignore 里的目录：rg 默认会跳过（自研扫描器只认硬编码 SKIP_DIRS）
fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'c.js'), 'function targetFn() {}\n')

const call = async (args) => JSON.parse(await search.grepCode({ path: root, include: '*.js', ...args }))

// rg 不在本机 → 这组用例没有意义，直接 skip（不是失败）
const rgProbe = require('node:child_process')
const hasRg = (() => {
  const candidates = [
    process.env.RG_PATH,
    path.join(__dirname, '..', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'vendor', 'ripgrep', 'x64-win32', 'rg.exe'),
  ].filter(Boolean)
  if (candidates.some((c) => { try { return fs.existsSync(c) } catch { return false } })) return true
  try {
    rgProbe.execFileSync('rg', ['--version'], { stdio: 'ignore', timeout: 1500 })
    return true
  } catch {
    return false
  }
})()

test('默认走 ripgrep，返回 file:line:snippet', { skip: !hasRg && '本机没有 ripgrep' }, async () => {
  const j = await call({ pattern: 'targetFn' })
  assert.equal(j.engine, 'ripgrep', '有 rg 时必须走 rg 分支')
  assert.ok(j.matchCount >= 1)
  assert.match(j.results[0], /^src\/a\.js:\d+: .*targetFn/)
})

test('context：命中行带 `:`、上下文行带 `-`，且上下文不占 max_results 名额', { skip: !hasRg && '本机没有 ripgrep' }, async () => {
  const j = await call({ pattern: 'targetFn\\(arg\\)', context: 2, max_results: 1 })
  assert.equal(j.engine, 'ripgrep')
  assert.equal(j.matchCount, 1, '只有一行真命中')
  const ctxLines = j.results.filter((l) => /:\d+- /.test(l))
  assert.ok(ctxLines.length >= 2, `应当带回上下文行，实际：${JSON.stringify(j.results)}`)
  assert.ok(j.note.includes('上下文行'))
})

test('output_mode=files：只回文件路径', { skip: !hasRg && '本机没有 ripgrep' }, async () => {
  const j = await call({ pattern: 'targetFn', output_mode: 'files' })
  assert.deepEqual(j.results, ['src/a.js'])
  assert.equal(j.outputMode, 'files')
})

test('output_mode=count：路径:次数', { skip: !hasRg && '本机没有 ripgrep' }, async () => {
  const j = await call({ pattern: 'function', output_mode: 'count' })
  assert.equal(j.results.length, 1)
  assert.match(j.results[0], /^src\/a\.js:\d+$/)
})

test('大小写：默认忽略，case_sensitive 时区分', { skip: !hasRg && '本机没有 ripgrep' }, async () => {
  fs.writeFileSync(path.join(root, 'src', 'case.js'), 'const ABC = 1\n')
  const insensitive = await call({ pattern: 'abc' })
  assert.ok(insensitive.matchCount >= 1, '默认忽略大小写')
  const sensitive = await call({ pattern: 'abc', case_sensitive: true })
  assert.equal(sensitive.matchCount, 0, 'case_sensitive 时不该命中 ABC')
})
