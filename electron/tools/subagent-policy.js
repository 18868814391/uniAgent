// ============================================================
//  subagent-policy —— 子代理的「只读」策略（执行层硬约束）
// ------------------------------------------------------------
//  背景（2026-10-04 第三轮评估）：
//  子代理原先只靠提示词里的「只读原则，不要创建/修改/删除任何文件」来约束，
//  而它实际拿到了 write_file / edit_file / delete_file / write_skill / write_memory /
//  execute_command 全套写能力，且**完全不经过 tools/guard.js**（guard 只在 chat.js 的
//  主循环里对 dev 角色调用）。dev 角色下 fs-safe 的 isPathAllowed 又是直接放行 ——
//  于是「派个子代理去调研 XX」理论上可以变成「无确认框、无守卫、无记录的任意写盘 + 任意命令」。
//
//  提示词是软约束，这里把它变成硬约束：两道
//    ① BLOCKED：这些工具对子代理完全不下发，且执行层再拒一次（防文本形态调用还原绕过）；
//    ② execute_command 只放行「不可能产生副作用」的只读命令。
//
//  子代理的定位是「只读调研」（主 Agent 才负责改代码），所以收紧不会损失正常用法：
//  结构靠 list_directory / glob_files，内容靠 grep_code / read_file。
// ============================================================

// 子代理不可用的工具。
//   · spawn/get_sub_agent_results —— 防递归派生
//   · ask_user                   —— 子代理不能挂起等用户（主 Agent 会陪着一起等）
//   · update_todos               —— 子代理沿用主会话 convId，写清单会覆盖主 Agent 的清单
//   · write_file/edit_file/delete_file —— 子代理只读，不得改盘（2026-10-04 补）
//   · write_skill/write_memory   —— 同样是写盘（落到 skill/memory 目录），一并禁（2026-10-04 补）
const BLOCKED_TOOLS = new Set([
  'spawn_sub_agent',
  'get_sub_agent_results',
  'ask_user',
  'update_todos',
  'write_file',
  'edit_file',
  'delete_file',
  'write_skill',
  'write_memory',
])

// 只读命令白名单：这些命令**没有任何「原地写盘 / 指定输出文件」的开关**，
// 因此无论带什么参数都只会读。
// 刻意不收进来的（都能写，靠文本规则判断风险太高，一律拒绝）：
//   find（-delete / -exec）、sed（-i）、awk（重定向）、sort（-o）、uniq（第二个参数是输出文件）、
//   cp/mv/rm/tee/touch/mkdir/chmod/…（本身就是写操作）。
const READONLY_BINARIES = new Set([
  'ls', 'dir', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo',
  'which', 'where', 'basename', 'dirname', 'realpath',
  'stat', 'file', 'du', 'df', 'tree',
  'grep', 'rg', 'jq', 'diff', 'cmp',
  'md5sum', 'sha1sum', 'shasum',
])

// git：只放行纯读的子命令。写/改历史的（checkout/reset/clean/push/commit/add/
// stash/apply/merge/rebase/fetch/pull/config/remote/branch 带副作用的写法…）一律不给。
const GIT_READONLY_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list',
  'describe', 'blame', 'cat-file', 'grep', 'shortlog', 'symbolic-ref', 'name-rev',
  'whatchanged', 'reflog',
])

// 解释器 / 构建器：只能问版本，别的形态一律拒绝。
// （`node -e "fs.writeFileSync(...)"` 就是典型的「一个命令改全盘」）
const VERSION_ONLY_BINARIES = {
  node: [/^-v$/, /^--version$/],
  npm: [/^-v$/, /^--version$/],
  python: [/^--version$/, /^-V$/],
  python3: [/^--version$/, /^-V$/],
  py: [/^--version$/, /^-V$/, /^-3\s+--version$/],
  java: [/^-version$/, /^--version$/],
  mvn: [/^-v$/, /^--version$/],
  pycel: [/^--version$/],
}

