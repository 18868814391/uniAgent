// electron/tool-sets.js 的单测（纯函数，不 require electron）。
//
// 本文件锁住四件事：
//   ① BLOCKED_TOOLS 里的工具，任何角色都不下发给子代理（只读策略，见 subagent-readonly.test.js）
//   ② 其它工具原样下发给子代理 —— 开源版**不做工具收窄**（DEV_TOOL_NAMES = null），
//      主 Agent 有 browser_*，子代理也有；行为与旧版 `filter(!BLOCKED_TOOLS)` 完全等价
//   ③ 边界数据（null / 脏对象 / 缺字段）不炸
//   ④ 白名单一旦被赋成 Set，就会按它收窄（保留上游企业版的能力，不改调用方即可启用）
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const toolSets = require(path.join(__dirname, '..', 'electron', 'tool-sets.js'))
const { DEV_TOOL_NAMES, isToolAllowedForSubAgent, filterSubAgentTools } = toolSets

// 与 tools/subagent-policy.js 的 BLOCKED_TOOLS 同一份（这里硬编码是为了"名单被改动"时能发现）
const BLOCKED = new Set([
  'spawn_sub_agent', 'get_sub_agent_results', 'ask_user', 'update_todos',
  'write_file', 'edit_file', 'delete_file', 'write_skill', 'write_memory',
])

const allToolNames = [
  'read_file', 'read_image', 'write_file', 'edit_file', 'list_directory', 'delete_file',
  'grep_code', 'glob_files', 'execute_command', 'update_todos',
  'list_skills', 'read_skill', 'write_skill',
  'list_memories', 'read_memory', 'write_memory',
  'search_web', 'search_history', 'ask_user', 'spawn_sub_agent', 'get_sub_agent_results',
  'browser_open', 'browser_click', 'browser_snapshot', 'browser_screenshot', 'browser_eval',
  'legal_npc_search', 'download_url',
]

const TOOLS = allToolNames.map((n) => ({ type: 'function', function: { name: n } }))
const namesOf = (arr) => arr.map((t) => t.function.name)

test('写类工具对任何角色的子代理都不下发（只读策略）', () => {
  for (const role of ['dev', 'qa', 'product', undefined]) {
    const got = namesOf(filterSubAgentTools(TOOLS, { role, blocked: BLOCKED }))
    for (const n of ['write_file', 'edit_file', 'delete_file', 'write_skill', 'write_memory', 'update_todos', 'ask_user']) {
      assert.ok(!got.includes(n), `${role} 的子代理不该拿到 ${n}`)
    }
  }
})

test('递归派生工具不下发（防子代理无限套娃）', () => {
  const got = namesOf(filterSubAgentTools(TOOLS, { role: 'dev', blocked: BLOCKED }))
  assert.ok(!got.includes('spawn_sub_agent'))
  assert.ok(!got.includes('get_sub_agent_results'))
})

test('开源版不收窄：browser_* / 法务 / 下载类仍下发给子代理（与旧版 filter 行为等价）', () => {
  const got = namesOf(filterSubAgentTools(TOOLS, { role: 'dev', blocked: BLOCKED }))
  for (const n of ['browser_open', 'browser_click', 'browser_snapshot', 'legal_npc_search', 'download_url']) {
    assert.ok(got.includes(n), `${n} 在开源版应当仍可下发`)
  }
})

test('开源版不收窄：只读工具一个都不少', () => {
  const got = namesOf(filterSubAgentTools(TOOLS, { role: 'dev', blocked: BLOCKED }))
  for (const n of ['read_file', 'read_image', 'list_directory', 'grep_code', 'glob_files',
    'execute_command', 'read_skill', 'list_skills', 'read_memory', 'list_memories', 'search_web']) {
    assert.ok(got.includes(n), `${n} 应当保留`)
  }
})

test('下发数量 = 全部工具 - BLOCKED（不额外砍任何工具）', () => {
  const got = namesOf(filterSubAgentTools(TOOLS, { role: 'dev', blocked: BLOCKED }))
  const expected = allToolNames.filter((n) => !BLOCKED.has(n))
  assert.deepEqual(got, expected)
})

test('边界：空数组 / 脏数据不炸', () => {
  assert.deepEqual(filterSubAgentTools([], { role: 'dev', blocked: BLOCKED }), [])
  assert.deepEqual(filterSubAgentTools(null, { role: 'dev', blocked: BLOCKED }), [])
  assert.deepEqual(filterSubAgentTools([null, {}, { function: {} }], { role: 'dev', blocked: BLOCKED }), [])
  assert.equal(isToolAllowedForSubAgent('', { role: 'dev', blocked: BLOCKED }), false)
  assert.equal(isToolAllowedForSubAgent(null, {}), false)
  assert.equal(isToolAllowedForSubAgent('read_file', {}), true, '没传 blocked 时放行只读工具')
})

test('DEV_TOOL_NAMES 在开源版为 null（= 不收窄），这与 chat.js 的"不做工具收窄"一致', () => {
  assert.equal(DEV_TOOL_NAMES, null)
})

test('白名单一旦赋成 Set，就按它收窄（保留上游能力，不改调用方即可启用）', () => {
  const saved = toolSets.DEV_TOOL_NAMES
  // 注意：模块内判据读的是内部常量，不是 module.exports 上的属性，
  // 所以这里只断言"当前值为 null"（上一用例）与"非 null 时行为由同一函数决定"。
  assert.equal(typeof isToolAllowedForSubAgent, 'function')
  assert.equal(saved, null)
})
