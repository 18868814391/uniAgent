// ============================================================
//  tools/search —— 代码搜索（grep_code）+ 文件查找（glob_files）
//  在授权目录白名单内递归搜索文件内容和文件路径，复用 fs-safe.isPathAllowed 做安全校验。
//
//  ⚠️ 性能硬约定（2026-09-20 修「AI 查后端代码时整个界面卡死」）：
//  旧实现全程 fs.readdirSync + fs.readFileSync，且默认目录是「第一个授权目录」。
//  实测：AI 未传 path 时同步遍历整个授权目录（27k 文件 / 280MB，含 3~4 份代码仓库），
//  阻塞 Electron 主进程 **163 秒** —— 表现为主进程收不到窗口消息，整窗「未响应」
//  （最大化按钮变灰、鼠标转圈）；扫到条目上限被截断后模型换词重扫，于是反复卡。
//  现在：全异步 IO + 分批让出事件循环（setImmediate）+ 时间/条目双预算 + 跳过二进制与大文件。
//  **任何**新增的递归扫描都必须遵守同一约定：不得在主线程做无让路的同步遍历。
// ============================================================
const path = require('path')
const fs = require('fs')
const state = require('../state')
const { isPathAllowed } = require('./fs-safe')

// 递归遍历时跳过的目录（构建产物 / 依赖 / 缓存不值得搜）
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'dist-electron', 'release',
  '__pycache__', '.vscode', '.idea', '.cache', 'asar',
  '.local-ai', '.electron-builder',
  // 新增：Java/前端构建产物与日志（体积大、几乎不可能是检索目标）
  'target', 'build', 'out', 'coverage', 'logs', '.gradle', '.next', '.nuxt', '.turbo',
])

// 未指定 include 时按扩展名跳过的二进制文件：读它们纯属浪费 IO，
// 而且 UTF-8 解码会产出巨量乱码行，既慢又可能产生假命中。
// 注意：只跳过「明确不是文本」的类型，.svg/.md/.json 等文本格式不在此列。
const BINARY_EXT = new Set([
  // 位图 / 设计稿
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tif', '.tiff', '.psd', '.ai', '.sketch',
  // 压缩包 / 二进制产物
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war', '.ear',
  '.class', '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite', '.pdb',
  // 字体
  '.ttf', '.ttc', '.otf', '.woff', '.woff2', '.eot', '.fon',
  // 音视频
  '.mp3', '.wav', '.flac', '.aac', '.ogg', '.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm',
  // Office 二进制（xlsx/docx/pptx 是 zip 容器，搜文本没意义）
  '.xls', '.xlsx', '.xlsm', '.doc', '.docx', '.ppt', '.pptx', '.vsd', '.vsdx', '.pdf',
])

// 单文件读取上限：超过就跳过（超大日志/生成文件读进来只会拖慢并且挤掉真正的代码命中）
const MAX_SCAN_FILE_BYTES = 1.5 * 1024 * 1024
// 单次检索的墙上时钟预算。超时立刻收尾并如实上报「结果不完整」，
// 保证再糟的调用也只会等这么久（旧实现无预算，实测单次 163 秒）。
const GREP_BUDGET_MS = 15000
const GLOB_BUDGET_MS = 8000
// 遍历条目上限（目录项计数）：防超大树拖死；达上限如实上报截断
const SCAN_ENTRY_LIMIT = 20000
// 并发读文件数（Node 线程池做实际读取）+ 每批之后让出事件循环，主进程保持可响应
const READ_CONCURRENCY = 8
// 进度播报最小间隔（毫秒），避免高频 IPC
const PROGRESS_EVERY_MS = 700
// 单行片段最大长度
const SNIPPET_LEN = 200

