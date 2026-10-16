// update_todos（结构化任务清单）单测。
// tools/todo.js 只依赖 ../state（纯对象，可直接 require），所以这里不需要 stub electron。
//
// 覆盖三块：
//   ① schema 层：工具已注册、派生 JSON schema 形状正确、非法入参被 safeParse 拦下
//   ② 纯函数层：normalizeTodos 的全部拒绝分支
//   ③ 存储与渲染层：整表覆盖 / 空数组清空 / 上限淘汰 / 每轮回显的文本内容
const test = require('node:test')
const assert = require('node:assert/strict')

const todo = require('../electron/tools/todo.js')
const { TOOLS, zodToJsonSchema } = require('../electron/tool-schemas.js')

const tool = TOOLS.find((t) => t.name === 'update_todos')

test('update_todos 已注册进 TOOLS，且派生的 JSON schema 形状正确', () => {
  assert.ok(tool, 'update_todos 必须存在于 TOOLS')

  const schema = zodToJsonSchema(tool.schema)
  assert.equal(schema.type, 'object')
  assert.equal(schema.properties.todos.type, 'array')
  assert.equal(schema.properties.todos.items.type, 'object')
  assert.equal(schema.properties.todos.items.properties.text.type, 'string')
  assert.deepEqual(schema.properties.todos.items.properties.status.enum, ['pending', 'in_progress', 'completed'])
  // status 是必填：模型漏传时由 safeParse 给出明确的字段级错误
  assert.deepEqual(schema.properties.todos.items.required, ['text', 'status'])
})

test('schema：合法清单通过；缺 status / status 非法 / 非数组被拒', () => {
  assert.equal(tool.schema.safeParse({ todos: [] }).success, true, '空数组（清空）应通过')
  assert.equal(
    tool.schema.safeParse({ todos: [{ text: '读 a.vue', status: 'pending' }] }).success,
    true
  )
  assert.equal(tool.schema.safeParse({ todos: [{ text: '读 a.vue' }] }).success, false, '缺 status 应拒绝')
  assert.equal(
    tool.schema.safeParse({ todos: [{ text: 'x', status: 'doing' }] }).success,
    false,
    '非法 status 应拒绝'
  )
  assert.equal(tool.schema.safeParse({ todos: 'nope' }).success, false, '非数组应拒绝')
})

test('normalizeTodos：拒绝非数组 / 空文本 / 超长文本 / 非法状态', () => {
  assert.equal(todo.normalizeTodos('x').ok, false)
  assert.equal(todo.normalizeTodos([null]).ok, false)
  assert.equal(todo.normalizeTodos([{ text: '   ', status: 'pending' }]).ok, false, '空白文本应拒绝')
  assert.equal(todo.normalizeTodos([{ text: 'a'.repeat(todo.MAX_TODO_TEXT + 1), status: 'pending' }]).ok, false)
  assert.equal(todo.normalizeTodos([{ text: 'a', status: 'done' }]).ok, false)
  // 文本会被 trim，status 缺省补 pending
  const ok = todo.normalizeTodos([{ text: '  读 a.vue  ' }])
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.todos, [{ text: '读 a.vue', status: 'pending' }])
})

test('同时只允许一项 in_progress（超过则整表拒绝，而不是悄悄改状态）', () => {
  const bad = todo.normalizeTodos([
    { text: 'A', status: 'in_progress' },
    { text: 'B', status: 'in_progress' },
  ])
  assert.equal(bad.ok, false)
  assert.match(bad.error, /只能有 1 项/)

  const good = todo.normalizeTodos([
    { text: 'A', status: 'in_progress' },
    { text: 'B', status: 'pending' },
  ])
  assert.equal(good.ok, true)
})

test('清单条数上限：超过 MAX_TODOS 直接拒绝', () => {
  const many = Array.from({ length: todo.MAX_TODOS + 1 }, (_, i) => ({ text: `T${i}`, status: 'pending' }))
  const res = todo.normalizeTodos(many)
  assert.equal(res.ok, false)
  assert.match(res.error, new RegExp(`最多 ${todo.MAX_TODOS} 条`))

  const fit = Array.from({ length: todo.MAX_TODOS }, (_, i) => ({ text: `T${i}`, status: 'pending' }))
  assert.equal(todo.normalizeTodos(fit).ok, true)
})

test('整表覆盖 + 空数组清空 + 缺 convId 报错', () => {
  const id = 'todo-cover'

  const first = todo.updateTodos(id, [
    { text: '读 3 个文件', status: 'in_progress' },
    { text: '改 2 处', status: 'pending' },
  ])
  assert.equal(first.ok, true)
  assert.equal(todo.getTodos(id).length, 2)

  // 整表覆盖：第二次只传一条，旧的两条必须消失（不做增量合并）
  const second = todo.updateTodos(id, [{ text: '只做这一件', status: 'in_progress' }])
  assert.equal(second.ok, true)
  assert.deepEqual(todo.getTodos(id).map((t) => t.text), ['只做这一件'])

  // 空数组 = 清空
  const cleared = todo.updateTodos(id, [])
  assert.equal(cleared.ok, true)
  assert.equal(cleared.cleared, true)
  assert.deepEqual(todo.getTodos(id), [])

  // 缺会话标识：必须拒绝（否则会写进 undefined 键、回显到所有会话）
  const noConv = todo.updateTodos(null, [{ text: 'x', status: 'pending' }])
  assert.equal(noConv.ok, false)
  assert.match(noConv.error, /缺少会话标识/)
})

