// electron/tools/quick-diag.js 的单测 —— 写盘后的秒级语法/编译诊断（2026-10-24）。
//
// 要锁住的口径：
//   ① 真有语法错 → 返回带行号的诊断（模型据此**当轮**就能修，不用等用户打包）
//   ② 没错误 → 返回空数组；attachDiagnostics 在这种情况下**不加任何字段**（省 token）
//   ③ 不认识的扩展名 / 空文件 / node_modules / 不存在的路径 → null（静默跳过，绝不报错）
//   ④ 任何内部异常都不许冒泡：诊断失败绝不能把一次成功的写盘变成失败
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { diagnoseFile, attachDiagnostics } = require(path.join(__dirname, '..', 'electron', 'tools', 'quick-diag.js'))

const dirs = []
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-diag-'))
  dirs.push(d)
  return d
}
function write(name, content, dir = tmpDir()) {
  const p = path.join(dir, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf8')
  return p
}

test.after(() => {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

test('合法的 .js → 检查过且无错误', async () => {
  const p = write('ok.js', "const a = 1\nmodule.exports = { a }\n")
  assert.deepEqual(await diagnoseFile(p), [])
})

test('语法错的 .js → 带行号与 SyntaxError 文案', async () => {
  const p = write('bad.js', "const a = 1\nconst b = {\n")
  const diags = await diagnoseFile(p)
  assert.ok(Array.isArray(diags) && diags.length > 0, '应当报告错误')
  assert.match(diags[0].message, /Error/i)
  assert.equal(typeof diags[0].line, 'number', '应当能给出出错行号')
})

test('.json：合法解析通过，坏 JSON 报位置', async () => {
  assert.deepEqual(await diagnoseFile(write('ok.json', '{"a":1}')), [])
  const diags = await diagnoseFile(write('bad.json', '{"a":1,}'))
  assert.ok(diags.length > 0)
  assert.match(diags[0].message, /JSON|property|token/i)
})

test('不检查的形态一律返回 null（静默跳过，不报错）', async () => {
  assert.equal(await diagnoseFile(write('a.md', '# hi')), null, '不认识的扩展名')
  assert.equal(await diagnoseFile(write('empty.js', '')), null, '空文件')
  assert.equal(await diagnoseFile(path.join(tmpDir(), 'nope.js')), null, '文件不存在')
  assert.equal(await diagnoseFile(''), null, '空路径')
  assert.equal(await diagnoseFile(null), null, 'null 路径')
})

test('node_modules 下的文件不查（不是用户代码，且慢）', async () => {
  const d = tmpDir()
  const p = write(path.join('node_modules', 'pkg', 'i.js'), 'const x = {\n', d)
  assert.equal(await diagnoseFile(p), null)
})

test('attachDiagnostics：有错时附 diagnostics + note，无错时不加任何字段', async () => {
  const bad = { path: write('bad2.js', 'const a = {\n'), replacedCount: 1 }
  const r1 = await attachDiagnostics(bad, bad.path)
  assert.equal(r1, bad, '原地返回，便于 handler 链式使用')
  assert.ok(Array.isArray(r1.diagnostics) && r1.diagnostics.length > 0)
  assert.match(r1.diagnosticsNote, /编译不过/)

  const good = { path: write('good.js', 'const a = 1\n'), replacedCount: 1 }
  const r2 = await attachDiagnostics(good, good.path)
  assert.equal(r2.diagnostics, undefined, '干净的写盘不该多带字段')
  assert.equal(r2.diagnosticsNote, undefined)
})

test('诊断自身出问题也不影响写盘结果（不抛异常）', async () => {
  const weird = { path: 12345, replacedCount: 1 }
  const r = await attachDiagnostics(weird, weird.path)
  assert.equal(r.diagnostics, undefined)
  assert.equal(await diagnoseFile({ not: 'a path' }), null)
})

// ---------------- 自动 lint（P1-6，2026-10-24） ----------------
// 口径：只跑项目内 eslint（node_modules/.bin）且必须有配置；没有就静默跳过。
// 这里只验"跳过"分支 —— 真跑 eslint 需要装依赖，不适合单测。

test('lintFile：非前端扩展名 / 没有项目 eslint 时静默跳过', async () => {
  const { lintFile, finalizeWrite } = require(path.join(__dirname, '..', 'electron', 'tools', 'quick-diag.js'))
  assert.equal(await lintFile(write('a.md', '# hi')), null, 'md 不 lint')
  assert.equal(await lintFile(write('b.js', 'const a = 1\n')), null, '临时目录没有 node_modules/.bin/eslint')

  const res = { path: write('c.js', 'const a = 1\n'), replacedCount: 1 }
  const out = await finalizeWrite(res, res.path)
  assert.equal(out.lint, undefined, '没有 eslint 时不该凭空造出 lint 字段')
  assert.equal(out.lintFixed, undefined)
  assert.equal(out.diff, undefined, '本用例只验证不新增字段')
})