// 会让「只读命令」变质的 shell 元字符：重定向、管道（| tee / | xargs rm）、
// 命令串联、命令替换、后台执行。命中即拒 —— 宁可少放行几条，也不留一条写路径。
// 注：这也顺带拦掉了 grep 的正则选择符 `|`；子代理检索本来就用 grep_code 工具，不影响正常用法。
const FORBIDDEN_SHELL_TOKENS = [';', '&', '|', '>', '<', '`', '$', '\n', '\r']

const DENY_MSG = '子代理是只读的，不允许修改文件或执行会改变状态的命令。'
  + '请改用 list_directory / glob_files / grep_code / read_file 完成调研；'
  + '确需落盘的改动请把它作为结论交回主 Agent。'

/**
 * 子代理的 execute_command 是否放行。
 * @param {string} command 原始命令串
 * @returns {{ok: boolean, reason?: string}}
 */
function checkSubAgentCommand(command) {
  const raw = String(command || '').trim()
  if (!raw) return { ok: false, reason: '命令为空。' }

  for (const tok of FORBIDDEN_SHELL_TOKENS) {
    if (raw.includes(tok)) {
      return {
        ok: false,
        reason: `只读模式下不允许使用 shell 元字符「${tok === '\n' ? '\\n' : tok}」（重定向/管道/串联/命令替换都会启用写路径）。`
          + '请改用单个只读命令，或直接用 grep_code / read_file 工具。',
      }
    }
  }

  const tokens = raw.split(/\s+/).filter(Boolean)
  // 取命令名（去掉路径，/usr/bin/ls → ls），Windows 下反斜杠同样处理
  const bin = tokens[0].replace(/\\/g, '/').split('/').pop().toLowerCase()

  if (VERSION_ONLY_BINARIES[bin]) {
    const rest = tokens.slice(1).join(' ')
    if (VERSION_ONLY_BINARIES[bin].some((re) => re.test(rest))) return { ok: true }
    return {
      ok: false,
      reason: `只读模式下 \`${bin}\` 仅允许查看版本（如 \`${bin} --version\`）。`,
    }
  }

  if (bin === 'git') {
    const sub = (tokens[1] || '').toLowerCase()
    if (!sub) return { ok: false, reason: '只读模式下 git 必须带子命令，例如 `git log`。' }
    if (!GIT_READONLY_SUBCOMMANDS.has(sub)) {
      return {
        ok: false,
        reason: `只读模式下不允许 \`git ${sub}\`（只放行 ${[...GIT_READONLY_SUBCOMMANDS].join(' / ')}）。`,
      }
    }
    return { ok: true }
  }

  if (READONLY_BINARIES.has(bin)) return { ok: true }

  return {
    ok: false,
    reason: `只读模式下不允许执行 \`${bin}\`。允许的：${[...READONLY_BINARIES].join(' / ')}、`
      + `git 的只读子命令（${[...GIT_READONLY_SUBCOMMANDS].slice(0, 6).join('/')}…）、以及 node/python 的 --version。`,
  }
}

/**
 * 子代理执行某个工具前的统一准入检查（执行层第二道，与工具下发过滤互为兜底）。
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function checkSubAgentToolCall(name, args) {
  if (BLOCKED_TOOLS.has(name)) {
    return { ok: false, error: `${DENY_MSG}（${name} 对子代理不可用）` }
  }
  if (name === 'execute_command') {
    const res = checkSubAgentCommand(args && args.command)
    if (!res.ok) return { ok: false, error: `${DENY_MSG}${res.reason || ''}` }
  }
  return { ok: true }
}

module.exports = {
  BLOCKED_TOOLS,
  READONLY_BINARIES,
  GIT_READONLY_SUBCOMMANDS,
  VERSION_ONLY_BINARIES,
  checkSubAgentCommand,
  checkSubAgentToolCall,
}
