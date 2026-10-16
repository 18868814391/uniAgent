// ============================================================
//  agents-md —— 项目级上下文（AGENTS.md）自动注入
//
//  背景：opencode（packages/core/src/instruction-context.ts）会从当前目录向上查找
//  AGENTS.md 并注入系统提示词，让 AI 进任何仓库都自动懂该项目的约定。
//  localAi 此前**完全没有**这个机制 —— 而 your-frontend / your-frontend / your-frontend
//  三个仓库里都已经写好 AGENTS.md（项目结构、ht-table 用法、参考页路径），
//  AI 却一个字都读不到，只能凭通用知识瞎写。这是「改代码能力差」的首要原因。
//
//  这里做同一件事：从「本轮用户消息提到的路径」+「最近工具碰过的路径」推断当前项目，
//  把该项目沿路径上的 AGENTS.md 注入系统提示词。
//
//  ⚠️ 性能约定（务必遵守，参见 tools/search.js 头部关于主进程阻塞 163 秒的教训）：
//  本模块只做**精确路径**的 existsSync / statSync / readFileSync（向上找 .git 至多 20 层），
//  绝不做目录递归遍历。新增逻辑时不要破坏这个约束。
// ============================================================
const path = require('path')
const fs = require('fs')

// 最近碰过的路径环形缓冲长度：只为推断「当前在哪个项目」，几条足够
const TOUCH_LIMIT = 12
// 向上查找 .git / AGENTS.md 的最大层数（没有仓库时防止一路走到盘根）
const MAX_UP_LEVELS = 20
// 单个 AGENTS.md 的读取上限：防止误读超大文件拖慢主进程
const MAX_AGENTS_MD_BYTES = 32 * 1024
// 注入总字符上限：AGENTS.md 可能很长（opencode 自己的有 161 行），超出截断并标注
const MAX_TOTAL_CHARS = 24 * 1024
// AGENTS.md 内容缓存：key=文件绝对路径 → { content, mtimeMs }
const fileCache = new Map()

let touched = []

function isAbsolutePath(p) {
  return typeof p === 'string' && p.length > 0 && path.isAbsolute(p)
}

/** 记录一次「工具碰过的路径」，用于推断当前项目。 */
function recordPathTouched(p) {
  if (!isAbsolutePath(p)) return
  const idx = touched.indexOf(p)
  if (idx !== -1) touched.splice(idx, 1) // 已有 → 挪到队尾（保持「最近」语义）
  touched.push(p)
  if (touched.length > TOUCH_LIMIT) touched = touched.slice(-TOUCH_LIMIT)
}

/** 清空推断状态（切换角色时调用，避免跨项目串味）。 */
function reset() {
  touched = []
}

/** 最近碰过的路径副本（给调用方只读用）。 */
function recentPaths() {
  return [...touched]
}

/** 路径不存在时，按有没有扩展名猜它是文件还是目录。 */
function startDirFor(p) {
  try {
    return fs.statSync(p).isDirectory() ? p : path.dirname(p)
  } catch {
    return path.extname(p) ? path.dirname(p) : p
  }
}

