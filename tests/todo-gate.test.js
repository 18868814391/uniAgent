// electron/todo-gate.js 的单测（纯函数，不 require electron）。
//
// 背景见模块头：真实会话里模型跑了 39 次工具调用、0 次写盘，却输出"完工报告"，
// 内核按 complete 收尾。这里锁住四条判据：
//   ① 「清单未完成」要拦，但只拦有限次（不能把用户锁在循环里）
//   ② 「声称改动但 0 次写盘」要拦，且不能误伤如实说明（"我没有修改任何文件"）
//   ③ 写盘失败 ≠ 改过了（success:false 不算）
//   ④ 「声称测试/编译通过但 0 条成功校验」要拦（2026-10-24 补，P0-3）
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const gate = require(path.join(__dirname, '..', 'electron', 'todo-gate.js'))

const PENDING = [
  { text: '改 ModelLib.cs', status: 'in_progress' },
  { text: '跑编译自检', status: 'pending' },
]

test('looksLikeWriteClaim：报告式正文命中，如实说明不命中', () => {
  assert.equal(gate.looksLikeWriteClaim('| `ModelLib.cs` | 🆕 | 重写 |'), true, '改动标记 emoji')
  assert.equal(gate.looksLikeWriteClaim('已新增 Assets/Scripts/ModelLib.cs'), true, '动词 + 文件后缀')
  assert.equal(gate.looksLikeWriteClaim('我修改了 SpriteLib.cs 的开关'), true)

  assert.equal(gate.looksLikeWriteClaim('我没有修改任何文件'), false, '如实说明不能被误判')
  assert.equal(gate.looksLikeWriteClaim('只读了一遍 ModelLib.cs，没有改动'), false, '有文件名但没动词')
  assert.equal(gate.looksLikeWriteClaim('把 foo.cs 里的 X 改成 Y 就行'), false, '指令语气不算声称')
  assert.equal(gate.looksLikeWriteClaim('建议新增一个 ModelLib.cs 来封装'), false, '建议 ≠ 已做')
  assert.equal(gate.looksLikeWriteClaim('把计划说清楚：先读再写'), false, '没有文件名')
  assert.equal(gate.looksLikeWriteClaim(''), false)
  assert.equal(gate.looksLikeWriteClaim(null), false)
})

test('writeSucceeded：只有显式 success:false 才算失败；纯文本结果按成功算', () => {
  assert.equal(gate.writeSucceeded(JSON.stringify({ success: true })), true)
  assert.equal(gate.writeSucceeded(JSON.stringify({ success: false, error: 'permission denied' })), false)
  assert.equal(gate.writeSucceeded('已写入 12 行'), true, '非 JSON 结果不打失败标记')
  assert.equal(gate.writeSucceeded(''), true)
  assert.equal(gate.isWriteTool('edit_file'), true)
  assert.equal(gate.isWriteTool('execute_command'), false, '命令里的脚本无法可靠识别，不计入写盘')
})

test('清单未完成 → 拦；两个闸门都空 → 放行', () => {
  const r = gate.decideFinalGate({ todos: PENDING, wroteFiles: 3, answerText: '做完了', gatesPushed: 0 })
  assert.equal(r.todoGate, true)
  assert.equal(r.claimGate, false)
  assert.match(r.text, /【收口核对 · 任务清单还有 2 项未完成】/)
  assert.match(r.text, /\[~\] 改 ModelLib\.cs/)
  assert.match(r.text, /\[ \] 跑编译自检/)
  assert.match(r.text, /update_todos/, '必须告诉它怎么改清单')

  const clean = gate.decideFinalGate({
    todos: [{ text: 'a', status: 'completed' }],
    wroteFiles: 0,
    answerText: '读完了，没动任何文件',
    gatesPushed: 0,
  })
  assert.equal(clean.text, '', '清单全完成且没声称改动 → 不该拦')
  assert.equal(clean.openCount, 0)
})

