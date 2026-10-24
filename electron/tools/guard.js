// ============================================================
//  tools/guard —— 开发角色的操作守卫（2026-09-28 新增）
//
//  需求（syf 原话）：改代码时，如果动的是**项目下的文件**就不用问 —— 项目都用
//  git 管理，问题不大；只有改**系统级文件**、或**可能造成系统异常**的操
//  作，才需要问。
//
//  所以这里只回答一个问题：「这次工具调用要不要打断用户？」
//  返回三档：
//    allow   —— 直接干。git 仓库内的写/改/删（且该文件干净、删了能恢复）
//    confirm —— 弹原生确认框，用户点「确定」才执行
//    block   —— 不执行、也不给确认机会（毁机级命令，比如 rm -rf /）
//
//  路径分级（classifyPath）：
//    critical —— 系统目录 / 盘根 / 用户主目录本身 / 主目录下的敏感配置
//                （.ssh、.npmrc、.gitconfig …）→ 一律 confirm
//    project  —— 位于某个 git 仓库内 → 免问（delete 还要额外看该文件是否干净）
//    loose    —— 既不是系统级、也不在任何 git 仓库内（桌面散装文件之类）
//                → 删除/覆盖 confirm（没有版本控制兜底，丢了就真丢了）
//
//  「AI 自己写出来的文件」是一条例外（2026-10-10 加）：那份东西本来就不存在过，
//  是 AI 用 write_file / edit_file / 重定向写出来的草稿（校验脚本、临时产物…），
//  删它 / 覆盖它并不是在丢用户的资产 —— 记账见 tools/ai-created.js。
//  一旦文件被外部改过（mtime/size 对不上），账就失效，回到原来的确认逻辑。
//
//  ⚠️ 本模块**只在开发角色下被 chat.js 调用**。其它角色走授权目录白名单，
//    行为完全不变（它们本来也写不到授权目录外面去）。
//
//  ⚠️ 顶层不要 require('electron')：单测（tests/dev-guard.test.js）在纯 node
//    下 require 本模块，require electron 会直接抛。弹框函数内部惰性取。
// ============================================================
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')
// 同目录、只依赖 fs/path 的小模块（不是「项目内模块」），不会带来循环依赖
const aiCreated = require('./ai-created')

const IS_WIN = process.platform === 'win32'

const ALLOW = { action: 'allow' }

// ------------------------------------------------------------
//  路径工具
// ------------------------------------------------------------
function normPath(p) {
  let r = path.resolve(String(p || ''))
  if (IS_WIN) r = r.toLowerCase()
  const trimmed = r.replace(/[\\/]+$/, '')
  // 盘根（c:）/ 根（/）去尾分隔符后不能变空串
  return trimmed || r
}

// ------------------------------------------------------------
//  系统级路径
// ------------------------------------------------------------
function criticalPrefixRoots() {
  const out = []
  if (IS_WIN) {
    out.push(
      process.env.windir || 'C:\\Windows',
      process.env.ProgramFiles || 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      process.env.ProgramData || 'C:\\ProgramData',
      'C:\\$Recycle.Bin',
      'C:\\System Volume Information',
      'C:\\Recovery',
      'C:\\Boot',
      'C:\\EFI',
      'C:\\PerfLogs',
      'C:\\inetpub',
      'C:\\MSOCache',
      'C:\\Users\\Public',
      'C:\\Users\\Default',
    )
    // %APPDATA% / %LOCALAPPDATA% 不在这里 —— 它们的判定要排除 Local\\Temp
    // （见 isCriticalPath）。临时目录是工具和用户都会随手写的地方，不是系统配置。
  } else {
    out.push(
      '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev',
      '/proc', '/sys', '/var', '/opt', '/root', '/System', '/Library',
      '/Applications', '/private', '/Volumes', '/cores',
    )
  }
  return out.filter(Boolean).map(normPath)
}

// 只做「等于」判定：盘根、用户主目录本身、C:\Users 本身。
// 注意**不能**把用户主目录当前缀 —— 桌面上的项目就在主目录下，那正是要放行的。
function criticalExactRoots() {
  const out = []
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (home) {
    out.push(home)
    out.push(path.dirname(home)) // C:\Users 本身
  }
  if (IS_WIN) {
    out.push((process.env.SystemDrive || 'C:') + '\\')
  } else {
    out.push('/')
  }
  return out.filter(Boolean).map(normPath)
}