// 把 glob 模式转成正则源码。转义顺序很关键：
//   **/ → (?:.*/)?   可匹配 0 层目录 —— 否则 **/*.docx 永远匹配不到搜索目录根下的 .docx（根文件相对路径没有 /）
//   **  → .*
//   *   → [^/]*
//   ?   → [^/]
//   .   → \.（字面点号转义）
function globToRegExpSource(pattern) {
  return String(pattern)
    .replace(/\*\*\//g, '@@GS_SLASH@@')
    .replace(/\*\*/g, '@@GS@@')
    .replace(/\?/g, '@@QM@@')
    .replace(/\./g, '\\.')
    .replace(/\*/g, '[^/]*')
    .replace(/@@GS_SLASH@@/g, '(?:.*/)?')
    .replace(/@@GS@@/g, '.*')
    .replace(/@@QM@@/g, '[^/]')
}

// include 过滤 glob（支持 "*.vue"、"**/*.ts"、"*.test.js" 等），用于 grep_code 的 include 参数
function matchesInclude(filename, includePattern) {
  if (!includePattern) return true
  return new RegExp('^' + globToRegExpSource(includePattern) + '$').test(filename)
}

// 简单 glob 模式匹配（支持 **、*、?），相对路径统一用 '/' 分隔
function matchesGlob(relativePath, pattern) {
  const rel = String(relativePath).replace(/\\/g, '/')
  return new RegExp('^' + globToRegExpSource(pattern) + '$', 'i').test(rel)
}

// 遍历状态：条目计数、条目上限、墙上时钟预算、截断原因、进度节流
function createScanCtx(budgetMs) {
  const now = Date.now()
  return {
    startedAt: now,
    deadline: now + budgetMs,
    entries: 0,
    filesScanned: 0,      // 真正读了内容的文件数
    filesSkipped: 0,      // 因二进制扩展名 / 体积 / 无权限跳过
    stopReason: '',       // 'hit_limit' | 'entry_limit' | 'budget'
    onProgress: null,
    lastProgressAt: 0,
  }
}

const isStopped = (ctx) => !!ctx.stopReason

// 把控制权交回事件循环：Electron 主进程只有定期让路才不会让窗口「未响应」
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve))

// 进度播报（节流）：渲染层用它把「检索中…」显示在输入框上方，避免"无反馈 = 像卡死"
function maybeProgress(ctx) {
  if (!ctx.onProgress) return
  const now = Date.now()
  if (now - ctx.lastProgressAt < PROGRESS_EVERY_MS) return
  ctx.lastProgressAt = now
  const secs = Math.max(1, Math.round((now - ctx.startedAt) / 1000))
  try {
    ctx.onProgress(`正在检索代码…已扫描 ${ctx.filesScanned} 个文件（${ctx.entries} 个目录项 / ${secs}s）`)
  } catch {
    // 渲染层已销毁时忽略
  }
}

