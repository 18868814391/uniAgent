// 子代理「只读」策略的回归测试 —— 2026-10-04
//
// 背景（第三轮评估实测确认的 P0）：子代理原先只靠提示词约束只读，实际却拿到了
// write_file / edit_file / delete_file / write_skill / write_memory / execute_command 全套，
// 且**完全不经过 tools/guard.js**（guard 只在 chat.js 主循环里对 dev 角色调用）。
// dev 角色下 fs-safe 的 isPathAllowed 又是直接放行 →
// 「派个子代理去调研 XX」可以变成「无确认框、无守卫、无记录的任意写盘 + 任意命令」。
//
// 本文件锁住三层：
//   1) 纯策略：checkSubAgentCommand —— 只读命令放行，任何能写/能串联/能替换的形态一律拒
//   2) 名单：BLOCKED_TOOLS 必须同时含流程类与写类工具
//   3) 执行层兜底：tools/index.js 的 executeToolCall 对 ctx.subAgent 真的拒（防文本形态调用还原绕过）
//      且**不能误伤主 Agent**（ctx 无 subAgent 时必须放行）
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const POLICY = path.join(__dirname, '..', 'electron', 'tools', 'subagent-policy.js')
const INDEX = path.join(__dirname, '..', 'electron', 'tools', 'index.js')
const DIR = path.dirname(INDEX)

const policy = require(POLICY)

// ---------------- 1) 纯策略 ----------------

test('只读命令白名单：ls / cat / grep / git log 等放行', () => {
  const ok = [
    'ls',
    'ls -la',
    'cat src/a.vue',
    'head -n 20 package.json',
    'tail -n 5 error.log',
    'wc -l src/main.js',
    'grep -rn "defineProps" src/',
    'rg TODO',
    'git status',
    'git log --oneline -20',
    'git diff HEAD~1',
    'git show HEAD',
    'git ls-files',
  ]
  for (const cmd of ok) {
    const r = policy.checkSubAgentCommand(cmd)
    assert.equal(r.ok, true, `应放行：${cmd}（原因：${r.reason}）`)
  }
})

test('解释器只允许问版本', () => {
  assert.equal(policy.checkSubAgentCommand('node --version').ok, true)
  assert.equal(policy.checkSubAgentCommand('node -v').ok, true)
  assert.equal(policy.checkSubAgentCommand('python --version').ok, true)
  // 一个命令改全盘 —— 必须拒
  assert.equal(policy.checkSubAgentCommand('node -e "require(\'fs\').writeFileSync(\'a\',\'b\')"').ok, false)
  assert.equal(policy.checkSubAgentCommand('python -c "open(\'a\',\'w\')"').ok, false)
})

test('写类 / 串联 / 重定向 / 命令替换一律拒绝', () => {
  const bad = [
    'rm -rf /tmp/x',
    'mv a b',
    'cp a b',
    'touch new.txt',
    'mkdir -p a/b',
    'chmod +x run.sh',
    'tee out.txt',
    'sed -i "s/a/b/" f.txt',
    'find . -delete',
    'find . -exec rm {} \\;',
    'echo hi > out.txt',
    'cat a >> b',
    'cat a | tee b',
    'ls && rm -rf x',
    'ls; rm x',
    'npm install',
    'git checkout -- .',
    'git reset --hard',
    'git clean -fd',
    'git commit -m x',
    '`whoami`',
    'echo $(whoami)',
  ]
  for (const cmd of bad) {
    const r = policy.checkSubAgentCommand(cmd)
    assert.equal(r.ok, false, `必须拒绝：${cmd}`)
  }
})

test('空命令拒绝', () => {
  assert.equal(policy.checkSubAgentCommand('').ok, false)
  assert.equal(policy.checkSubAgentCommand('   ').ok, false)
  assert.equal(policy.checkSubAgentCommand(null).ok, false)
})