test('renderTodoSection：无清单返回空串（调用方跳过、零开销）', () => {
  assert.equal(todo.renderTodoSection('todo-empty'), '')
  assert.equal(todo.renderTodoSection(undefined), '')
})

test('renderTodoSection：只回显未完成项，已完成的文本不占 token', () => {
  const id = 'todo-render'
  todo.updateTodos(id, [
    { text: '已完成的老任务-不应出现在回显里', status: 'completed' },
    { text: '正在做的第二项', status: 'in_progress' },
    { text: '还没开始的第三项', status: 'pending' },
  ])

  const section = todo.renderTodoSection(id)
  assert.match(section, /共 3 项，已完成 1 项/)
  assert.match(section, /当前进行中：正在做的第二项/)
  assert.match(section, /\[~\] 正在做的第二项/)
  assert.match(section, /\[ \] 还没开始的第三项/)
  assert.equal(section.includes('已完成的老任务'), false, '已完成项不应回显（每轮都要重发，白占 token）')
  assert.equal(section.includes('[x]'), false)
  todo.clearTodos(id)
})

test('renderTodoSection：全部完成时仍给一行统计与收尾要求，且明确要求**保留**清单', () => {
  const id = 'todo-alldone'
  todo.updateTodos(id, [
    { text: 'A', status: 'completed' },
    { text: 'B', status: 'completed' },
  ])
  const section = todo.renderTodoSection(id)
  assert.match(section, /已完成 2 项/)
  assert.match(section, /- （无）/)
  // 回归：曾经这里写的是"不要重复调用本工具"，而提示词另一处却要求"全部做完后清空一次"——
  // 模型照做后清单在收尾时凭空消失（界面上的面板跟着没了）。注入段必须明确「保留」。
  assert.match(section, /不要为了"收尾"把清单清空/)
  assert.match(section, /保留/)
  todo.clearTodos(id)
})

test('工具说明与注入段都不含「做完后清空」这类强制清空指令（回归）', () => {
  const { TOOLS } = require('../electron/tool-schemas.js')
  const desc = TOOLS.find((t) => t.name === 'update_todos').description

  // 「清空」只能出现在「用户明确要求/计划作废」的语境里，不能是完成流程的一步
  // ⚠️ 只挑**无歧义**的禁用措辞：不能写 /做完后清空/，它会匹配到禁令本身
  //    "**不要**在做完后清空清单"，断言必然假 FAIL。
  const badPatterns = [/全部做完后清空/, /完成后清空一次/, /清空一次/, /收尾时清空/]
  for (const re of badPatterns) {
    assert.doesNotMatch(desc, re, `工具说明里出现了强制清空指令：${re}`)
  }
  assert.match(desc, /不要在做完后清空清单/, '工具说明必须显式禁止收尾清空')

  const section = (() => {
    todo.updateTodos('todo-regress', [{ text: 'X', status: 'completed' }])
    const s = todo.renderTodoSection('todo-regress')
    todo.clearTodos('todo-regress')
    return s
  })()
  for (const re of badPatterns) {
    assert.doesNotMatch(section, re, `注入段里出现了强制清空指令：${re}`)
  }
})

test('formatTodoList / todoResultText：标记与计数正确，空清单有独立文案', () => {
  const todos = [
    { text: 'A', status: 'completed' },
    { text: 'B', status: 'in_progress' },
    { text: 'C', status: 'pending' },
  ]
  assert.equal(todo.formatTodoList(todos), '[x] A\n[~] B\n[ ] C')
  assert.equal(todo.formatTodoList([]), '')

  const text = todo.todoResultText(todos)
  assert.match(text, /共 3 项：已完成 1，进行中 1，待办 1/)
  assert.match(text, /\[x\] A/)
  assert.equal(todo.todoResultText([]), '任务清单已清空。')
})

test('会话上限：写入超过 MAX_CONV_TODOS 份清单时淘汰最旧那份', () => {
  const store = require('../electron/state.js').todos
  const before = store.size
  const total = 51
  for (let i = 0; i < total; i++) {
    todo.updateTodos(`todo-evict-${i}`, [{ text: `T${i}`, status: 'pending' }])
  }
  assert.ok(store.size <= 50, `清单 Map 不应无限增长，实际 ${store.size}`)
  assert.equal(todo.getTodos('todo-evict-0').length, 0, '最旧的应被淘汰')
  assert.equal(todo.getTodos(`todo-evict-${total - 1}`).length, 1, '最新的必须保留')
  for (let i = 0; i < total; i++) todo.clearTodos(`todo-evict-${i}`)
  assert.equal(store.size, before, '清理后应回到测试前的规模')
})

test('幂等：同一份清单重复写入，回显文本与存储都稳定', () => {
  const id = 'todo-idempotent'
  const list = [
    { text: 'A', status: 'in_progress' },
    { text: 'B', status: 'pending' },
  ]
  todo.updateTodos(id, list)
  const first = todo.renderTodoSection(id)
  todo.updateTodos(id, list)
  const second = todo.renderTodoSection(id)
  assert.equal(first, second)
  // 返回值是独立副本，外部改它不会污染存储
  const res = todo.updateTodos(id, list)
  res.todos[0].text = '被外部改掉了'
  assert.equal(todo.getTodos(id)[0].text, 'A')
  todo.clearTodos(id)
})