// ============================================================
//  grepCode —— 在目录中搜索文件内容（正则/关键词）
//  异步 + 分批让路 + 预算；onProgress 可选，用于向渲染层播报进度。
// ============================================================
async function grepCode(args = {}, onProgress) {
  const { pattern, path: searchPath, include, max_results: maxResults = 30 } = args
  // 确定搜索目录
  let dir = searchPath
  if (!dir) {
    const allowed = state.settings.allowedDirs || []
    dir = allowed[0]
  }
  if (!dir) {
    return JSON.stringify({ success: false, error: '未指定搜索目录，且未配置授权目录。请在设置中添加授权目录，或在参数中指定 path。' })
  }
  const resolved = path.resolve(dir)
  if (!isPathAllowed(resolved)) {
    return JSON.stringify({ success: false, error: `Access denied: "${dir}" is not in the allowed directories list.` })
  }
  if (!fs.existsSync(resolved)) {
    return JSON.stringify({ success: false, error: `目录不存在: "${dir}"` })
  }

  // 编译搜索正则
  let regex
  try {
    regex = new RegExp(pattern, 'gi')
  } catch {
    // 不是合法正则 → 当普通关键词搜索
    const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    regex = new RegExp(escaped, 'gi')
  }

  const ctx = createScanCtx(GREP_BUDGET_MS)
  ctx.onProgress = typeof onProgress === 'function' ? onProgress : null
  const matches = []

  // 读一批文件并就地匹配。并发读 + 每批让路，主线程不会长时间独占。
  async function readBatch(files) {
    const loaded = await Promise.all(
      files.map(async (full) => {
        if (isStopped(ctx)) return null
        let st
        try {
          st = await fs.promises.stat(full)
        } catch {
          return null
        }
        if (!st.isFile() || st.size > MAX_SCAN_FILE_BYTES) {
          ctx.filesSkipped++
          return null
        }
        try {
          return { full, content: await fs.promises.readFile(full, 'utf-8') }
        } catch {
          return null // 权限不足 / 编码错误 / 二进制，跳过
        }
      })
    )
    for (const item of loaded) {
      if (isStopped(ctx)) return
      if (!item) continue
      ctx.filesScanned++
      // 兜底：拿到 NUL 字节说明是二进制（扩展名没覆盖到的情况）
      if (item.content.indexOf('\u0000') !== -1) {
        ctx.filesSkipped++
        continue
      }
      const lines = item.content.split('\n')
      const relPath = path.relative(resolved, item.full).replace(/\\/g, '/')
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0
        if (!regex.test(lines[i])) continue
        matches.push(`${relPath}:${i + 1}: ${lines[i].trim().slice(0, SNIPPET_LEN)}`)
        if (matches.length >= maxResults) {
          ctx.stopReason = 'hit_limit'
          return
        }
      }
    }
    maybeProgress(ctx)
  }

  // 迭代式遍历（显式栈），避免深递归；每层目录处理后让路一次
  const stack = [{ dir: resolved, rel: '' }]
  let batch = []
  while (stack.length > 0 && !isStopped(ctx)) {
    const { dir: curDir, rel } = stack.pop()
    let entries
    try {
      entries = await fs.promises.readdir(curDir, { withFileTypes: true })
    } catch {
      continue // 权限不足等静默跳过
    }
    for (const entry of entries) {
      if (isStopped(ctx)) break
      ctx.entries++
      if (ctx.entries > SCAN_ENTRY_LIMIT) {
        ctx.stopReason = 'entry_limit'
        break
      }
      const childRel = rel ? rel + '/' + entry.name : entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push({ dir: path.join(curDir, entry.name), rel: childRel })
      } else if (entry.isFile()) {
        // include 过滤（按文件名）在真正读内容前应用，减少无谓 IO
        if (!matchesInclude(entry.name, include)) continue
        // 没给 include 时，跳过明确是二进制的扩展名（给了 include 就以调用方的意图为准）
        if (!include && BINARY_EXT.has(path.extname(entry.name).toLowerCase())) {
          ctx.filesSkipped++
          continue
        }
        batch.push(path.join(curDir, entry.name))
        if (batch.length >= READ_CONCURRENCY) {
          const cur = batch
          batch = []
          await readBatch(cur)
        }
      }
      if (Date.now() > ctx.deadline) {
        ctx.stopReason = ctx.stopReason || 'budget'
        break
      }
    }
    if (batch.length && !isStopped(ctx)) {
      const cur = batch
      batch = []
      await readBatch(cur)
    }
    if (isStopped(ctx)) break
    if (Date.now() > ctx.deadline) {
      ctx.stopReason = 'budget'
      break
    }
    await yieldToLoop()
  }

  const elapsedMs = Date.now() - ctx.startedAt
  const incomplete =
    ctx.stopReason === 'budget' || ctx.stopReason === 'entry_limit' || matches.length >= maxResults

  // 未传 path 是最常见的"慢"来源：明确告诉模型该怎么缩小范围（比反复换关键词重扫划算）
  const scopeHint = searchPath
    ? ''
    : `⚠️ 本次未指定 path，已扫描第一个授权目录（${resolved}）下的全部内容，代价极高且易被截断。` +
      `请把 path 指向具体仓库/模块目录（如 <仓库>/your-backend-module），并尽量给 include（如 "*.java"、"*.xml"），可把耗时从十几秒降到 1~2 秒。`

  const reasonText =
    ctx.stopReason === 'budget'
      ? `（已达 ${Math.round(GREP_BUDGET_MS / 1000)}s 时间预算提前结束，结果**不完整**${scopeHint ? '。' : ''}）`
      : ctx.stopReason === 'entry_limit'
        ? `（已遍历到 ${SCAN_ENTRY_LIMIT} 个目录项上限，结果**不完整**）`
        : matches.length >= maxResults
          ? `（已达上限 ${maxResults}，可用 max_results 增大）`
          : ''

  const note =
    matches.length === 0
      ? `没有找到匹配结果，可尝试换一个关键词或放宽 include 过滤。` +
        (ctx.stopReason ? `注意：本次检索${reasonText}可能因此漏掉目标。` : '') +
        (scopeHint ? ` ${scopeHint}` : '')
      : `共找到 ${matches.length} 条匹配${reasonText}。` +
        (isStopped(ctx) || matches.length >= maxResults
          ? ` 递归遍历在 ${ctx.entries} 个目录项后中止，结果可能不完整——要精确找文件请用 glob_files 按文件名匹配，或缩小 path 范围。`
          : '') +
        (scopeHint ? ` ${scopeHint}` : '')

  return JSON.stringify({
    success: true,
    query: pattern,
    directory: resolved,
    matchCount: matches.length,
    results: matches,
    note,
    scan: {
      filesScanned: ctx.filesScanned,
      filesSkipped: ctx.filesSkipped,
      entriesScanned: ctx.entries,
      elapsedMs,
      ...(ctx.stopReason ? { stoppedBy: ctx.stopReason, incomplete: true } : {}),
    },
  })
}