test('清单闸门有上限：回推 MAX_TODO_GATES 次后放行（但 openCount 仍如实返回）', () => {
  for (let i = 0; i < gate.MAX_TODO_GATES; i++) {
    const r = gate.decideFinalGate({ todos: PENDING, wroteFiles: 1, answerText: 'x', gatesPushed: i })
    assert.equal(r.todoGate, true, `第 ${i + 1} 次应仍拦截`)
  }
  const last = gate.decideFinalGate({ todos: PENDING, wroteFiles: 1, answerText: 'x', gatesPushed: gate.MAX_TODO_GATES })
  assert.equal(last.todoGate, false, '用尽后不再拦')
  assert.equal(last.text, '')
  assert.equal(last.openCount, 2, 'openCount 要给收尾算 endReason 用')
})

test('声称改动但 0 次写盘 → 拦一次；写过盘就不拦', () => {
  const claim = gate.decideFinalGate({
    todos: [],
    wroteFiles: 0,
    answerText: '| `ModelLib.cs` | 🆕 | 按 .fbx 加载 |',
    gatesPushed: 0,
  })
  assert.equal(claim.claimGate, true)
  assert.match(claim.text, /本次运行没有任何写盘调用/)
  assert.match(claim.text, /不要把"计划""打算做"写成"已完成"/)

  const wrote = gate.decideFinalGate({ todos: [], wroteFiles: 1, answerText: '已新增 ModelLib.cs' })
  assert.equal(wrote.claimGate, false, '真写过盘就不再核对')

  const again = gate.decideFinalGate({
    todos: [],
    wroteFiles: 0,
    answerText: '已新增 ModelLib.cs',
    claimPushed: gate.MAX_CLAIM_GATES,
  })
  assert.equal(again.claimGate, false, '只给一次机会')
})

test('两类同时命中合并成一条消息（不能变成连续两条 user）', () => {
  const r = gate.decideFinalGate({
    todos: PENDING,
    wroteFiles: 0,
    answerText: '已重写 SpriteLib.cs，加了 Use3D 总开关',
    gatesPushed: 0,
    claimPushed: 0,
  })
  assert.equal(r.todoGate, true)
  assert.equal(r.claimGate, true)
  assert.ok(r.text.includes('【收口核对 · 任务清单还有 2 项未完成】'))
  assert.ok(r.text.includes('【收口核对 · 本次运行没有任何写盘调用】'))
  assert.ok(r.text.indexOf('任务清单还有') < r.text.indexOf('没有任何写盘调用'), '顺序稳定')
})

test('buildEndDetail：点名前 3 项 + 总数（横幅空间有限）', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ text: `任务${i + 1}`, status: 'pending' }))
  const detail = gate.buildEndDetail(many)
  assert.match(detail, /还有 8 项未完成/)
  assert.match(detail, /任务1、任务2、任务3 等 8 项/)
  assert.match(detail, /点「继续」/)

  const few = gate.buildEndDetail([{ text: '跑编译自检', status: 'pending' }])
  assert.match(few, /还有 1 项未完成：跑编译自检/)
  assert.equal(gate.buildEndDetail([]), '任务清单还有未完成项，AI 提前结束了本轮。')
})

test('清单里的脏数据不炸：null、缺字段、非数组', () => {
  assert.deepEqual(gate.openTodos(null), [])
  assert.deepEqual(gate.openTodos(undefined), [])
  assert.deepEqual(gate.openTodos([null, { text: 'x', status: 'pending' }]).length, 1)
  assert.equal(gate.decideFinalGate({ todos: null, wroteFiles: 0, answerText: '' }).text, '')
})

// ---------------- ④ 自检核对（P0-3，2026-10-24） ----------------
// 拦的是这个形态：改完文件 → 输出"已修复，测试通过" → 其实一次校验都没跑。
// 判据挂在**正文**而不是"有写盘零校验"：改 .md 不需要跑校验，硬要求会变成噪音。

