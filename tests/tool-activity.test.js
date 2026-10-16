// 工具活动台账（上下文压缩的「另一半」）—— 回归测试（2026-10-04）
//
// 背景（第三轮评估实测确认的 P1-1）：会话历史在渲染层只以 { role, content } 落盘，
// 工具调用与结果从不进 messages。于是压缩时摘要器只看得见「聊了什么」、看不见「做了什么」——
// 压缩后模型不知道代码改到哪一步，会重复读已改过的文件、甚至覆盖已完成的改动。
// 本模块是那半边的记录：sidecar `userData/conversations/<id>.activity.json`。
//
// 本文件锁住 6 条：
//   1) describeToolActivity 对关键工具提取出「目标 + 做了什么」；失败的调用带 ✗ 与首行错误
//   2) 追加是累积的（跨调用），且连续完全相同的条目合并计数（否则「反复读同一文件」会吃光上限）
//   3) 超上限时丢**最早**的（那些通常已被写进摘要）
//   4) renderToolActivity 超长时保留**最近**的（当前走到哪一步比早期活动更关键）
//   5) 台账读写绝不抛错（它是锦上添花，不能影响压缩/工具回填主流程）
//   6) deleteToolActivity 真的删掉 sidecar（会话删除时要清理，否则留孤儿文件）
//
// 本模块加载时 require('electron')，用桩把 app.getPath('userData') 指到临时目录。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TA = path.join(__dirname, '..', 'electron', 'tool-activity.js')

const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-activity-'))
const id = (request, exports) => {
  const rid = require.resolve(request, { paths: [path.dirname(TA)] })
  require.cache[rid] = { id: rid, filename: rid, loaded: true, exports }
}
id('electron', { app: { getPath: () => USERDATA } })

const activity = require(TA)
const sidecar = () => path.join(USERDATA, 'conversations', 'c1.activity.json')
const reset = () => {
  fs.rmSync(sidecar(), { force: true })
}

test('describeToolActivity：关键工具能提取「目标 + 做了什么」', () => {
  const cases = [
    ['read_file', { path: 'src/a.vue' }, '{"success":true,"content":"x"}', 'src/a.vue', /读取/],
    ['edit_file', { path: 'src/a.vue' }, '{"success":true,"result":{"path":"src/a.vue","replacedCount":3}}', 'src/a.vue', /替换 3 处/],
    ['write_file', { path: 'new.js' }, '{"success":true,"result":{"created":true}}', 'new.js', /新建文件/],
    ['delete_file', { path: 'old.js' }, '{"success":true,"result":{"deleted":true}}', 'old.js', /已删除/],
    ['grep_code', { pattern: 'defineProps' }, '{"success":true,"results":[1,2,3]}', 'defineProps', /命中 3 处/],
    ['list_directory', { path: 'src' }, '{"success":true,"result":{"files":["a","b"]}}', 'src', /列出 2 个文件/],
  ]
  for (const [tool, args, result, wantTarget, wantNote] of cases) {
    const e = activity.describeToolActivity(tool, args, result, 123)
    assert.equal(e.tool, tool)
    assert.equal(e.target, wantTarget, `${tool} 的目标应是 ${wantTarget}`)
    assert.match(e.note, wantNote, `${tool} 的说明应匹配 ${wantNote}`)
    assert.equal(e.ok, true)
    assert.equal(e.ts, 123)
  }
})

test('describeToolActivity：execute_command 带上退出码；失败时带首行错误并标 ✗', () => {
  const okRun = activity.describeToolActivity('execute_command', { command: 'npm test' }, '{"success":true,"exitCode":0}')
  assert.match(okRun.target, /npm test/)
  assert.match(okRun.note, /exitCode=0/)
  assert.equal(okRun.ok, true)

  const bad = activity.describeToolActivity(
    'execute_command',
    { command: 'npm test' },
    JSON.stringify({ success: false, exitCode: 1, stderr: 'AssertionError: expected 1 to be 2\n  at test.js:3' }),
  )
  assert.equal(bad.ok, false)
  assert.match(bad.note, /exitCode=1/)
  assert.match(bad.note, /失败/)
  assert.match(bad.note, /AssertionError/, '失败时要把首行错误带上 —— 「试过什么、为什么不成」最关键')
  assert.ok(!bad.note.includes('at test.js:3'), '只要首行，不要把堆栈整段塞进台账')
})

test('describeToolActivity：read_file 要能一眼看出「是撞了上限还是分段没读完」', () => {
  // 2026-10-04 排查真实事故时，旧文案只说「内容被截断」，分不清是撞了单次上限
  // （上限太紧 → 真 bug）还是模型自己传了 offset/limit 的分段读（正常行为）。
  // 现在把「本次行数 / 全文行数 / 续读 offset」都带上。
  const capped = activity.describeToolActivity(
    'read_file',
    { path: 'BigPage.vue' },
    '{"success":true,"truncated":true,"limit":8000,"totalLines":20000,"nextOffset":8001}',
  )
  assert.match(capped.note, /8000\/20000 行/, '要带上本次/全文行数，一眼看出是上限在起作用')
  assert.match(capped.note, /offset=8001/, '要给出续读位置')

  // 分段读没读到末尾：同样给出位置信息（这不是 bug，是正常的分段）
  const ranged = activity.describeToolActivity(
    'read_file',
    { path: 'a.js' },
    '{"success":true,"truncated":true,"limit":100,"totalLines":900,"nextOffset":101}',
  )
  assert.match(ranged.note, /100\/900 行/)

  // 超长单行被硬截断：说清是「单行问题」，不要让人以为可以靠 offset 续读
  const minified = activity.describeToolActivity(
    'read_file',
    { path: 'min.js' },
    '{"success":true,"truncated":true,"lineTruncated":true}',
  )
  assert.match(minified.note, /超长单行/)

  // 整份读完：就是「读取」
  const full = activity.describeToolActivity('read_file', { path: 'ok.js' }, '{"success":true,"content":"x"}')
  assert.equal(full.note, '读取')
})