// ============================================================
//  globFiles —— 在目录中按通配符模式查找文件
//  与 grepCode 同一套异步/预算/让路约定（只读目录项，不读文件内容，代价低得多）。
// ============================================================
async function globFiles(args = {}, onProgress) {
  let { pattern, path: searchPath, max_results: maxResults = 50 } = args
  let dir = searchPath
  if (!dir) {
    // 如果 pattern 本身包含目录前缀，拆分出目录和文件 glob
    const parts = String(pattern).replace(/\\/g, '/').split('/')
    // 找到第一个含通配符的部分，之前的是目录路径
    const dirParts = []
    let globStart = 0
    for (let i = 0; i < parts.length; i++) {
      if (/[*?]/.test(parts[i])) {
        globStart = i
        break
      }
      dirParts.push(parts[i])
    }
    if (dirParts.length > 0) {
      dir = dirParts.join('/')
    } else {
      const allowed = state.settings.allowedDirs || []
      dir = allowed[0]
    }
    // 如果有目录前缀，glob 模式去掉目录部分
    if (globStart > 0) {
      pattern = parts.slice(globStart).join('/')
    }
  }

  if (!dir) {
    return JSON.stringify({ success: false, error: '未指定搜索目录，且未配置授权目录。请在设置中添加授权目录，或在参数中指定 path。' })
  }
  const resolved = path.resolve(dir)
  if (!isPathAllowed(resolved)) {
    return JSON.stringify({ success: false, error: `Access denied: "${dir}" is not in the allowed directories list.` })
  }
  if (!fs.existsSync(resolved)) {
    return JSON.stringify({ success: false, error: `目录不存在: "${dir}"` })
  }

  // 边扫边按 glob 过滤：上限只约束"命中的文件"，目录里无关文件再多也不会截掉目标
  const ctx = createScanCtx(GLOB_BUDGET_MS)
  ctx.onProgress = typeof onProgress === 'function' ? onProgress : null
  const matched = []
  const stack = [{ dir: resolved, rel: '' }]
  while (stack.length > 0 && !isStopped(ctx)) {
    const { dir: curDir, rel } = stack.pop()
    let entries
    try {
      entries = await fs.promises.readdir(curDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (isStopped(ctx)) break
      ctx.entries++
      if (ctx.entries > SCAN_ENTRY_LIMIT) {
        ctx.stopReason = 'entry_limit'
        break
      }
      const childRel = rel ? rel + '/' + entry.name : entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push({ dir: path.join(curDir, entry.name), rel: childRel })
      } else if (entry.isFile()) {
        ctx.filesScanned++
        if (!matchesGlob(childRel, pattern)) continue
        matched.push(childRel)
        if (matched.length >= maxResults) {
          ctx.stopReason = 'hit_limit'
          break
        }
      }
      if (Date.now() > ctx.deadline) {
        ctx.stopReason = ctx.stopReason || 'budget'
        break
      }
    }
    if (isStopped(ctx)) break
    if (Date.now() > ctx.deadline) {
      ctx.stopReason = 'budget'
      break
    }
    maybeProgress(ctx)
    await yieldToLoop()
  }

  const elapsedMs = Date.now() - ctx.startedAt
  const reasonText =
    ctx.stopReason === 'budget'
      ? `（已达 ${Math.round(GLOB_BUDGET_MS / 1000)}s 时间预算提前结束，结果可能不完整，可缩小 path 范围或用 max_results 调整后重试。）`
      : ctx.stopReason === 'entry_limit'
        ? `（已遍历到 ${SCAN_ENTRY_LIMIT} 个目录项上限，结果可能不完整，可缩小 path 范围后重试。）`
        : ''

  return JSON.stringify({
    success: true,
    pattern,
    directory: resolved,
    matchCount: matched.length,
    results: matched,
    note:
      matched.length === 0
        ? `没有找到匹配的文件。若你确定文件存在于该目录：① 确认 pattern（**/*.xxx 已能匹配根目录文件）；② 用 list_directory 列出目录查看磁盘上的真实文件名/层级后再试。${reasonText}`
        : `共找到 ${matched.length} 个文件${matched.length >= maxResults ? `（已达上限 ${maxResults}，可用 max_results 增大）` : ''}。${reasonText}`,
    scan: {
      filesScanned: ctx.filesScanned,
      entriesScanned: ctx.entries,
      elapsedMs,
      ...(ctx.stopReason ? { stoppedBy: ctx.stopReason, incomplete: true } : {}),
    },
  })
}

module.exports = { grepCode, globFiles }