// 主目录下的敏感文件：改坏了会影响本机一大票工具（ssh / npm / git / shell 启动）
const SENSITIVE_HOME_ENTRIES = new Set([
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.npmrc', '.yarnrc',
  '.gitconfig', '.git-credentials', '.netrc', '.condarc', '.pypirc',
  '.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc',
  '.zprofile', '.zshenv', '.zshenv', '.vimrc', '.tmux.conf',
])
const SENSITIVE_ABS_PATHS = [
  '/etc/hosts', '/etc/hostname', '/etc/resolv.conf', '/etc/passwd', '/etc/sudoers',
]

function isSensitivePath(p) {
  const t = normPath(p)
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (home) {
    const h = normPath(home)
    if (t.startsWith(h + path.sep)) {
      const first = t.slice(h.length + 1).split(path.sep)[0]
      if (SENSITIVE_HOME_ENTRIES.has(first)) return true
    }
  }
  for (const s of SENSITIVE_ABS_PATHS) if (t === normPath(s)) return true
  // Windows 的 hosts 文件
  if (IS_WIN && /[\\/]system32[\\/]drivers[\\/]etc([\\/]|$)/i.test(t)) return true
  return false
}

function insideOrEqual(target, root) {
  const t = normPath(target)
  const r = normPath(root)
  if (!t || !r) return false
  return t === r || t.startsWith(r + path.sep)
}

function isCriticalPath(p) {
  const t = normPath(p)
  // 临时目录先放行（macOS 的 os.tmpdir() 在 /var/folders 下，会被 /var 前缀误伤）
  if (!IS_WIN && (insideOrEqual(t, '/tmp') || t.startsWith('/var/folders' + path.sep))) return false
  if (criticalExactRoots().includes(t)) return true
  for (const root of criticalPrefixRoots()) {
    if (t === root || t.startsWith(root + path.sep)) return true
  }
  // 应用数据目录：%APPDATA%\<app> 里装着本应用的 settings / 会话 / 技能库，
  // 改坏了应用直接异常 —— 整体算系统级。
  if (process.env.APPDATA && insideOrEqual(t, process.env.APPDATA)) return true
  if (process.env.LOCALAPPDATA && insideOrEqual(t, process.env.LOCALAPPDATA)) {
    // 例外：Local\Temp 下都是用完即弃的临时文件（os.tmpdir() 就指这里），
    // 把它算成系统级会让"在临时目录里跑脚本"这种常规操作处处弹框。
    const tempDir = path.join(process.env.LOCALAPPDATA, 'Temp')
    if (!insideOrEqual(t, tempDir)) return true
  }
  return isSensitivePath(t)
}

// ------------------------------------------------------------
//  git 仓库判定
//  向上找 .git（目录或文件 —— worktree / submodule 下 .git 是文件）。
//  结果做 30s TTL 缓存：工具循环里同一目录会被反复问，逐次 stat 没必要；
//  但也不能永久缓存 —— AI 刚 `git init` 完就该立刻按项目对待。
// ------------------------------------------------------------
const GIT_ROOT_TTL_MS = 30_000
const GIT_ROOT_CACHE = new Map() // dir(lowercased) → { root: string|null, at: number }

function findGitRoot(startPath) {
  if (!startPath) return null
  let dir
  try {
    const resolved = path.resolve(String(startPath))
    dir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
      ? resolved
      : path.dirname(resolved)
  } catch {
    return null
  }
  const cacheKey = IS_WIN ? dir.toLowerCase() : dir
  const cached = GIT_ROOT_CACHE.get(cacheKey)
  if (cached && Date.now() - cached.at < GIT_ROOT_TTL_MS) return cached.root

  let cur = dir
  let found = null
  for (let i = 0; i < 24; i++) {
    try {
      if (fs.existsSync(path.join(cur, '.git'))) { found = cur; break }
    } catch { break }
    const parent = path.dirname(cur)
    if (!parent || parent === cur) break
    cur = parent
  }
  if (GIT_ROOT_CACHE.size > 500) GIT_ROOT_CACHE.clear()
  GIT_ROOT_CACHE.set(cacheKey, { root: found, at: Date.now() })
  return found
}

