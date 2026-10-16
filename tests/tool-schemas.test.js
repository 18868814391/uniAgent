// 工具 schema 单测：
// 1) 由 zod 自动派生的 tools 定义与旧的手写静态 schema 快照逐字段等价（防回归）；
// 2) 执行前校验（safeParse）能返回带具体字段路径的结构化错误。
// 快照来源：改动前的 electron/main.js 中手写的 TOOLS_DEFINITION。
// 若有意调整某个工具的 schema，请同步更新快照：
//   node tests/update-snapshot.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { TOOLS, zodToJsonSchema } = require('../electron/tool-schemas.js')

const snapshotPath = path.join(__dirname, 'fixtures', 'tools-definition.snapshot.json')
const expected = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'))

test(`生成的 tools 定义与旧手写快照逐字段等价（${expected.length} 个工具）`, () => {
  const generated = TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: zodToJsonSchema(t.schema) },
  }))
  assert.deepEqual(generated, expected)
})

test('工具名称与快照一致且不重复', () => {
  const names = TOOLS.map((t) => t.name)
  assert.equal(names.length, expected.length)
  assert.equal(new Set(names).size, names.length, '工具名称不应重复')
})

test('read_file：缺少必填 path → 返回含字段路径的错误', () => {
  const tool = TOOLS.find((t) => t.name === 'read_file')
  const v = tool.schema.safeParse({})
  assert.equal(v.success, false)
  assert.ok(v.error.issues.some((i) => i.path.join('.') === 'path'))
})

test('read_file：path 类型错误 → 错误路径指向 path', () => {
  const tool = TOOLS.find((t) => t.name === 'read_file')
  const v = tool.schema.safeParse({ path: 123 })
  assert.equal(v.success, false)
  assert.ok(v.error.issues.some((i) => i.path.join('.') === 'path'))
})

test('read_file：method 枚举校验（GET/POST 通过，其它拒绝）', () => {
  const tool = TOOLS.find((t) => t.name === 'read_file')
  assert.equal(tool.schema.safeParse({ method: 'GET', url: 'his-finance/x/page' }).success, true)
  assert.equal(tool.schema.safeParse({ method: 'PUT', url: 'x' }).success, false)
  // body 为任意对象，可透传
  const v = tool.schema.safeParse({ method: 'POST', url: 'x', body: { pageNo: 1, name: 'aa' } })
  assert.equal(v.success, true)
  assert.deepEqual(v.data.body, { pageNo: 1, name: 'aa' })
})

test('browser_eval：arg 任意对象可选，缺失也通过', () => {
  const tool = TOOLS.find((t) => t.name === 'browser_eval')
  assert.equal(tool.schema.safeParse({ js: 'return 1' }).success, true)
  const v = tool.schema.safeParse({ js: 'return arg.x', arg: { x: 42 } })
  assert.equal(v.success, true)
  assert.deepEqual(v.data.arg, { x: 42 })
})

test('ask_user：question 不能为空 / options 最多 6 个', () => {
  const tool = TOOLS.find((t) => t.name === 'ask_user')
  assert.equal(tool.schema.safeParse({ question: '   ' }).success, false, '空白 question 应拒绝')
  assert.equal(tool.schema.safeParse({ question: '选哪个？', options: ['a', 'b'] }).success, true)
  assert.equal(tool.schema.safeParse({ question: 'q', options: ['1', '2', '3', '4', '5', '6', '7'] }).success, false, '超过 6 个选项应拒绝')
  // .trim() 变换：question 会去掉首尾空白
  const v = tool.schema.safeParse({ question: '  走 A 还是 B？  ' })
  assert.equal(v.success, true)
  assert.equal(v.data.question, '走 A 还是 B？')
})

test('空参数工具（list_skills 等）允许空对象', () => {
  const tool = TOOLS.find((t) => t.name === 'list_skills')
  assert.equal(tool.schema.safeParse({}).success, true)
})

test('search_history：query 必填，limit 范围与整数校验', () => {
  const tool = TOOLS.find((t) => t.name === 'search_history')
  assert.equal(tool.schema.safeParse({}).success, false, '缺 query 应拒绝')
  assert.equal(tool.schema.safeParse({ query: '日报' }).success, true)
  assert.equal(tool.schema.safeParse({ query: 'x', limit: 0 }).success, false, 'limit 最小 1')
  assert.equal(tool.schema.safeParse({ query: 'x', limit: 11 }).success, false, 'limit 最大 10')
  assert.equal(tool.schema.safeParse({ query: 'x', limit: 3.5 }).success, false, 'limit 必须是整数')
  assert.equal(tool.schema.safeParse({ query: 'x', limit: 5 }).success, true)
})

test('edit_file：必填 old_string/new_string，replace_all 可选', () => {
  const tool = TOOLS.find((t) => t.name === 'edit_file')
  assert.equal(tool.schema.safeParse({ path: '/a.js' }).success, false, '缺 old_string 应拒绝')
  assert.equal(tool.schema.safeParse({ path: '/a.js', old_string: 'a', new_string: 'b' }).success, true)
  assert.equal(tool.schema.safeParse({ path: '/a.js', old_string: 'a', new_string: 'b', replace_all: true }).success, true)
})

test('grep_code：必填 pattern，path/include/max_results 可选', () => {
  const tool = TOOLS.find((t) => t.name === 'grep_code')
  assert.equal(tool.schema.safeParse({}).success, false, '缺 pattern 应拒绝')
  assert.equal(tool.schema.safeParse({ pattern: 'handleClick' }).success, true)
  assert.equal(tool.schema.safeParse({ pattern: 'fn\\(', path: '/src', include: '*.vue', max_results: 50 }).success, true)
  assert.equal(tool.schema.safeParse({ pattern: 'x', max_results: 101 }).success, false, 'max_results 上限 100')
})

test('glob_files：必填 pattern，path/max_results 可选', () => {
  const tool = TOOLS.find((t) => t.name === 'glob_files')
  assert.equal(tool.schema.safeParse({}).success, false, '缺 pattern 应拒绝')
  assert.equal(tool.schema.safeParse({ pattern: 'src/**/*.vue' }).success, true)
  assert.equal(tool.schema.safeParse({ pattern: '*.ts', path: '/src', max_results: 100 }).success, true)
  assert.equal(tool.schema.safeParse({ pattern: '*.ts', max_results: 201 }).success, false, 'max_results 上限 200')
})

test('read_file：支持 offset/limit 可选参数', () => {
  const tool = TOOLS.find((t) => t.name === 'read_file')
  assert.equal(tool.schema.safeParse({ path: '/a.js' }).success, true)
  assert.equal(tool.schema.safeParse({ path: '/a.js', offset: 10, limit: 20 }).success, true)
  assert.equal(tool.schema.safeParse({ path: '/a.js', offset: 0 }).success, false, 'offset 最小 1')
  assert.equal(tool.schema.safeParse({ path: '/a.js', limit: -1 }).success, false, 'limit 最小 1')
})
