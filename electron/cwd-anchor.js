// ============================================================
//  cwd-anchor —— 开发角色的「当前工作目录」锚点（2026-10-24）
//
//  解决的问题（P0-6）：
//  以前 `execute_command` 每次都以 `os.homedir()` 起 bash，`grep_code` / `glob_files`
//  不传 path 时默认第一个授权目录 —— 三个入口各自为政，模型只能靠「每条命令先 cd」
//  和「每次检索都写全路径」硬扛。dev-conventions 第 5 节整节都在给这件事打补丁，
//  而补丁本身（漏写 cd、cd 到错目录）就是路径错误的头号来源。
//  Claude Code 的做法是把 cwd 当会话状态维护（`BashTool/prompt.ts:357`
//  "The working directory persists between commands"），跑完用 `pwd -P` 回写。
//
//  本模块就是这个状态。**只对 dev 生效**：
//  其它角色的命令执行与检索保持原样（homedir / 第一个授权目录），
//  以免改了行为却没人验证 —— 它们的路径都在授权白名单里，本来就不需要锚点。
//
//  ⚠️ 不 require('electron')：单测在纯 node 下 require 本模块。
// ============================================================
const os = require('os')
const state = require('./state')

/** 锚点是否启用（当前角色是 dev）。 */
function isActive() {
  return !!(state.settings && state.settings.role === 'dev')
}

/** 取锚点目录；未设置或非 dev 角色 → 退回用户主目录（= 旧行为）。 */
function get() {
  if (isActive() && typeof state.devCwd === 'string' && state.devCwd) return state.devCwd
  return os.homedir()
}

/**
 * 只在真的设置过锚点时返回它，否则 null。
 * 用于「默认值」场景（如 grep_code 不传 path）：null 表示调用方该走自己的旧逻辑。
 */
function peek() {
  if (isActive() && typeof state.devCwd === 'string' && state.devCwd) return state.devCwd
  return null
}

/** 记录锚点。非 dev 角色不记（免得切角色后带着上一个角色的目录乱跑）。 */
function set(dir) {
  if (!isActive()) return
  if (typeof dir !== 'string' || !dir.trim()) return
  state.devCwd = dir
}

/** 清空（切角色 / 用户手动重置时调用）。 */
function reset() {
  state.devCwd = null
}

module.exports = { isActive, get, peek, set, reset }
