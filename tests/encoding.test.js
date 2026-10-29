// 编码检测 / 写回 的回归测试（P1-3，2026-10-24）。
//
// 旧实现无条件 readFileSync(...,'utf-8')：GBK 的 .java / UTF-16LE 的导出文件被读成乱码，
// 模型"照着乱码改"，edit_file 再把乱码写回去 → 文件损坏，而且它自己完全不知道。
//
// 口径：
//   ① 读：按 BOM / 严格 UTF-8 / GBK 依次判，中文必须读对
//   ② 写：**沿用原编码**（UTF-16LE 保留 BOM、UTF-8 BOM 保留）
//   ③ GBK：能读，但不允许写（Node 没有 GBK 编码器）—— 宁可拒绝，也不要把文件写坏
//   ④ 新建文件：UTF-8 无 BOM
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const FS_SAFE = path.join(__dirname, '..', 'electron', 'tools', 'fs-safe.js')

function stub(request, exports) {
  const id = require.resolve(request, { paths: [path.dirname(FS_SAFE)] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

stub('electron', { ipcMain: { handle() {} }, dialog: {}, BrowserWindow: class {}, nativeImage: {}, shell: {} })
stub('../state', {
  settings: { role: 'dev', allowedDirs: [], skillsDir: '', memoryDir: '' },
  attachedFilePaths: new Set(),
})
stub('../settings', {
  settings: {},
  HARNESS_ROOT: path.join(os.tmpdir(), 'localai-harness-stub'),
  resolvePlaceholders: (s) => s,
})

const fsSafe = require(FS_SAFE)

function writeBuffer(name, buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-enc-'))
  const p = path.join(dir, name)
  fs.writeFileSync(p, buf)
  return p
}

const GBK_NIHAO = Buffer.from([0xc4, 0xe3, 0xba, 0xc3])   // 「你好」的 GBK 字节

test('UTF-16LE（带 BOM）能正确读出中文', () => {
  const p = writeBuffer('u16.txt', Buffer.from('\ufeff中文内容', 'utf16le'))
  assert.equal(fsSafe.readFileWithRange(p, undefined, undefined, { lineNumbers: false }), '中文内容')
})

test('UTF-16LE 编辑后仍写回 UTF-16LE + BOM（不把整份文件变成 UTF-8）', () => {
  const p = writeBuffer('u16b.txt', Buffer.from('\ufeff中文内容', 'utf16le'))
  fsSafe.readFileWithRange(p, undefined, undefined, { lineNumbers: false })
  fsSafe.editFileSafe(p, '中文内容', '中文改过了')
  const buf = fs.readFileSync(p)
  assert.deepEqual([buf[0], buf[1]], [0xff, 0xfe], 'BOM 必须保留')
  assert.equal(buf.toString('utf16le').replace(/^\ufeff/, ''), '中文改过了')
})

test('UTF-8 BOM 文件写回后仍带 BOM', () => {
  const p = writeBuffer('bom.js', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('const a = 1\n')]))
  fsSafe.readFileWithRange(p, undefined, undefined, { lineNumbers: false })
  fsSafe.editFileSafe(p, 'const a = 1', 'const a = 2')
  const buf = fs.readFileSync(p)
  assert.deepEqual([buf[0], buf[1], buf[2]], [0xef, 0xbb, 0xbf])
  assert.equal(buf.subarray(3).toString('utf-8'), 'const a = 2\n')
})

test('GBK 文件能读对（不再乱码）', () => {
  const p = writeBuffer('gbk.txt', GBK_NIHAO)
  assert.equal(fsSafe.readFileWithRange(p, undefined, undefined, { lineNumbers: false }), '你好')
})

test('GBK 文件拒绝编辑（没有 GBK 编码器，写回去就是损坏）', () => {
  const p = writeBuffer('gbk2.txt', Buffer.concat([GBK_NIHAO, Buffer.from('\n')]))
  fsSafe.readFileWithRange(p, undefined, undefined, { lineNumbers: false })
  assert.throws(
    () => fsSafe.editFileSafe(p, '你好', '大家好'),
    /不是 UTF-8|GBK/,
    '必须拒绝，并告诉模型怎么处理',
  )
  const after = fs.readFileSync(p)
  assert.deepEqual(after, Buffer.concat([GBK_NIHAO, Buffer.from('\n')]), '拒绝时文件必须一字节不动')
})

test('GBK 文件也拒绝整篇覆盖', () => {
  const p = writeBuffer('gbk3.js', GBK_NIHAO)
  fsSafe.readFileWithRange(p, undefined, undefined, { lineNumbers: false })
  assert.throws(() => fsSafe.writeFileSafe(p, 'overwrite', { requireRead: true }), /不是 UTF-8|GBK/)
})

test('新建文件写成 UTF-8（无 BOM）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-enc-'))
  const p = path.join(dir, 'new.txt')
  fsSafe.writeFileSafe(p, '中文\n')
  const buf = fs.readFileSync(p)
  assert.equal(buf.toString('utf-8'), '中文\n')
  assert.notDeepEqual([buf[0], buf[1], buf[2]], [0xef, 0xbb, 0xbf], '不该自动加 BOM')
})