test('describeToolActivity：命令超时 / 输出截断都要如实记录', () => {
  const to = activity.describeToolActivity('execute_command', { command: 'sleep 999' }, '{"success":false,"timedOut":true,"exitCode":-1}')
  assert.match(to.note, /超时/)

  const tr = activity.describeToolActivity(
    'execute_command',
    { command: 'build' },
    '{"success":true,"exitCode":0,"stdoutTruncated":true,"stdoutPath":"C:/x/y.log"}',
  )
  assert.match(tr.note, /输出已截断/)
  assert.match(tr.note, /y\.log/, '要把完整日志路径带进台账，压缩后模型才知道去捞')
})

test('追加是累积的；连续完全相同的条目合并计数', () => {
  reset()
  activity.appendToolActivity('c1', [
    activity.describeToolActivity('read_file', { path: 'a.js' }, '{"success":true}'),
  ])
  activity.appendToolActivity('c1', [
    activity.describeToolActivity('read_file', { path: 'a.js' }, '{"success":true}'), // 与上一条相同 → 计数
    activity.describeToolActivity('edit_file', { path: 'a.js' }, '{"success":true,"result":{"replacedCount":1}}'),
  ])

  const entries = activity.readToolActivity('c1')
  assert.equal(entries.length, 2, '相同条目应合并，不该出现 3 条')
  assert.equal(entries[0].n, 2, '连续相同条目应累加计数')
  assert.equal(entries[1].tool, 'edit_file')
})

test('超上限时丢最早的（更早的通常已被写进摘要）', () => {
  reset()
  for (let i = 0; i < activity.MAX_ENTRIES + 20; i++) {
    activity.appendToolActivity('c1', [
      activity.describeToolActivity('read_file', { path: `f${i}.js` }, '{"success":true}'),
    ])
  }
  const entries = activity.readToolActivity('c1')
  assert.equal(entries.length, activity.MAX_ENTRIES)
  assert.match(entries[entries.length - 1].target, new RegExp(`f${activity.MAX_ENTRIES + 19}\\.js`), '最后一条应是最新的')
  assert.ok(!entries.some((e) => e.target === 'f0.js'), '最早的应被丢弃')
})

test('renderToolActivity：超长时保留最近的（当前进度比早期活动更重要）', () => {
  reset()
  const entries = []
  for (let i = 0; i < 400; i++) {
    entries.push({ tool: 'read_file', target: `very-long-path-${i}/file-${i}.js`, ok: true, note: '读取', ts: i })
  }
  const text = activity.renderToolActivity(entries, 2000)
  assert.ok(text.length <= 2200, `渲染结果应受上限约束，实测 ${text.length}`)
  assert.match(text, /更早的 \d+ 条工具活动已省略/, '要说明省略了多少条')
  assert.match(text, /file-399\.js/, '必须保留最新的')
  assert.ok(!text.includes('file-0.js'), '最早的应被省略')
})

test('失败条目在渲染里带 ✗', () => {
  const text = activity.renderToolActivity([
    { tool: 'execute_command', target: 'npm test', ok: false, note: 'exitCode=1｜失败', ts: 1 },
  ])
  assert.match(text, /✗/)
})

test('台账读写绝不抛错（best-effort，不能影响主流程）', () => {
  reset()
  // 不存在的会话 → 空数组，不抛
  assert.deepEqual(activity.readToolActivity('no-such-conv'), [])
  // 空/异常入参 → 静默忽略
  assert.doesNotThrow(() => activity.appendToolActivity('c1', []))
  assert.doesNotThrow(() => activity.appendToolActivity(null, [{ tool: 'x' }]))
  assert.doesNotThrow(() => activity.appendToolActivity('c1', [null, {}, { tool: 'read_file' }]))
  // 坏 JSON → 空数组
  fs.mkdirSync(path.join(USERDATA, 'conversations'), { recursive: true })
  fs.writeFileSync(sidecar(), '{ this is not json', 'utf-8')
  assert.deepEqual(activity.readToolActivity('c1'), [])
  assert.doesNotThrow(() => activity.deleteToolActivity('c1'))
})

test('deleteToolActivity 真的删掉 sidecar（会话删除时不留孤儿）', () => {
  reset()
  activity.appendToolActivity('c1', [
    activity.describeToolActivity('edit_file', { path: 'a.js' }, '{"success":true,"result":{}}'),
  ])
  assert.equal(fs.existsSync(sidecar()), true)
  activity.deleteToolActivity('c1')
  assert.equal(fs.existsSync(sidecar()), false)
  assert.deepEqual(activity.readToolActivity('c1'), [])
})
