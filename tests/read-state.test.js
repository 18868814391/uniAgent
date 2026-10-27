// 读状态校验的回归测试（P0-5，2026-10-24）。
//
// 要锁住的口径（区分两个工具，这是关键）：
//   · write_file 是**整篇重写** → 覆盖已存在文件前必须「本次会话完整读过 + 读后没被改动过」，
//     否则静默回滚用户/别人的中间改动（唯一会真丢东西的路径）。
//   · edit_file 每次从磁盘重读再 str_replace → **只给 staleRead 提示**，不阻断（阻断只会白烧一轮）。
//   两个豁免：AI 自己写出来的草稿、文件在检查瞬间消失。
//   压缩后清空 → 必须重新读（模型不能凭摘要里的旧记忆覆盖文件）。
//
// fs-safe.js 加载时 require('electron')，桩写法同 tests/read-file-limit.test.js。
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
const stateStub = {
  settings: { role: 'dev', allowedDirs: [], skillsDir: '', memoryDir: '' },
  attachedFilePaths: new Set(),
}
stub('../state', stateStub)
stub('../settings', {
  settings: {},
  HARNESS_ROOT: path.join(os.tmpdir(), 'localai-harness-stub'),
  resolvePlaceholders: (s) => s,
})

const fsSafe = require(FS_SAFE)

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-readstate-'))
  const p = path.join(dir, name)
  fs.writeFileSync(p, content, 'utf-8')
  return p
}

const OVERWRITE = { requireRead: true }

test('覆盖未读过的文件 → 拒绝，并提示先 read_file', () => {
  const f = tmpFile('a.js', 'const a = 1\n')
  assert.throws(() => fsSafe.writeFileSafe(f, 'const b = 2\n', OVERWRITE), /拒绝覆盖未读过的文件/)
  assert.equal(fs.readFileSync(f, 'utf-8'), 'const a = 1\n', '被拒时文件必须原样不动')
})

test('完整读过之后再覆盖 → 放行', () => {
  const f = tmpFile('b.js', 'const a = 1\n')
  fsSafe.readFileWithRange(f, undefined, undefined)
  const r = fsSafe.writeFileSafe(f, 'const b = 2\n', OVERWRITE)
  assert.equal(r.path, path.resolve(f))
  assert.equal(fs.readFileSync(f, 'utf-8'), 'const b = 2\n')
})

test('只读过片段（offset/limit）→ 仍拒绝（否则会把没读到的部分冲掉）', () => {
  const f = tmpFile('c.js', Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
  fsSafe.readFileWithRange(f, 1, 10)
  assert.throws(() => fsSafe.writeFileSafe(f, 'x\n', OVERWRITE), /只被读过片段/)
})

test('读后文件被外部改过 → 拒绝（别覆盖别人刚做的改动）', () => {
  const f = tmpFile('d.js', 'const a = 1\n')
  fsSafe.readFileWithRange(f, undefined, undefined)
  // 模拟用户 / 格式化工具在读之后改了文件（内容 + mtime 都变）
  fs.writeFileSync(f, 'const a = 1\n// 用户加的注释\n', 'utf-8')
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(f, future, future)
  assert.throws(() => fsSafe.writeFileSafe(f, 'const b = 2\n', OVERWRITE), /在你读过之后被改动过/)
})

test('clearReadState（压缩后调用）→ 必须重新读，否则拒绝', () => {
  const f = tmpFile('e.js', 'const a = 1\n')
  fsSafe.readFileWithRange(f, undefined, undefined)
  fsSafe.clearReadState()
  assert.throws(() => fsSafe.writeFileSafe(f, 'const b = 2\n', OVERWRITE), /拒绝覆盖未读过的文件/)
})

test('不打开 requireRead（其它角色）→ 行为与旧版一致，不拦', () => {
  const f = tmpFile('f.js', 'const a = 1\n')
  const r = fsSafe.writeFileSafe(f, 'const b = 2\n')
  assert.equal(r.size, Buffer.byteLength('const b = 2\n'))
})

test('新建文件不受影响（没有原文可比）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-readstate-'))
  const f = path.join(dir, 'new.js')
  const r = fsSafe.writeFileSafe(f, 'const a = 1\n', OVERWRITE)
  assert.equal(r.created, true)
})

test('edit_file：没读过 → 照常成功，但带 staleRead 提示（不阻断）', () => {
  const f = tmpFile('g.js', 'const a = 1\n')
  const r = fsSafe.editFileSafe(f, 'const a = 1', 'const a = 2')
  assert.equal(r.replacedCount, 1)
  assert.equal(r.staleRead, true, '未读就改要给提示')
  assert.equal(fs.readFileSync(f, 'utf-8'), 'const a = 2\n')
})

test('edit_file：读过且没被改过 → 不带 staleRead', () => {
  const f = tmpFile('h.js', 'const a = 1\n')
  fsSafe.readFileWithRange(f, undefined, undefined)
  const r = fsSafe.editFileSafe(f, 'const a = 1', 'const a = 2')
  assert.equal(r.staleRead, undefined)
})

test('edit_file：读后被外部改过 → 带 staleRead（但仍按磁盘现状改）', () => {
  const f = tmpFile('i.js', 'const a = 1\n')
  fsSafe.readFileWithRange(f, undefined, undefined)
  fs.writeFileSync(f, 'const a = 1\nconst extra = 0\n', 'utf-8')
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(f, future, future)
  const r = fsSafe.editFileSafe(f, 'const a = 1', 'const a = 2')
  assert.equal(r.staleRead, true)
  assert.match(fs.readFileSync(f, 'utf-8'), /const extra = 0/, '改动必须落在最新内容上，不能丢外部改动')
})

test('删除后重新出现 → 旧读记录失效，覆盖又会被拦', () => {
  const f = tmpFile('j.js', 'const a = 1\n')
  fsSafe.readFileWithRange(f, undefined, undefined)
  fsSafe.deleteFileSafe(f)
  fs.writeFileSync(f, 'recreated\n', 'utf-8')
  assert.throws(() => fsSafe.writeFileSafe(f, 'x\n', OVERWRITE), /拒绝覆盖未读过的文件/)
})