test('looksLikeVerifyClaim：声称通过才命中，否定/如实说明不命中', () => {
  assert.equal(gate.looksLikeVerifyClaim('已修复，测试全部通过。'), true)
  assert.equal(gate.looksLikeVerifyClaim('单测通过，编译通过'), true)
  assert.equal(gate.looksLikeVerifyClaim('all tests pass'), true)
  assert.equal(gate.looksLikeVerifyClaim('已验证 eslint 无报错'), true)

  assert.equal(gate.looksLikeVerifyClaim('测试未通过，正在排查'), false, '未通过不是声称')
  assert.equal(gate.looksLikeVerifyClaim('还没跑测试'), false)
  assert.equal(gate.looksLikeVerifyClaim('未验证'), false)
  assert.equal(gate.looksLikeVerifyClaim('我没有验证，请你打包时确认'), false)
  assert.equal(gate.looksLikeVerifyClaim('已经改好了'), false, '只改代码没提质检')
  assert.equal(gate.looksLikeVerifyClaim(''), false)
  assert.equal(gate.looksLikeVerifyClaim(null), false)
})

test('isVerifyCommand：只认校验/构建类命令，dev server 不算', () => {
  for (const c of ['node --check electron/chat.js', 'npx eslint src/a.vue', 'yarn build', 'npm test',
    'npm run lint', 'vue-tsc --noEmit', 'python -m py_compile a.py', 'mvn -q compile', 'pytest -q']) {
    assert.equal(gate.isVerifyCommand(c), true, c)
  }
  for (const c of ['git status', 'npm run dev', 'yarn dev', 'ls', 'cat a.js', '', null]) {
    assert.equal(gate.isVerifyCommand(c), false, String(c))
  }
})

test('verifySucceeded：exitCode 必须为 0（跑挂了不算验证过）', () => {
  assert.equal(gate.verifySucceeded(JSON.stringify({ success: true, exitCode: 0 })), true)
  assert.equal(gate.verifySucceeded(JSON.stringify({ success: true, exitCode: 1 })), false)
  assert.equal(gate.verifySucceeded(JSON.stringify({ success: false, exitCode: 0 })), false)
  assert.equal(gate.verifySucceeded('不是 JSON'), false)
  assert.equal(gate.verifySucceeded(''), false)
})

test('自检闸门：声称通过但 0 条校验 → 回推；跑过校验 → 放行', () => {
  const claim = '已修复，测试全部通过。'
  const hit = gate.decideFinalGate({ todos: [], answerText: claim, verifyRuns: 0 })
  assert.equal(hit.verifyGate, true)
  assert.ok(hit.text.includes('声称验证过'))

  const pass = gate.decideFinalGate({ todos: [], answerText: claim, verifyRuns: 1 })
  assert.equal(pass.verifyGate, false)
  assert.equal(pass.text, '')

  // 没声称过验证 → 不触发（改文档不需要跑校验）
  const silent = gate.decideFinalGate({ todos: [], answerText: '改好了，你把页面打开看看样式。', verifyRuns: 0 })
  assert.equal(silent.verifyGate, false)
})

test('自检闸门只给 1 次机会', () => {
  const r = gate.decideFinalGate({
    todos: [], answerText: '测试通过', verifyRuns: 0, verifyPushed: gate.MAX_VERIFY_GATES,
  })
  assert.equal(r.verifyGate, false)
})

test('三类同时命中合并成一条消息，顺序稳定（不能变成连续两条 user）', () => {
  const r = gate.decideFinalGate({
    todos: PENDING,
    wroteFiles: 0,
    verifyRuns: 0,
    answerText: '已重写 SpriteLib.cs，测试全部通过',
  })
  assert.equal(r.todoGate, true)
  assert.equal(r.claimGate, true)
  assert.equal(r.verifyGate, true)
  assert.ok(r.text.includes('任务清单还有 2 项未完成'))
  assert.ok(r.text.includes('没有任何写盘调用'))
  assert.ok(r.text.includes('声称验证过'))
  assert.ok(r.text.indexOf('任务清单还有') < r.text.indexOf('没有任何写盘调用'))
  assert.ok(r.text.indexOf('没有任何写盘调用') < r.text.indexOf('声称验证过'))
})