/** 从某个路径向上找最近的 git 仓库根；找不到返回 null。 */
function findRepoRoot(p) {
  let dir = startDirFor(p)
  for (let i = 0; i < MAX_UP_LEVELS; i++) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir
    } catch {
      return null
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * 收集某个路径所属项目的 AGENTS.md。
 * 规则对齐 opencode：从「该路径所在目录」一路向上收集到**仓库根**，
 * 返回顺序为「远 → 近」（仓库级约定在前、子目录约定在后，后者更具体）。
 * 找不到 git 仓库时退化为「只看该路径所在目录」，不向上瞎找。
 */
function collectAgentsMd(p) {
  const repoRoot = findRepoRoot(p)
  const found = []
  let dir = startDirFor(p)
  for (let i = 0; i < MAX_UP_LEVELS; i++) {
    const candidate = path.join(dir, 'AGENTS.md')
    try {
      if (fs.existsSync(candidate)) found.push(candidate)
    } catch {
      // 权限等异常一律忽略，不影响主流程
    }
    if (!repoRoot) break // 无仓库 → 只看当前目录
    if (dir === repoRoot) break // 已到仓库根
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { repoRoot, files: found.reverse() }
}

/** 读 AGENTS.md，带 mtime 缓存；读不到（不存在 / 超限 / 权限）返回 null。 */
function readCached(filePath) {
  try {
    const st = fs.statSync(filePath)
    if (!st.isFile() || st.size > MAX_AGENTS_MD_BYTES) return null
    const cached = fileCache.get(filePath)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.content
    const content = fs.readFileSync(filePath, 'utf-8')
    fileCache.set(filePath, { content, mtimeMs: st.mtimeMs })
    return content
  } catch {
    return null
  }
}

// 从自由文本里提取 Windows 绝对路径（C:\xx 或 D:/xx）。
// 排除引号与中英文标点，避免把后续句子一起吞进来。
const WIN_PATH_RE = /[A-Za-z]:[\\/][^\s"'<>|*?：；，。、（）【】《》]+/g

/** 从用户消息里提取绝对路径（用户常直接粘贴路径或说「改 D:\xx\yy」）。 */
function extractPathsFromMessages(userMessages) {
  const out = []
  for (const m of userMessages || []) {
    const text = typeof m === 'string' ? m : String((m && m.content) || '')
    if (!text) continue
    const hits = text.match(WIN_PATH_RE)
    if (hits) out.push(...hits)
  }
  return out
}

/**
 * 按优先级排出「可能是当前项目」的候选路径：
 *   1) 本轮用户消息里提到的绝对路径 —— 最强信号，用户刚说了要动哪个项目
 *   2) 最近工具碰过的路径 —— 上一轮 / 同一个大任务里积累下来的
 */
function candidatePaths(userMessages) {
  const seen = new Set()
  const out = []
  const push = (p) => {
    if (!isAbsolutePath(p) || seen.has(p)) return
    seen.add(p)
    out.push(p)
  }
  extractPathsFromMessages(userMessages).forEach(push)
  // touched 队尾是最新碰过的，从后往前即为「最近优先」
  for (let i = touched.length - 1; i >= 0; i--) push(touched[i])
  return out
}

/**
 * 构建「项目级上下文」注入段。
 * 命中第一个能推出 AGENTS.md 的项目即返回 —— 不混多个仓库的约定（互相矛盾反而有害）。
 * 推断不到任何项目时返回空串，调用方直接跳过，零开销。
 */
function buildProjectContext(userMessages = []) {
  const seenFiles = new Set()
  const picked = []
  let matchedRoot = ''
  let chars = 0

  for (const candidate of candidatePaths(userMessages)) {
    const { repoRoot, files } = collectAgentsMd(candidate)
    const fresh = files.filter((f) => !seenFiles.has(f))
    if (fresh.length === 0) continue

    const loaded = []
    for (const f of fresh) {
      const content = readCached(f)
      if (content && content.trim()) loaded.push({ file: f, content })
    }
    if (loaded.length === 0) continue

    matchedRoot = repoRoot || startDirFor(candidate)
    for (const item of loaded) {
      seenFiles.add(item.file)
      if (chars + item.content.length > MAX_TOTAL_CHARS) {
        const remain = MAX_TOTAL_CHARS - chars
        if (remain < 200) break
        picked.push({ file: item.file, content: `${item.content.slice(0, remain)}\n\n…（内容过长已截断）` })
        chars = MAX_TOTAL_CHARS
        break
      }
      picked.push(item)
      chars += item.content.length
    }
    break // 一个项目就够
  }

  if (picked.length === 0) return ''
  const body = picked.map((s) => `<项目约定 from="${s.file}">\n${s.content.trim()}\n</项目约定>`).join('\n\n')
  return `\n\n【项目级上下文 — 已自动读取该项目的 AGENTS.md，必须优先遵守】
当前项目根目录：${matchedRoot}
以下内容来自项目仓库自带的约定文档，**比你的通用知识更准确**。改这个项目的代码前先按它说的做：用什么组件、参考哪个页面、跑什么命令、有哪些禁忌。若它与你的默认习惯冲突，一律以它为准。
${body}`
}

module.exports = { recordPathTouched, reset, recentPaths, buildProjectContext, findRepoRoot, collectAgentsMd }