test('BLOCKED_TOOLS 同时含流程类与写类工具', () => {
  for (const n of [
    'spawn_sub_agent', 'get_sub_agent_results', 'ask_user', 'update_todos',
    'write_file', 'edit_file', 'delete_file', 'write_skill', 'write_memory',
  ]) {
    assert.ok(policy.BLOCKED_TOOLS.has(n), `${n} 必须在 BLOCKED_TOOLS 里`)
  }
  // 只读工具不能被误拦
  for (const n of ['read_file', 'grep_code', 'glob_files', 'list_directory', 'execute_command']) {
    assert.ok(!policy.BLOCKED_TOOLS.has(n), `${n} 不应被拦（execute_command 靠命令白名单过滤）`)
  }
})

// ---------------- 3) 执行层兜底 ----------------

const stub = (request, exports) => {
  const id = require.resolve(request, { paths: [DIR] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

const executed = []
const TOOLS = [
  'read_file', 'write_file', 'edit_file', 'delete_file', 'execute_command',
].map((name) => ({
  name,
  schema: { safeParse: (p) => ({ success: true, data: p || {} }) },
}))

stub('../state', { settings: {} })
stub('../tool-schemas', { TOOLS })
stub('./fs-safe', {
  readFileWithRange: () => 'content',
  writeFileSafe: () => ({ path: 'p' }),
  editFileSafe: () => ({ path: 'p' }),
  deleteFileSafe: () => ({ path: 'p' }),
  listDirSafe: () => ({ files: [] }),
})
stub('./skills', { listAllSkills: () => [], readSkillByName: () => ({}) })
stub('./shell', {
  executeCommand: async (command) => {
    executed.push(command)
    return JSON.stringify({ success: true, stdout: 'stub' })
  },
  killAllChildren: () => {},
})
stub('./network', { searchWeb: async () => '{}' })
stub('./search', { grepCode: async () => '{}', globFiles: async () => '{}' })
stub('./erp', {})
stub('../conversations', { searchConversationHistory: async () => [] })
stub('../browser-test', {})
stub('../settings', {})
stub('../agents-md', { recordPathTouched: () => {} })
stub('./todo', { updateTodos: () => ({ ok: true, todos: [] }), todoResultText: () => '' })
stub('./legal-npc-search', { legalNpcSearch: async () => ({}) })
stub('./download', { downloadUrl: async () => ({}) })
stub('../sub-agent', { handleSpawnSubAgent: () => '{}', handleGetSubAgentResults: () => '{}' })

const { executeToolCall } = require(INDEX)

const call = (name, args, ctx) =>
  executeToolCall({ function: { name, arguments: JSON.stringify(args) } }, ctx)

test('执行层对 ctx.subAgent 硬拒写类工具（防文本形态调用还原绕过）', async () => {
  executed.length = 0
  for (const name of ['write_file', 'edit_file', 'delete_file']) {
    const out = JSON.parse(await call(name, { path: 'x.js', content: 'y', old_string: 'a', new_string: 'b' }, { subAgent: true }))
    assert.equal(out.success, false, `${name} 必须被拒`)
    assert.equal(out.blocked, true)
    assert.match(out.error, /只读/)
  }
})

test('执行层对 ctx.subAgent 的 execute_command 只放行只读命令', async () => {
  executed.length = 0
  // 放行
  const okOut = JSON.parse(await call('execute_command', { command: 'git log --oneline -5' }, { subAgent: true }))
  assert.equal(okOut.success, true, '只读命令应放行')
  assert.deepEqual(executed, ['git log --oneline -5'])

  // 拒绝（且**不能真的执行**）
  const badOut = JSON.parse(await call('execute_command', { command: 'rm -rf build' }, { subAgent: true }))
  assert.equal(badOut.success, false)
  assert.equal(badOut.blocked, true)
  assert.deepEqual(executed, ['git log --oneline -5'], '被拒的命令绝不能落到 executeCommand')
})

test('不误伤主 Agent：ctx 无 subAgent 时写类工具与任意命令照常放行', async () => {
  executed.length = 0
  const w = JSON.parse(await call('write_file', { path: 'x.js', content: 'y' }, {}))
  assert.equal(w.success, true, '主 Agent 的写盘不受只读策略影响')

  const c = JSON.parse(await call('execute_command', { command: 'npm test' }, { convId: 'c1' }))
  assert.equal(c.success, true, '主 Agent 的命令不受只读白名单限制')
  assert.deepEqual(executed, ['npm test'])
})