function runGit(gitRoot, args) {
  return execFileSync('git', ['-C', gitRoot, ...args], {
    encoding: 'utf-8',
    timeout: 6000,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
}

/**
 * 文件在所属 git 仓库里的状态。
 *  'clean'     已跟踪且无未提交改动 —— 删了能 git checkout 回来
 *  'dirty'     已跟踪但有未提交改动 —— 删了改动就没了
 *  'untracked' 从未提交过 —— 删了彻底没了
 *  'unknown'   判定失败（没有 git、超时、路径异常）→ 调用方按保守处理
 */
function gitFileState(file, gitRoot) {
  try {
    const rel = path.relative(gitRoot, path.resolve(String(file)))
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return 'unknown'
    try {
      runGit(gitRoot, ['ls-files', '--error-unmatch', '--', rel])
    } catch {
      return 'untracked'
    }
    const out = runGit(gitRoot, ['status', '--porcelain', '--', rel])
    return out.trim() ? 'dirty' : 'clean'
  } catch {
    return 'unknown'
  }
}

// ------------------------------------------------------------
//  路径分级（对外主入口）
// ------------------------------------------------------------
function classifyPath(target) {
  const resolved = path.resolve(String(target || ''))
  if (isCriticalPath(resolved)) {
    return { tier: 'critical', gitRoot: null, reason: '位于系统目录 / 盘根 / 用户敏感配置范围' }
  }
  const gitRoot = findGitRoot(resolved)
  if (gitRoot) return { tier: 'project', gitRoot, reason: `git 仓库：${gitRoot}` }
  return { tier: 'loose', gitRoot: null, reason: '不在任何 git 仓库内' }
}

// ------------------------------------------------------------
//  命令判定
// ------------------------------------------------------------

// 会把整台机器搞坏的命令：不给确认机会，直接拒。
const BLOCK_RULES = [
  [/\bmkfs(\.[a-z0-9]+)?\b/i, '格式化文件系统（mkfs）'],
  [/\bformat\s+[a-z]:/i, '格式化磁盘（format）'],
  [/\bdiskpart\b/i, '磁盘分区操作（diskpart）'],
  [/\b(parted|fdisk)\b/i, '磁盘分区操作'],
  [/\bdd\b[^|;&\n]*\bof=\/dev\//i, '裸写磁盘设备（dd of=/dev/…）'],
  [/\bbcdedit\b/i, '修改启动配置（bcdedit）'],
  [/\bvssadmin\s+delete\b/i, '删除卷影副本（vssadmin delete）'],
  [/\bwbadmin\s+delete\b/i, '删除系统备份（wbadmin delete）'],
  [/\breg\s+(add|delete|import)\s+["']?(hklm|hkey_local_machine)/i, '修改注册表 HKLM'],
  [/\b(shutdown|reboot|poweroff|halt)\b/i, '关机 / 重启'],
  [/\b(restart-computer|stop-computer)\b/i, '关机 / 重启'],
  [/\bsfc\s+\//i, '系统文件修复（sfc）'],
  [/\bchkdsk\b[^|;&\n]*\/f/i, '磁盘检查并修复（chkdsk /f）'],
  [/\bcipher\s+\/w/i, '擦除磁盘空闲空间（cipher /w）'],
  [/\bnet\s+user\b[^|;&\n]*\/delete/i, '删除系统账户（net user /delete）'],
  [/\bnet\s+localgroup\b/i, '修改本机用户组'],
  [/\bchmod\s+-R\s+777\s+\/(\s|$)/i, '递归开放根目录权限'],
  [/\bchown\s+-R\b[^|;&\n]*\s\/(\s|$)/i, '递归修改根目录属主'],
]

// 需要用户点头的命令：都会丢「git 兜不住的东西」（未提交改动 / 未跟踪文件）
// 或改动系统级环境（全局包、注册表、环境变量、网络、服务、计划任务）。
const CONFIRM_RULES = [
  [/\bgit\b[^|;&\n]*\breset\b[^|;&\n]*--hard/i, 'git reset --hard 会丢弃所有未提交改动（git 救不回来）'],
  [/\bgit\b[^|;&\n]*\bcheckout\b[^|;&\n]*\s--\s/i, 'git checkout -- 会丢弃该文件的未提交改动'],
  [/\bgit\b[^|;&\n]*\bcheckout\s+\.(\s|$)/i, 'git checkout . 会丢弃所有未提交改动'],
  [/\bgit\b[^|;&\n]*\bclean\b[^|;&\n]*\s-\w*[fdx]/i, 'git clean 会删除未跟踪文件（git 无法恢复）'],
  [/\bgit\b[^|;&\n]*\bpush\b[^|;&\n]*(\s-f\b|--force)/i, 'git push --force 会覆盖远端提交历史'],
  [/\bgit\b[^|;&\n]*\bpush\b[^|;&\n]*--delete\b/i, 'git push --delete 会删除远端分支'],
  [/\bgit\b[^|;&\n]*\bbranch\b[^|;&\n]*\s-D\b/i, 'git branch -D 强制删除分支（不合并检查）'],
  [/\bgit\b[^|;&\n]*\brebase\b/i, 'git rebase 会重写提交历史'],
  [/\bgit\b[^|;&\n]*\bstash\b[^|;&\n]*\b(drop|clear)\b/i, 'git stash drop / clear 会丢弃暂存内容'],
  [/\bgit\b[^|;&\n]*\bfilter-branch\b/i, 'git filter-branch 会重写整个历史'],
  [/\bgit\b[^|;&\n]*\bupdate-ref\s+-d\b/i, 'git update-ref -d 会删除引用'],
  [/\bgit\b[^|;&\n]*\bgc\b[^|;&\n]*--prune=now/i, 'git gc --prune=now 会立即清理不可达对象'],
  [/\bgit\b[^|;&\n]*\bworktree\b[^|;&\n]*\bremove\b/i, 'git worktree remove 会删除工作树'],
  [/\bgit\b[^|;&\n]*\bconfig\b[^|;&\n]*--global\b/i, 'git config --global 会改本机所有仓库的全局配置'],
  [/\bgit\b[^|;&\n]*\bsubmodule\b[^|;&\n]*\bdeinit\b/i, 'git submodule deinit 会清空子模块工作区'],
  [/\brmdir\s+\/s/i, '递归删除目录'],
  [/\bdel\s+\/[a-z]*s/i, '递归删除文件'],
  [/\bremove-item\b[^|;&\n]*-recurse/i, '递归删除目录'],
  [/\bfind\b[^|;&\n]*\s-delete\b/i, 'find -delete 批量删除'],
  [/\bfind\b[^|;&\n]*-exec\s+rm\b/i, 'find -exec rm 批量删除'],
  [/\brobocopy\b[^|;&\n]*\/mir\b/i, 'robocopy /MIR 会删除目标目录里的多余文件'],
  [/\bchmod\s+-R\b/i, '递归修改文件权限'],
  [/\b(npm|pnpm)\s+(i|install|add)\b[^|;&\n]*\s(-g|--global)\b/i, '全局安装 npm 包（改动本机环境）'],
  [/\b(npm|pnpm|yarn)\b[^|;&\n]*\s(-g|--global)\b/i, '全局包操作（改动本机环境）'],
  [/\byarn\s+global\b/i, '全局安装 yarn 包（改动本机环境）'],
  [/\b(apt|apt-get|yum|dnf|pacman|zypper|apk)\s+(install|remove|purge|upgrade|dist-upgrade|autoremove)\b/i, '系统包管理操作（改动本机环境）'],
  [/\b(choco|scoop|winget)\s+(install|uninstall|upgrade|remove)\b/i, '系统包管理操作（改动本机环境）'],
  [/\bbrew\s+(install|uninstall|upgrade|remove)\b/i, '系统包管理操作（改动本机环境）'],
  [/\bsetx\b/i, '写入用户环境变量'],
  [/\breg\s+(add|delete|import)\b/i, '修改注册表'],
  [/\bsetenvironmentvariable\b/i, '修改环境变量'],
  [/\bnetsh\b/i, '修改网络配置'],
  [/\bsc\s+(config|create|delete|stop|start)\b/i, '修改 Windows 服务'],
  [/\bschtasks\b[^|;&\n]*\/(create|delete|change)/i, '修改计划任务'],
]

// 按 shell 的连接符把命令切成子命令，逐段判定（取最严重的结论）
function splitSubCommands(cmd) {
  return String(cmd || '')
    .split(/&&|\|\||;|\n|\|/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// 只认「以 rm 开头」的子命令段（可带 sudo 前缀）。
// 不这么做的话，`git commit -m "fix: rm -rf 的误用"` 这类纯文本也会被判成删除命令。
function rmSegments(cmd) {
  return splitSubCommands(cmd).filter((seg) => /^(sudo\s+)?rm(\s|$)/.test(seg))
}

function rmArgs(seg) {
  const body = seg.replace(/^(sudo\s+)?rm\b\s*/, '')
  // 引号里的空格不能当参数分隔符：`rm -rf "my dir"` 是「一个目标」，
  // 按空白硬切会得到 -rf / "my / dir" 三个参数，路径就解析歪了。
  return (body.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) =>
    (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
      ? t.slice(1, -1)
      : t,
  )
}

// 「递归删除根 / 家目录」是唯一一类"不给商量"的 rm
function rmHitsRoot(cmd) {
  for (const seg of rmSegments(cmd)) {
    const args = rmArgs(seg)
    const flags = args.filter((a) => a.startsWith('-')).join('')
    const targets = args.filter((a) => !a.startsWith('-')).map((a) => a.replace(/^['"]|['"]$/g, ''))
    const recursive = /[rR]/.test(flags)
    for (const t of targets) {
      const rootLike =
        /^\/\*?$/.test(t) ||
        /^\/\*\.\*$/.test(t) ||
        /^~\/?\*?$/.test(t) ||
        /^\$HOME\/?\*?$/.test(t) ||
        /^\$\{HOME\}\/?\*?$/.test(t) ||
        /^[a-z]:[\\/]?\*?$/i.test(t) ||
        /^\/[a-z](\/|\*)?$/i.test(t) ||      // /c、/c/、/c/*
        /^\/mnt\/[a-z]\/?\*?$/i.test(t)       // /mnt/c
      if (rootLike) return t
    }
    // 不带参数、或只带 -r 的裸 rm
    if (recursive && targets.length === 0) return '（未指定目标）'
  }
  return null
}

// rm 递归 / 通配 —— 一次删一片，且必然连带未跟踪文件
function rmIsSweeping(cmd) {
  for (const seg of rmSegments(cmd)) {
    const args = rmArgs(seg)
    const flags = args.filter((a) => a.startsWith('-')).join('')
    const targets = args.filter((a) => !a.startsWith('-'))
    if (/[rR]/.test(flags)) return true
    if (targets.some((t) => /[*?]/.test(t))) return true
  }
  return false
}

// ------------------------------------------------------------
//  rm 豁免：删掉的全是 AI 自己刚写出来的草稿（2026-10-11）
//
//  与文件类工具那条路径（evaluateToolCall 里的 aiCreated.isAiAuthored）对齐 ——
//  「AI 造的草稿不是用户的资产，删它不值得打断用户」。记账见 tools/ai-created.js。
//
//  只在这一种形状下成立（其余一律退回确认框）：
//    每个 rm 段都带 -r/-R、没有通配符、目标全是字面量路径，
//    逐个解析出来都是磁盘上真实存在的目录，且目录树内每个文件都在记账表上。
// ------------------------------------------------------------

// `cd <dir> && rm -rf x` —— 命令里的 cd 会改变后续子命令的工作目录，
// 不跟踪它就会把相对路径解析到错误的位置（<home>\x 而不是 <dir>\x）。
function cdTarget(seg) {
  const m = /^cd\s+(?:--\s+)?(.+)$/.exec(seg)
  if (!m) return null
  return m[1].trim().replace(/^["']|["']$/g, '') || null
}

// 命令由 Git Bash 执行，`/c/Users/...` 这种 MSYS 路径 Node 的 path 不认，手工转一次
function msysPath(p) {
  if (!IS_WIN) return p
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p)
  if (m) return m[1].toUpperCase() + ':' + (m[2] || '/')
  return p
}

function unquotePath(t) {
  const s = String(t || '')
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  return s
}

// 调用方（rmPathsAreAiDrafts）给的参数已经由 rmArgs 去掉过引号，这里只处理
// MSYS 路径与 ~ 展开。
function resolveCommandPath(raw, cwd) {
  let t = msysPath(unquotePath(String(raw || '')))
  if (!t) return ''
  if (t === '~') t = os.homedir()
  else if (/^~[\\/]/.test(t)) t = path.join(os.homedir(), t.slice(2))
  if (path.isAbsolute(t) || /^[a-zA-Z]:/.test(t)) return path.resolve(t)
  return path.resolve(cwd, t)
}

// shell.js 实际用 cwd: os.homedir() 起 bash，但 AI 的命令通常自带 `cd <项目>`。
// 以命令里第一个能落地的 cd 目标为基准 —— 判错只会导致多弹一次框（保守侧）。
function baseCwdForCommand(cmd) {
  for (const seg of splitSubCommands(cmd)) {
    const cd = cdTarget(seg)
    if (!cd) continue
    const r = resolveCommandPath(cd, os.homedir())
    try {
      if (r && fs.existsSync(r) && fs.statSync(r).isDirectory()) return r
    } catch { /* 认不出来就试下一个 */ }
  }
  return os.homedir()
}

function rmPathsAreAiDrafts(cmd) {
  const segs = rmSegments(cmd)
  if (!segs.length) return false
  const baseCwd = baseCwdForCommand(cmd)
  for (const seg of segs) {
    const args = rmArgs(seg)
    const flags = args.filter((a) => a.startsWith('-')).join('')
    if (!/[rR]/.test(flags)) return false
    const targets = args.filter((a) => !a.startsWith('-'))
    if (!targets.length) return false
    for (const t of targets) {
      if (/[$*?`!]/.test(t)) return false // 变量 / 通配 → 看不出真实目标
      const abs = resolveCommandPath(t, baseCwd)
      if (!abs) return false
      let st
      try { st = fs.statSync(abs) } catch { return false }
      if (!st.isDirectory()) return false
      if (!aiCreated.isAiDraftTree(abs)) return false
    }
  }
  return true
}

/**
 * 命令分级。返回 { action: 'allow'|'confirm'|'block', reason, detail }
 */
function classifyCommand(command) {
  const cmd = String(command || '')
  if (!cmd.trim()) return { ...ALLOW }

  const rootTarget = rmHitsRoot(cmd)
  if (rootTarget) {
    return {
      action: 'block',
      reason: `递归删除根目录或用户主目录（rm ... ${rootTarget}）`,
      detail: '这类命令会直接摧毁整台机器的工作环境，本应用不执行、也不提供"确认执行"入口。',
    }
  }
  for (const [re, reason] of BLOCK_RULES) {
    if (re.test(cmd)) {
      return {
        action: 'block',
        reason,
        detail: '这类命令可能造成系统级损坏，本应用不执行。如确需操作，请由你手动执行。',
      }
    }
  }

  if (rmIsSweeping(cmd)) {
    // 豁免：删的整批都是 AI 自己刚写出来的草稿（记账见 tools/ai-created.js）——
    // 与 delete_file 那条路径对齐，`rm -rf .tmpchk`（里面只有 AI 写的校验脚本）
    // 不值得打断用户。任何一项认不出来就照旧弹框。
    if (rmPathsAreAiDrafts(cmd)) return { ...ALLOW }
    return {
      action: 'confirm',
      reason: '递归 / 通配删除：会一次删掉一批文件，其中往往包含未提交、未被 git 跟踪的内容（删了无法恢复）',
      detail: `命令：${cmd}`,
    }
  }
  for (const [re, reason] of CONFIRM_RULES) {
    if (re.test(cmd)) {
      return { action: 'confirm', reason, detail: `命令：${cmd}` }
    }
  }
  return { ...ALLOW }
}

// ------------------------------------------------------------
//  工具调用分级（文件类 + execute_command）
// ------------------------------------------------------------
function confirmFor(reason, detail) {
  return { action: 'confirm', reason, detail }
}

function evaluateToolCall(name, args) {
  const a = args && typeof args === 'object' ? args : {}
  const target = a.path ? String(a.path) : ''

  if (name === 'execute_command') {
    return classifyCommand(a.command)
  }

  if (!target) return { ...ALLOW }

  // 传了路径但文件本身不存在、且是写类工具 → 只是新建，不破坏任何东西
  // （系统级路径仍然要问：往 C:\Windows 里塞新文件同样是系统级改动）
  const exists = (() => {
    try { return fs.existsSync(path.resolve(target)) } catch { return false }
  })()

  if (name === 'write_file') {
    const info = classifyPath(target)
    if (info.tier === 'critical') {
      return confirmFor(`写入系统级路径（${info.reason}）`, `目标：${path.resolve(target)}`)
    }
    if (!exists) return { ...ALLOW }
    if (info.tier === 'project') return { ...ALLOW }
    // AI 自己写出来的文件（写完之后没人动过）→ 覆盖它不是「改坏用户的东西」
    if (aiCreated.isAiAuthored(target)) return { ...ALLOW }
    return confirmFor(
      '覆盖一个不在 git 仓库内的已有文件（改坏了无法用 git 恢复）',
      `目标：${path.resolve(target)}`,
    )
  }

  if (name === 'edit_file') {
    const info = classifyPath(target)
    if (info.tier === 'critical') {
      return confirmFor(`修改系统级文件（${info.reason}）`, `目标：${path.resolve(target)}`)
    }
    // 项目内、以及散装文件：精准 str_replace 改动范围小，不打扰用户
    return { ...ALLOW }
  }

  if (name === 'delete_file') {
    const info = classifyPath(target)
    if (info.tier === 'critical') {
      return confirmFor(`删除系统级文件（${info.reason}）`, `目标：${path.resolve(target)}`)
    }
    // AI 自己写出来的文件（写完之后没人动过）→ 删掉它不构成「丢用户的东西」：
    // 那份内容本来就是 AI 这一轮造出来的草稿，重跑一次还能再生成。
    // 用户手工改过、或 git checkout 拉回旧版本 → stat 对不上，账失效 → 走下面的原逻辑。
    if (aiCreated.isAiAuthored(target)) return { ...ALLOW }
    if (info.tier === 'project') {
      // 项目内的文件也不是全都救得回来：未提交 / 未跟踪的内容，git 里根本没有
      const state = gitFileState(target, info.gitRoot)
      if (state === 'clean') return { ...ALLOW }
      if (state === 'dirty') {
        return confirmFor(
          '该文件在 git 仓库里有未提交的改动，删除后这些改动无法恢复',
          `目标：${path.resolve(target)}`,
        )
      }
      if (state === 'untracked') {
        return confirmFor(
          '该文件从未提交到 git，删除后无法恢复',
          `目标：${path.resolve(target)}`,
        )
      }
      return confirmFor(
        '无法确认该文件在 git 里的状态（git 不可用或路径异常），按保守处理',
        `目标：${path.resolve(target)}`,
      )
    }
    return confirmFor(
      '删除一个不在 git 仓库内的文件（删了无法用 git 恢复）',
      `目标：${path.resolve(target)}`,
    )
  }

  return { ...ALLOW }
}

// ------------------------------------------------------------
//  确认框（惰性 require electron —— 单测不会被拖下水）
//
//  审批结果是**闭合的四值枚举**，只有 ALLOWED_ONCE 放行（fail-closed）：
//    allowed-once —— 用户明确点了「执行」。仅此一档批准本次调用。
//    rejected     —— 用户点了「取消」（明确拒绝）。
//    cancelled    —— 对话框被系统 / 关窗打断，没拿到用户应答。
//    unavailable  —— 压根没法弹框（主窗口已销毁 / dialog 不可用 / 抛异常）。
//
//  改这里之前的两处旧行为，都是"把没拿到应答当成没批准之外的东西"：
//    · 旧实现返回 boolean，`res.response === 1`，其它一切（含默认按钮、关窗）直接折成 false；
//    · `win` 为 null 时会退化成一个**没有父窗口**的对话框继续弹。
//  第二种尤其危险：主窗口已销毁时那个框可能根本不可见，工具循环却在那里等一个永远不会
//  到来的点击；而第一种让「关窗 / 系统中断」和「用户说不」在模型眼里长得一模一样，
//  它只能猜，猜错就再试一次 —— 那正是审批最不该出现的行为。
// ------------------------------------------------------------
const APPROVAL = Object.freeze({
  ALLOWED_ONCE: 'allowed-once',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  UNAVAILABLE: 'unavailable',
})

function approval(status, reason = '') {
  return { status, allowed: status === APPROVAL.ALLOWED_ONCE, reason }
}

/** 只有 allowed-once 算批准；传 boolean 也接受（旧调用方兼容），其余一律不批。 */
function isApproved(decision) {
  if (decision === true) return true
  return !!decision && decision.status === APPROVAL.ALLOWED_ONCE
}

/** 把未获批准的状态翻译成喂回模型的一句话：让它知道该改做法，而不是原样重试。 */
function approvalMessage(decision) {
  const status = decision && decision.status
  const why = (decision && decision.reason) ? `（${decision.reason}）` : ''
  if (status === APPROVAL.REJECTED) {
    return `用户明确取消了该操作${why}。请换用更安全、范围更小的做法，不要原样重试。`
  }
  if (status === APPROVAL.CANCELLED) {
    return `确认框被关闭，没有拿到用户的应答${why}。按「未获批准」处理：不要假设已授权，也不要原样重试；`
      + '请先说明你要做什么、为什么需要它，再让用户决定。'
  }
  if (status === APPROVAL.UNAVAILABLE) {
    return `无法向用户请求确认${why}。按「未获批准」处理：不要执行该操作。`
      + '可以改为在项目内、可逆的小范围做法，或让用户自己执行这一步。'
  }
  return '该操作未获用户批准。'
}

async function confirmWithDialog(win, info) {
  let dialog
  try {
    ;({ dialog } = require('electron'))
  } catch (e) {
    return approval(APPROVAL.UNAVAILABLE, `无法加载 electron dialog：${e && e.message}`)
  }
  if (!dialog || typeof dialog.showMessageBox !== 'function') {
    return approval(APPROVAL.UNAVAILABLE, 'dialog.showMessageBox 不可用')
  }
  // 没有父窗口就不弹：那个框可能根本不可见，而工具循环会在这里无限等待
  const parent = win && typeof win.isDestroyed === 'function' && !win.isDestroyed() ? win : null
  if (!parent) return approval(APPROVAL.UNAVAILABLE, '主窗口已销毁，无法弹出确认框')

  const options = {
    type: 'warning',
    buttons: ['取消', '执行'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: 'AI 请求执行可能影响系统的操作',
    detail: `原因：${info.reason}\n\n${info.detail || ''}\n\n是否允许？`,
    title: '操作确认',
  }
  let res
  try {
    res = await dialog.showMessageBox(parent, options)
  } catch (e) {
    // 主窗口在弹框途中被销毁 / 对话框被系统收回：没拿到应答，按未获批准处理
    return approval(APPROVAL.CANCELLED, `确认框异常结束：${e && e.message}`)
  } finally {
    // 关窗后强制恢复焦点，否则渲染进程后续的 .focus() 会失灵
    try { parent.focus(); parent.webContents.focus() } catch { /* 窗口可能已销毁 */ }
  }
  if (!res || typeof res.response !== 'number') {
    return approval(APPROVAL.CANCELLED, '没有拿到对话框的应答')
  }
  if (res.response === 1) return approval(APPROVAL.ALLOWED_ONCE)
  return approval(APPROVAL.REJECTED, `用户点击了「取消」（按钮索引 ${res.response}）`)
}

module.exports = {
  classifyPath,
  classifyCommand,
  evaluateToolCall,
  confirmWithDialog,
  // 审批结果（闭合枚举）：只有 allowed-once 放行，见 confirmWithDialog 上方注释
  APPROVAL,
  isApproved,
  approvalMessage,
  // 细分函数导出，供测试直接断言
  isCriticalPath,
  isSensitivePath,
  findGitRoot,
  gitFileState,
  normPath,
}
