// ============================================================
//  tools/fs-safe —— 安全文件读写 + 图片载荷 + 文件类 IPC
//  拥有:授权目录白名单判定、安全读写删列、图片降采样/base64 载荷、
//  以及 file / dialog / md-preview / openExternal / openPath 域的 IPC 注册。
//  共享可变状态读 state,目录解析复用 settings。
// ============================================================
const { ipcMain, dialog, BrowserWindow, nativeImage, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const state = require('../state')
const {
  HARNESS_ROOT,
  resolvePlaceholders,
  getProductOutputDir,
  getTestOutputDir,
  getExcelOutputDir,
  getLegalOutputDir,
  getBrowserDownloadsDir,
  getCommandOutputDir,
} = require('../settings')
const { hardenWindow } = require('../windows')
const aiCreated = require('./ai-created')

// ============================================================
//  「这份文件是 AI 写出来的」记账（tools/ai-created.js）
//  写盘后记一笔、删除后撤账；开发角色的操作守卫（tools/guard.js）据此
//  判定「删 / 覆盖 AI 自己的草稿」不用弹确认框。记账失败绝不影响写盘主流程。
// ============================================================
function noteAiWrite(file, isNew) {
  try {
    aiCreated.noteAiWrite(file, isNew)
  } catch {
    /* 记账是锦上添花：它挂了顶多退回「每次删除都确认」 */
  }
}

function forgetAiWrite(file) {
  try {
    aiCreated.forgetPath(file)
  } catch {
    /* 同上 */
  }
}

// ============================================================
//  File system helpers (with security: path must be allowed)
// ============================================================
function isPathAllowed(targetPath, forWrite = false) {
  // 开发角色：跳过授权目录白名单，允许访问电脑上的全部文件
  if (state.settings && state.settings.role === 'dev') return true
  const resolved = path.resolve(targetPath)
  // 用户通过"导入文件"附加的文件，直接授予读取权限（不要求位于 allowedDirs）
  if (state.attachedFilePaths.has(resolved)) return true
  const allowed = state.settings.allowedDirs || []
  // Always allow skillsDir, memoryDir and the per-role output dirs.
  // 产品角色 harness 仅在"读取"时自动允许（打包后在 asar 内是只读的，禁止写入）。
  const readOnly = forWrite ? [] : [HARNESS_ROOT]
  const autoAllowed = [
    state.settings.skillsDir,
    state.settings.memoryDir,
    getProductOutputDir(),
    getTestOutputDir(),
    getExcelOutputDir(),
    getLegalOutputDir(),
    getBrowserDownloadsDir(),
    // execute_command 超长输出的落盘目录：返回值只给头尾 + 路径，必须让 AI 能去 grep 完整日志
    getCommandOutputDir(),
    ...readOnly,
  ].filter(Boolean)
  const allAllowed = [...allowed, ...autoAllowed]
  // 严格子目录判定：前缀匹配会造成路径穿越（如授权 "work" 却放行 "workbench\xxx"）。
  // 必须要求目标路径等于目录、或以 "目录 + 路径分隔符" 开头；Windows 路径不区分大小写，比较前统一转小写。
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
  return allAllowed.some((dir) => {
    const d = path.resolve(dir)
    const r = norm(resolved)
    const dd = norm(d)
    return r === dd || r.startsWith(dd + path.sep)
  })
}

// ============================================================
//  文件未找到时的"近似候选"提示
//  动机：用户消息里的文件名常含全角括号【】、空格、版本号（如「【上半年运费分析】2026运费
//  明细含子公司 v2.xlsx」），AI 凭描述拼路径几乎必错，只能再列一次目录才能拿到真实文件名，
//  白白多一轮往返。这里在 File not found 时直接扫一遍授权目录给出候选，让 AI 一次自纠。
//  仅在"读取失败"这条慢路径上执行，并限制扫描规模，不影响正常读文件性能。
// ============================================================
// 扫描规模上限：这段是**同步**遍历（readdirSync），跑在主线程上，会直接冻结窗口。
// 实测授权目录里放了几份代码仓库时，20000 个条目的上限能让"读错路径"这一次调用卡住数秒；
// 6000 已足够给出有意义的候选，代价可控。（根治方案是与 tools/search.js 一样改成
// 异步 + 分批让路，但该函数被 readFileSafe / listDirSafe 这些同步 API 复用，改动面大，
// 故先用降上限止血。）
const SIMILAR_SCAN_MAX_FILES = 6000   // 扫描文件数上限，防止超大目录拖死
const SIMILAR_SCAN_MAX_DEPTH = 4       // 目录递归深度上限
const SIMILAR_SUGGESTIONS = 5          // 最多返回的候选数
const SIMILAR_MIN_SCORE = 50           // 低于该分不提示，避免噪声
// 跳过与业务文件无关的大目录（node_modules 之类扫描代价极高且不可能命中）
const SIMILAR_SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'coverage',
  '__pycache__', '.venv', 'venv', '.gradle', '.idea', '.vscode', '.cache',
  '.xl-work', '$RECYCLE.BIN', 'System Volume Information',
  // 构建产物 / 日志目录：Java(target) 与前端(.next) 侧体积大，不是用户要找的文件
  'target', 'logs', '.next', '.nuxt',
])

// 归一化：转小写、去掉全角/半角括号与引号、去掉所有空白与标点符号。
// 这样「2026运费明细含子公司 v2.xlsx」与「【上半年运费分析】2026运费明细含子公司 v2.xlsx」
// 才可能被判为相似。
function normalizeFileName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[（）()【】\[\]〔〕｛｝{}<>《》「」『』“”‘’"\'`~!@#$%^&*+=|\\:;,，。、；：？?！!·\-_—–\s/.]/g, '')
}

// 相似度打分（0~100，仅比较"去扩展名后的主名"）。高分 = 极可能是用户想找的那个文件。
function similarityScore(requested, candidate) {
  const strip = (n) => {
    const ext = path.extname(n)
    return ext ? n.slice(0, n.length - ext.length) : n
  }
  const a = normalizeFileName(strip(requested))
  const b = normalizeFileName(strip(candidate))
  if (!a || !b) return 0
  if (a === b) return 100
  if (b.startsWith(a) || a.startsWith(b)) return 92
  if (b.includes(a) || (a.length >= 4 && a.includes(b))) return 70
  // 字符集交占比：中文名缺字/多前缀（如少了「【上半年运费分析】」）时仍能命中
  const setA = new Set(a)
  const setB = new Set(b)
  let common = 0
  for (const ch of setA) if (setB.has(ch)) common++
  const ratio = common / Math.max(1, Math.min(setA.size, setB.size))
  return ratio >= 0.62 ? Math.round(ratio * 60) : 0
}

// 在 roots 下有限深/限量地收集文件（只读目录项，不 stat，控制开销）
function collectFilesUnder(roots, maxFiles) {
  const out = []
  const seen = new Set()
  const stack = []
  for (const r of roots) stack.push([r, 0])
  while (stack.length && out.length < maxFiles) {
    const [dir, depth] = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (out.length >= maxFiles) break
      if (e.isDirectory()) {
        if (depth + 1 < SIMILAR_SCAN_MAX_DEPTH && !e.name.startsWith('.') && !SIMILAR_SKIP_DIRS.has(e.name)) {
          stack.push([path.join(dir, e.name), depth + 1])
        }
        continue
      }
      if (!e.isFile()) continue
      const full = path.join(dir, e.name)
      const key = full.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ full, name: e.name })
    }
  }
  return out
}

// 收集 roots 下的目录（浅层，用于目录名拼错时的提示）
function collectDirsUnder(roots, maxDepth) {
  const out = []
  const seen = new Set()
  const stack = []
  for (const r of roots) {
    try {
      const rd = path.resolve(r)
      if (fs.existsSync(rd) && fs.statSync(rd).isDirectory()) stack.push([rd, 0])
    } catch { /* 忽略不可读目录 */ }
  }
  while (stack.length) {
    const [dir, depth] = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SIMILAR_SKIP_DIRS.has(e.name)) continue
      const full = path.join(dir, e.name)
      const key = full.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ full, name: e.name })
      if (depth + 1 < maxDepth) stack.push([full, depth + 1])
    }
  }
  return out
}

// 生成"未找到 + 候选"错误。roots 由调用方给出（已做过授权校验）。
function fileNotFoundError(filePath, resolved) {
  const base = path.basename(resolved)
  const reqExt = path.extname(base).toLowerCase()

  // 扫描起点：请求路径的父目录（若存在且在授权范围内）+ 全部授权目录
  const roots = []
  const parent = path.dirname(resolved)
  try {
    if (fs.existsSync(parent) && fs.statSync(parent).isDirectory() && isPathAllowed(parent)) {
      roots.push(parent)
    }
  } catch { /* 忽略：父目录不可读时直接跳过 */ }
  for (const d of state.settings.allowedDirs || []) {
    try {
      const rd = path.resolve(d)
      if (fs.existsSync(rd) && fs.statSync(rd).isDirectory() && !roots.includes(rd)) roots.push(rd)
    } catch { /* 忽略不可读目录 */ }
  }

  let candidates = []
  try {
    const files = collectFilesUnder(roots, SIMILAR_SCAN_MAX_FILES)
    candidates = files
      .map((f) => ({ ...f, score: similarityScore(base, f.name) }))
      .filter((f) => f.score >= SIMILAR_MIN_SCORE)
      .sort((x, y) => y.score - x.score || x.name.length - y.name.length)
    // 请求带扩展名时，优先保留同扩展名候选（避免拿 .py 去顶替 .xlsx）
    if (reqExt) {
      const sameExt = candidates.filter((c) => path.extname(c.name).toLowerCase() === reqExt)
      if (sameExt.length > 0) candidates = sameExt
    }
    candidates = candidates.slice(0, SIMILAR_SUGGESTIONS)
  } catch (err) {
    console.error('[fs-safe] similar-file scan failed:', err.message)
  }

  let msg = `File not found: "${filePath}"`
  if (candidates.length) {
    const list = candidates.map((c, i) => `  ${i + 1}. ${c.full}`).join('\n')
    msg += `\n\n未找到该文件。磁盘上这些文件看起来很像（请用其中的完整绝对路径重试，不要自己拼）：\n${list}`
  }
  msg += `\n\n提示：文件名含中文、全角括号【】、空格或版本号（v2 等）时，严禁按用户描述推测路径——`
  msg += `请先用 list_directory / glob_files 列出授权目录拿到磁盘上的真实文件名，再原样复制使用。`
  return new Error(msg)
}

function readFileSafe(filePath) {
  const resolved = path.resolve(filePath)
  if (!isPathAllowed(resolved)) {
    throw new Error(`Access denied: "${filePath}" is not in the allowed directories list.`)
  }
  if (!fs.existsSync(resolved)) {
    throw fileNotFoundError(filePath, resolved)
  }
  const stat = fs.statSync(resolved)
  if (stat.size > 10 * 1024 * 1024) {
    throw new Error(`File too large (max 10MB): "${filePath}"`)
  }
  // 图片必须短路：按 UTF-8 读二进制只会得到满屏乱码，而模型会把它当"文件内容"继续分析
  // （2026-10-05 真实事故：会话台账里 read_file 读一张 2880×1375 的 PNG，note 是
  //  「读取 423/1245 行」，模型因此得出"这张图读不出东西"，转而用 PowerShell OCR 折腾了一整轮）。
  // 这里给的是**可执行的下一步**，不是一句"不支持"。
  const imageMime = imageMimeForPath(resolved)
  if (imageMime) {
    throw new Error(
      `"${path.basename(resolved)}" 是图片文件（${imageMime}），不是文本 —— 按文本读只会得到乱码，故直接拒绝。\n`
      + `要看这张图的内容 → 用 read_image(path: "${resolved}")，它会把图作为图像发给视觉模型；\n`
      + `只需要文件名/大小/修改时间 → 用 list_directory。`
      + `（read_image 需要当前模型配置勾选「支持读图（多模态）」；未勾选时它会明确告诉你。）`,
    )
  }
  let content = fs.readFileSync(resolved, 'utf-8')
  // harness 物料库中的 {{TOKEN}} 占位符替换为真实路径，供 AI 读取约定时直接使用
  // 严格子目录判定（与 isPathAllowed 保持一致），避免兄弟目录被误判为 harness 内文件。
  const harnessRoot = path.resolve(HARNESS_ROOT)
  const normP = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
  if (normP(resolved) === normP(harnessRoot) || normP(resolved).startsWith(normP(harnessRoot) + path.sep)) {
    content = resolvePlaceholders(content)
  }
  return content
}

// 单次 read_file 的返回上限（2026-10-04 补；同日据实放宽，见下）。
// 背景：不传 offset/limit 时原来直接返回**整份文件**，唯一闸是 readFileSafe 的 10MB（≈250 万 token）——
// 一次调用就能把上下文窗口打爆，紧接着 chat.js 抛 API error 400，**整轮工作全部作废**。
//
// ⚠️ 上限**不能卡到正常源码文件**（2026-10-04 实测踩到的坑）：
// 初版定 2000 行，结果用户一个 1796 行的 Vue 页面在改造中加了几段代码就超限，
// `read_file` 变成「永远只给前 2000 行 + 让模型用 offset 续读」——
// 工具的产出摘要里连续 4 次「内容被截断」，模型在同一文件上反复读、反复试，
// 把轮次烧在"追文件"上（真实会话台账 `userData/conversations/<id>.activity.json` 可查）。
// 上限的目的是拦住「一次读 2MB 把窗口打爆」这种事故，不是管住 2000 行的正常文件。
// 所以按**真正的成本指标（字符数 ≈ token）**来卡，行数上限只作兜底（防病态的「10 万行单字符」）：
const READ_MAX_LINES = 8000        // 兜底：防病态超多行（正常源码文件不会碰到）
const READ_MAX_CHARS = 128 * 1024  // 真正的闸：约 4 万 token（ASCII），足以一次读完大页面

/**
 * Read file with optional line range (for the read_file tool).
 * 返回：整份文件且未超限 → 裸字符串（与原行为完全一致）；
 * 传了 offset/limit、或内容超限 → { content, totalLines, offset, limit, truncated, nextOffset?, note? }。
 */
function readFileWithRange(filePath, offset, limit) {
  const content = readFileSafe(filePath)
  const lines = content.split('\n')
  const totalLines = lines.length
  const hasOffset = typeof offset === 'number' && offset > 0
  const hasLimit = typeof limit === 'number' && limit > 0

  const start = hasOffset ? offset - 1 : 0
  // 越界必须报错：旧实现返回「空内容 + truncated:false」，模型会据此认为「文件到此为止」。
  if (start >= totalLines) {
    throw new Error(`offset ${offset} 越界：文件共 ${totalLines} 行。请用 1..${totalLines} 之间的 offset，或省略 offset 从头读。`)
  }

  const requestedEnd = hasLimit ? start + limit : totalLines
  // 三重限制取最紧：调用方要的终点 / 行数上限 / 字符上限
  const hardEnd = Math.min(requestedEnd, totalLines, start + READ_MAX_LINES)
  let end = start
  let chars = 0
  for (let i = start; i < hardEnd; i++) {
    const add = lines[i].length + (i > start ? 1 : 0) // 还原本行占的换行符
    // 至少保留一行：单行超长（minified / 压缩 JSON）时也必须给出内容 ——
    // 否则会返回「空内容 + truncated」，模型以为文件是空的，甚至陷入「续读还是空」的死循环。
    if (i > start && chars + add > READ_MAX_CHARS) break
    chars += add
    end = i + 1
  }

  let sliced = lines.slice(start, end).join('\n')
  // 单行本身就超字符上限（压缩过的产物文件）→ 按字符硬切，并如实说明「这一行没读完」
  let lineTruncated = false
  if (sliced.length > READ_MAX_CHARS) {
    sliced = sliced.slice(0, READ_MAX_CHARS)
    lineTruncated = true
  }

  const truncated = end < totalLines || lineTruncated

  // 整份文件、未超限、调用方也没要分段 → 与旧行为逐字节一致（裸字符串）
  if (!hasOffset && !hasLimit && !truncated) return content

  const result = {
    content: sliced,
    totalLines,
    offset: start + 1,
    limit: end - start,
    truncated,
  }
  if (lineTruncated) {
    result.lineTruncated = true
    result.note = `本文件有超长单行，已按 ${READ_MAX_CHARS} 字符硬截断，该行剩余内容无法用 offset 续读。`
      + '建议改用 grep_code 检索关键片段。'
  } else if (truncated) {
    result.nextOffset = end + 1
    result.note = `内容已截断：本次只返回第 ${start + 1}-${end} 行（全文共 ${totalLines} 行；`
      + `单次上限 ${READ_MAX_LINES} 行 / ${READ_MAX_CHARS} 字符）。`
      + `请用 offset=${end + 1} 继续读取剩余部分，不要改用更小的 limit 反复试探。`
  }
  return result
}

// ============================================================
//  改动差异回显（buildDiff）—— 让模型「看见」自己刚写下的内容
//  背景：edit_file / write_file 改完只回 {path, size}，模型不知道自己到底把什么
//  写进了文件 —— 括号不配对、缩进错位、替换到了错误位置这类错误它自己发现不了，
//  只能再 read_file 复查一遍，白烧一轮往返（工具结果还会占上下文）。
//  这里在写盘后回一段 unified diff，让它每轮都能自查；不成立时返回 null（不添噪声）。
//
//  两条硬约束：
//  1) **必须有长度上限**：edit_file 允许整文件替换（10MB），原样回 diff 能烧掉几万
//     tokens。所以变更行只带 ±CONTEXT 行上下文，且总行数超DIFF_MAX_LINES 就折叠。
//  2) **按行尾无关比较**：判定变更用 stripCr 后的行（Windows 仓库 CRLF 极常见），
//     但**输出沿用新文本自己的行尾风格**（trimEnd 掉 CR），避免 diff 里混进 ^M。
// ============================================================
const DIFF_CONTEXT = 3      // 变更行上下各带几行
const DIFF_MAX_LINES = 80   // diff 文本总行数上限，超出折叠
const DIFF_MAX_HUNKS = 12   // hunk（独立变更块）数量上限，超出折叠

// 按行求最长公共子序列，返回 [{type, text}] 序列。
//
// 关键顺序：**先剥公共前后缀，再看规模**。绝大多数改码只动局部（改一行、
// 换一段配置），剥完前缀/后缀后中段往往只剩几行，于是无论文件多大都能算精确 diff。
// 若先按总行数判预算再剥离，「5000 行文件改 1 行」会退化成「删 5000 加 5000」，
// 回显出一份完全误导的 diff（实测场景，见 tests/edit-file-diff.test.js）。
//
// 剥完中段仍超预算时（= 真的大面积重写），退化为「中段全删 + 全增」——
// 那种规模下 diff 本来就没有阅读价值，如实反映「大改了」比假装精细更诚实。
const LCS_BUDGET_LINES = 4000
function diffLines(oldText, newText) {
  const a = oldText.split('\n').map(stripCr)
  const b = newText.split('\n').map(stripCr)
  // 去掉公共前后缀后再算 LCS：把 DP 规模压到「实际改动的那几行」
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA + 1)
  const midB = b.slice(start, endB + 1)
  const ops = []
  for (let t = 0; t < start; t++) ops.push({ type: ' ', text: a[t] })
  if (midA.length || midB.length) {
    // dp 表规模是 midA.length × midB.length，任意一侧过大都该退化
    if (midA.length <= LCS_BUDGET_LINES && midB.length <= LCS_BUDGET_LINES) {
      for (const s of lcsOps(midA, midB)) ops.push(s)
    } else {
      for (const text of midA) ops.push({ type: '-', text })
      for (const text of midB) ops.push({ type: '+', text })
    }
  }
  for (let t = endA + 1; t < a.length; t++) ops.push({ type: ' ', text: a[t] })
  return ops
}

// 两段文本的 LCS 差异序列（内部用完整 dp 表，故调用方已保证规模在预算内）
function lcsOps(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: '-', text: a[i] })
      i++
    } else {
      ops.push({ type: '+', text: b[j] })
      j++
    }
  }
  while (i < a.length) ops.push({ type: '-', text: a[i++] })
  while (j < b.length) ops.push({ type: '+', text: b[j++] })
  return ops
}

// ops（diffLines 的产物）→ unified diff 文本。内容与原内容相同则返回 null（无改动不必回显）。
function renderDiff(oldText, newText) {
  if (oldText === newText) return null
  const ops = diffLines(oldText, newText)
  if (!ops.some((o) => o.type !== ' ')) return null
  // 末尾换行会被 split 出一个空元素（「a\n」→ ['a','']），那不是一行真实内容，
  // 直接显示会在 diff 尾部留一个只有前缀的空行。末尾空行统一不展示。
  if (ops.length && ops[ops.length - 1].type === ' ' && ops[ops.length - 1].text === '') ops.pop()

  // 标记哪些下标要出现在输出里：变更行 + 其上下 DIFF_CONTEXT 行
  const keep = new Uint8Array(ops.length)
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type === ' ') continue
    for (let d = -DIFF_CONTEXT; d <= DIFF_CONTEXT; d++) {
      const t = k + d
      if (t >= 0 && t < ops.length) keep[t] = 1
    }
  }
  const out = []
  let k = 0
  let shownLines = 0
  let shownHunks = 0
  let omittedHunks = 0
  let omittedLines = 0
  // 行号游标：只在推进 ops 时累计，与 oldNoAt/newNoAt 独立（这里要的是"hunk 之前的行数"）
  let oldCursor = 0
  let newCursor = 0
  while (k < ops.length) {
    if (!keep[k]) {
      if (ops[k].type !== '+') oldCursor++
      if (ops[k].type !== '-') newCursor++
      k++
      continue
    }
    // 收集一个 hunk（hunk 起点行号 = 该处之前的行数 + 1）
    const hunk = []
    const oldStart = oldCursor + 1
    const newStart = newCursor + 1
    while (k < ops.length && keep[k]) {
      hunk.push({ op: ops[k] })
      if (ops[k].type !== '+') oldCursor++
      if (ops[k].type !== '-') newCursor++
      k++
    }
    // 预算控制：**整块丢掉不可接受** —— 退化路径（大文件整体重写）下全部变更
    // 恰好是一个巨型 hunk，整块丢等于「改了但一个字没回显」，比不返回 diff 更糟。
    // 所以超预算时取本 hunk 的**前若干行**并标注省略了多少，模型至少看到改动开头。
    // 两道闸：累计行数 DIFF_MAX_LINES、hunk 数量 DIFF_MAX_HUNKS。
    let emit = hunk
    if (shownHunks >= DIFF_MAX_HUNKS || shownLines + hunk.length > DIFF_MAX_LINES) {
      const room = DIFF_MAX_LINES - shownLines
      if (room <= 0) {
        omittedHunks++
        continue
      }
      emit = hunk.slice(0, room)
      omittedLines += hunk.length - room
    }
    const oldCount = emit.filter((x) => x.op.type !== '+').length
    const newCount = emit.filter((x) => x.op.type !== '-').length
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const h of emit) {
      out.push(h.op.type + h.op.text)
      shownLines++
    }
    shownHunks++
  }

  if (!out.length) return { text: '', truncated: true, omittedHunks }
  // 明确告知"回显不完整"。**措辞必须对模型和用户都成立** —— 这段会显示在聊天区的
  // 工具明细里（ChatView 展开后的 diff 块），所以不能写"请 read_file"这种对模型说的话；
  // 「截断时该去读文件」的引导放在工具 description 里。
  if (omittedHunks > 0 || omittedLines > 0) {
    const parts = []
    if (omittedHunks > 0) parts.push(`${omittedHunks} 处变更块`)
    if (omittedLines > 0) parts.push(`${omittedLines} 行`)
    out.push(`…（另有 ${parts.join('、')} 未展示；以上只是部分改动）`)
  }
  return {
    text: out.join('\n'),
    truncated: omittedHunks > 0 || omittedLines > 0,
    omittedHunks,
    omittedLines,
  }
}

// 对外：算出这次写入的 diff 文本。写入前内容不存在（新建）时以空串为基准。
function buildEditDiff(oldContent, newContent) {
  try {
    return renderDiff(String(oldContent ?? ''), String(newContent ?? ''))
  } catch {
    return null // diff 属于锦上添花，算不出来绝不能影响写盘主流程
  }
}

function writeFileSafe(filePath, content) {
  const resolved = path.resolve(filePath)
  if (!isPathAllowed(resolved, true)) {
    throw new Error(`Access denied: "${filePath}" is not in the allowed directories list.`)
  }
  const dir = path.dirname(resolved)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  // 覆写前先留一份原文用于生成 diff（新建文件时基准为空串）
  const existed = fs.existsSync(resolved)
  let prev = ''
  if (existed) {
    try {
      prev = fs.readFileSync(resolved, 'utf-8')
    } catch {
      prev = ''
    }
  }
  fs.writeFileSync(resolved, content, 'utf-8')
  // 记账：AI 新建的文件（或已在册的 AI 文件被再次写入）→ 之后删它 / 覆盖它不弹确认框
  noteAiWrite(resolved, !existed)
  const result = { path: resolved, size: Buffer.byteLength(content, 'utf-8') }
  const diff = buildEditDiff(prev, content)
  if (diff) {
    result.diff = diff.text
    if (diff.truncated) result.diffTruncated = true
    if (!existed) result.created = true
  }
  return result
}

// ============================================================
//  edit_file 的容错匹配（2026-09-28 新增）
//  背景：模型给出的 old_string 与磁盘原文经常在**行尾**上不一致 —— 模型按 LF 生成，
//  而 Windows 仓库里是 CRLF；也可能缩进/空白差一两个字符。原实现直接报「未找到」，
//  模型只能重新 read_file 再来一次，白烧一轮往返。
//  这里做两级兜底：① 按行比较（忽略行尾 CR）找到唯一位置；
//  ② 仍找不到时，把原文里**最相似的行**连同行号回给模型，让它一次改对。
//  注意只兜「行尾 / 空白」，**不做模糊替换** —— 匹配不上就宁可报错，绝不猜着改。
// ============================================================
function stripCr(s) {
  return s.replace(/\r$/, '')
}

// 把文本按行拆开（忽略行尾差异），并剥离「末尾换行」产生的那个空元素。
// 不剥的话，old_string 结尾的 \n 会被当成「要求原文下一行是空行」，
// 于是 `edit_file(old='const a = 1\n')` 永远匹配不上 —— 这正是最容易踩的形态。
function splitLinesForMatch(s) {
  const all = String(s).split('\n')
  let trailing = false
  if (all.length > 1 && all[all.length - 1] === '') {
    all.pop()
    trailing = true
  }
  return { lines: all.map(stripCr), trailing }
}

// 忽略行尾差异后按行查找，返回命中处的起始行下标（0 起）
function findByLines(content, oldString) {
  const cLines = content.split('\n')
  const { lines: oLines } = splitLinesForMatch(oldString)
  if (oLines.length === 0 || oLines.length > cLines.length) return []
  const hits = []
  for (let i = 0; i + oLines.length <= cLines.length; i++) {
    let ok = true
    for (let j = 0; j < oLines.length; j++) {
      if (stripCr(cLines[i + j]) !== oLines[j]) {
        ok = false
        break
      }
    }
    if (ok) hits.push(i)
  }
  return hits
}

// 用 newString 替换从 startLine 起的 lineCount 行；行尾风格沿用被替换区域的首行
function replaceLinesAt(content, startLine, lineCount, newString) {
  const cLines = content.split('\n')
  const eol = /\r$/.test(cLines[startLine] || '') ? '\r' : ''
  const { lines: rawNew } = splitLinesForMatch(newString)
  const newLines = rawNew.map((l) => l + eol)
  return [...cLines.slice(0, startLine), ...newLines, ...cLines.slice(startLine + lineCount)].join('\n')
}

// 字符集 Jaccard + 包含加成：轻量、无依赖，够用来指路
function lineSimilarity(a, b) {
  const x = String(a).trim()
  const y = String(b).trim()
  if (!x || !y) return 0
  if (x === y) return 1
  const sx = new Set(x)
  const sy = new Set(y)
  let common = 0
  for (const ch of sx) if (sy.has(ch)) common++
  const jac = common / (sx.size + sy.size - common)
  const bonus = x.includes(y) || y.includes(x) ? 0.35 : 0
  return Math.min(1, jac * 0.9 + bonus)
}

// 原文里与 old_string 最相似的几行（取 old_string 最长的一行当探针）
function nearestLines(content, oldString, max = 3) {
  const probe = String(oldString)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || ''
  if (probe.length < 4) return []
  const out = []
  const cLines = content.split('\n')
  for (let i = 0; i < cLines.length; i++) {
    const score = lineSimilarity(probe, cLines[i])
    if (score >= 0.55) out.push({ line: i + 1, text: cLines[i].trim().slice(0, 140), score })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, max)
}

function editFileSafe(filePath, oldString, newString, replaceAll = false) {
  const resolved = path.resolve(filePath)
  if (!isPathAllowed(resolved, true)) {
    throw new Error(`Access denied: "${filePath}" is not in the allowed directories list.`)
  }
  if (!fs.existsSync(resolved)) {
    throw fileNotFoundError(filePath, resolved)
  }
  const stat = fs.statSync(resolved)
  if (stat.size > 10 * 1024 * 1024) {
    throw new Error(`File too large (max 10MB): "${filePath}"`)
  }
  const content = fs.readFileSync(resolved, 'utf-8')

  // 空 old_string 会让下面的扫描永不前进（indexOf('', n) 恒返回 n）→ 主线程死循环、整窗冻死。
  // schema 层已加 .min(1)，这里再兜一次：任何调用路径（含未来新增的内部调用）都不至于冻住进程。
  if (!oldString) {
    throw new Error('old_string 不能为空字符串。请提供要替换的原文片段（必须与文件内容精确匹配）。')
  }

  // 统计精确匹配次数
  let count = 0
  let searchFrom = 0
  while (true) {
    const idx = content.indexOf(oldString, searchFrom)
    if (idx === -1) break
    count++
    searchFrom = idx + oldString.length
  }

  if (count > 0) {
    if (!replaceAll && count > 1) {
      throw new Error(`old_string 在文件中出现了 ${count} 次，不唯一。请提供更精确的 old_string 以确保唯一匹配（包含更多上下文行），或设置 replace_all=true 替换所有匹配。`)
    }
    // ⚠️ 非 replaceAll 分支必须用函数形式的 replace：第二个参数若传字符串，
    //    new_string 里出现的 $& / $` / $' / $1.. 会被当成 replacement pattern 展开，
    //    静默把代码改坏（例如 str.replace(/re/, "$&!") 这种真实写法）。
    //    函数形式返回原样字符串，不做任何 $ 展开。replaceAll 分支用的是 split/join，本来就不吃 $。
    const newContent = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, () => newString)
    fs.writeFileSync(resolved, newContent, 'utf-8')
    noteAiWrite(resolved, false) // 已是 AI 的草稿 → 刷新记账；用户自己的文件不会被记上
    const exact = { path: resolved, replacedCount: replaceAll ? count : 1, size: Buffer.byteLength(newContent, 'utf-8') }
    // 回显这次到底改成了什么（模型自查用）；内容无变化时 diff 为 null，不加字段
    const d = buildEditDiff(content, newContent)
    if (d) {
      exact.diff = d.text
      if (d.truncated) exact.diffTruncated = true
    }
    return exact
  }

  // —— 兜底 1：忽略行尾（CRLF/LF）差异后按行匹配 ——
  const lineHits = findByLines(content, oldString)
  if (lineHits.length > 0) {
    const lineCount = splitLinesForMatch(oldString).lines.length
    if (!replaceAll && lineHits.length > 1) {
      throw new Error(`old_string 精确匹配失败；忽略行尾差异后出现在第 ${lineHits.map((h) => h + 1).join('、')} 行（共 ${lineHits.length} 次），不唯一。请提供更多上下文行，或设置 replace_all=true。`)
    }
    let newContent = content
    if (replaceAll) {
      // 从后往前替换，避免前面的改动顶掉后面的行号
      for (let i = lineHits.length - 1; i >= 0; i--) {
        newContent = replaceLinesAt(newContent, lineHits[i], lineCount, newString)
      }
    } else {
      newContent = replaceLinesAt(content, lineHits[0], lineCount, newString)
    }
    fs.writeFileSync(resolved, newContent, 'utf-8')
    noteAiWrite(resolved, false)
    const eolResult = {
      path: resolved,
      replacedCount: replaceAll ? lineHits.length : 1,
      eolAdjusted: true,
      note: '精确匹配未命中，已按「忽略行尾差异」的方式完成替换（文件原有行尾风格保持不变）。',
      size: Buffer.byteLength(newContent, 'utf-8'),
    }
    const d = buildEditDiff(content, newContent)
    if (d) {
      eolResult.diff = d.text
      if (d.truncated) eolResult.diffTruncated = true
    }
    return eolResult
  }

  // —— 兜底 2：报错时把最相似的行号直接给模型，省掉一轮 read_file ——
  const near = nearestLines(content, oldString)
  let msg = 'old_string 在文件中未找到（已尝试忽略行尾差异的按行匹配）。请确认要替换的原文是否精确匹配（包括空格和缩进）。'
  if (near.length) {
    msg += `\n\n原文中与它最相似的位置（可能就是你想改的地方，注意缩进/空白差异）：\n${near.map((n) => `  第 ${n.line} 行：${n.text}`).join('\n')}\n请 read_file 这几行核对原文后重试，不要凭记忆重写。`
  } else {
    msg += '建议先用 read_file 读取文件确认内容。'
  }
  throw new Error(msg)
}

function listDirSafe(dirPath) {
  const resolved = path.resolve(dirPath)
  if (!isPathAllowed(resolved)) {
    throw new Error(`Access denied: "${dirPath}" is not in the allowed directories list.`)
  }
  if (!fs.existsSync(resolved)) {
    // 目录名拼错同样高发：给出授权目录内名字相近的目录，省掉一轮摸索
    const dirs = collectDirsUnder(state.settings.allowedDirs || [], 2)
      .map((d) => ({ ...d, score: similarityScore(path.basename(resolved), d.name) }))
      .filter((d) => d.score >= SIMILAR_MIN_SCORE)
      .sort((x, y) => y.score - x.score)
      .slice(0, SIMILAR_SUGGESTIONS)
    if (dirs.length) {
      const list = dirs.map((d, i) => `  ${i + 1}. ${d.full}`).join('\n')
      return {
        path: resolved,
        files: [],
        directories: [],
        notFound: true,
        hint: `该目录不存在。名字相近的目录：\n${list}\n请用上面的完整绝对路径重试。`,
      }
    }
    return { path: resolved, files: [], directories: [], notFound: true }
  }
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
  return {
    path: resolved,
    files: entries.filter((e) => e.isFile()).map((e) => e.name),
    directories: entries.filter((e) => e.isDirectory()).map((e) => e.name),
  }
}

function deleteFileSafe(filePath) {
  const resolved = path.resolve(filePath)
  if (!isPathAllowed(resolved, true)) {
    throw new Error(`Access denied: "${filePath}" is not in the allowed directories list.`)
  }
  if (!fs.existsSync(resolved)) {
    return { deleted: false, reason: 'not_found' }
  }
  fs.unlinkSync(resolved)
  forgetAiWrite(resolved) // 撤账：同名文件以后再出现，不该被当成「AI 的草稿」
  return { deleted: true }
}

// ============================================================
//  图片载荷（视觉模型输入）
// ============================================================

// 图片不能通过 readFileSafe 按 UTF-8 读取；发送给视觉模型时必须使用 image_url。
const IMAGE_MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGES_PER_MESSAGE = 4

// 图片载荷缓存：key = 路径:mtimeMs:大小 → 已编码的 image_url part。
// 避免在重试 / 上下文压缩重跑 / 会话续聊时重复解码与 base64 编码。
const imagePartCache = new Map()
const IMAGE_CACHE_MAX = 60

// 降采样参数：视觉模型无需原图分辨率，压到最长边 1280px、JPEG 质量 82 即可大幅瘦身
const IMG_MAX_DIM = 1280
const IMG_JPEG_QUALITY = 82
// 仅对超过该尺寸的图做降采样；小图直接内联，避免无收益的解码
const IMG_DOWNSAMPLE_THRESHOLD = 1024 * 1024

function touchImageCache(key, part) {
  // 命中即移到末尾，维持 LRU 顺序
  imagePartCache.delete(key)
  imagePartCache.set(key, part)
  while (imagePartCache.size > IMAGE_CACHE_MAX) {
    imagePartCache.delete(imagePartCache.keys().next().value)
  }
  return part
}

// 用 Electron 自带的 nativeImage 降采样（零额外依赖），仅影响发给 API 的载荷，磁盘原文件不动。
// 返回 null 表示解码失败，调用方应回退到原图 base64。
function downsampleImagePart(resolved, mime) {
  let img
  try {
    img = nativeImage.createFromPath(resolved)
  } catch {
    return null
  }
  return encodeImagePart(img, mime)
}

// 已解码的 nativeImage → image_url part（超长边先降采样）。图是空的（解码失败）返回 null。
// ⚠️ 降采样参数只在这里定义一份：文件附件（本地路径）与「网页里抓到的图」（内存字节）
// 都必须走这里，否则两处参数会各自漂移（token 成本与画质立刻不一致）。
// PNG 只在"确实小"时才保留（无损、保透明度，但同画质下体积常是 JPEG 的 5~10 倍）。
// 阈值是实测定出来的（真实 Electron，2000×1500 的彩色 PNG 降到 1280 后）：
//   PNG toDataURL → 2,492,014 字符；同图 JPEG q82 → 约 46 万字符。
// 前者直接顶穿 tool-images 的单轮字符预算 → 图片被静默丢弃 → 模型只会说"我看不到图"。
const IMG_PNG_KEEP_MAX_CHARS = 700 * 1024

function encodeImagePart(img, mime) {
  // ⚠️ getSize() 返回的是**对象** { width, height }，不是数组 ——
  // 写成 `const [w, h] = img.getSize()` 会直接抛 "object is not iterable"。
  // 这里曾经就是这个写法：单测里 nativeImage 是桩、永远测不到，直到在真实 Electron 里
  // 跑冒烟才炸出来（后果：任何 >1MB 的本地图片附件都会让整轮对话报"图片处理失败"）。
  const size = img.getSize() || {}
  const w = Number(size.width) || 0
  const h = Number(size.height) || 0
  if (!w || !h) return null // 解码失败（空图）
  const scale = Math.min(1, IMG_MAX_DIM / Math.max(w, h))
  const resized = scale < 1 ? img.resize({ width: Math.round(w * scale), height: Math.round(h * scale) }) : img
  if (mime === 'image/png') {
    const url = resized.toDataURL()
    // 小图保留 PNG（截图里的细字、图标轮廓更清晰）；大图落到下面的 JPEG
    if (url.length <= IMG_PNG_KEEP_MAX_CHARS) return { type: 'image_url', image_url: { url } }
  }
  const url = `data:image/jpeg;base64,${resized.toJPEG(IMG_JPEG_QUALITY).toString('base64')}`
  return { type: 'image_url', image_url: { url } }
}

// 内存字节 → image_url part（browser-test.js 下载完网页里的图后调它）。
// 返回 null 表示 Chromium 解不开这个格式（SVG / AVIF / 损坏数据）——调用方跳过该图，
// 不要退化成把原始字节塞进请求体（网关会拒，且白烧一个往返）。
function imagePartFromBuffer(buffer, mime) {
  let img
  try {
    img = nativeImage.createFromBuffer(buffer)
  } catch {
    return null
  }
  return encodeImagePart(img, mime)
}

function imageMimeForPath(filePath) {
  return IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || null
}

function imageUrlFromText(text) {
  const urls = String(text || '').match(/https?:\/\/[^\s<>"']+/gi) || []
  return urls
    .map((url) => url.replace(/[),.，。；;]+$/, ''))
    .filter((url) => {
      try {
        const parsed = new URL(url)
        return parsed.protocol === 'https:' && IMAGE_MIME_BY_EXT[path.extname(parsed.pathname).toLowerCase()]
      } catch (_) {
        return false
      }
    })
}

function localImagePart(filePath) {
  const resolved = path.resolve(filePath)
  const mime = imageMimeForPath(resolved)
  if (!mime) return null
  if (!isPathAllowed(resolved)) {
    throw new Error(`图片访问被拒绝："${path.basename(resolved)}"`)
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`图片文件不存在："${path.basename(resolved)}"`)
  }
  const stat = fs.statSync(resolved)
  if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大（单张上限 10MB）："${path.basename(resolved)}"`)
  }

  // 命中缓存直接返回，跳过解码/编码（重试 / 压缩重跑 / 续聊均受益）
  const cacheKey = `${resolved}:${stat.size}:${stat.mtimeMs}`
  const cached = imagePartCache.get(cacheKey)
  if (cached) return touchImageCache(cacheKey, cached)

  // 小图直接原样 base64 内联（避免无收益的解码开销）。
  // ⚠️ 判据不能只看**文件大小**：配色简单的 UI 截图 2880×1375 也可能不到 1MB
  // （PNG 对色块压缩得很好），原样内联等于把一张 2880 宽的图发给模型 ——
  // 图像 token 按像素算（宽×高÷750 ≈ 5.3k，是 1280 宽时的 4 倍），且每轮都要重发。
  // 所以用 nativeImage 只读一下尺寸（不解码像素），尺寸不大才走快路径。
  if (stat.size <= IMG_DOWNSAMPLE_THRESHOLD) {
    const probe = tryCreateFromPath(resolved)
    const probeSize = probe ? probe.getSize() || {} : null
    const maxDim = probeSize ? Math.max(Number(probeSize.width) || 0, Number(probeSize.height) || 0) : 0
    if (maxDim <= IMG_MAX_DIM) {
      const data = fs.readFileSync(resolved).toString('base64')
      return touchImageCache(cacheKey, { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } })
    }
  }

  // 大图 / 大尺寸：nativeImage 降采样后再内联
  const downsampled = downsampleImagePart(resolved, mime)
  if (downsampled) return touchImageCache(cacheKey, downsampled)

  // 兜底：降采样失败则用原图 base64
  const data = fs.readFileSync(resolved).toString('base64')
  return touchImageCache(cacheKey, { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } })
}

// nativeImage.createFromPath 在文件损坏/格式不支持时返回空图（不抛），个别情况下会抛 —— 两种都归一成 null
function tryCreateFromPath(resolved) {
  try {
    const img = nativeImage.createFromPath(resolved)
    const size = img && img.getSize ? img.getSize() || {} : {}
    if (!Number(size.width) || !Number(size.height)) return null
    return img
  } catch {
    return null
  }
}

async function buildImageParts(messages, attachedFiles) {
  const parts = []
  const latestUser = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m && m.role === 'user')
  for (const url of imageUrlFromText(latestUser && latestUser.content)) {
    parts.push({ type: 'image_url', image_url: { url } })
  }
  for (const file of Array.isArray(attachedFiles) ? attachedFiles : []) {
    const part = localImagePart(file && file.path)
    if (part) parts.push(part)
  }
  if (parts.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(`单条消息最多支持 ${MAX_IMAGES_PER_MESSAGE} 张图片`)
  }
  return parts
}

function addImagePartsToLatestUser(messages, imageParts) {
  if (!imageParts.length) return messages
  const result = messages.map((message) => ({ ...message }))
  const index = result.map((m) => m && m.role).lastIndexOf('user')
  if (index < 0) return result
  const message = result[index]
  const text = typeof message.content === 'string' ? message.content : ''
  result[index] = {
    ...message,
    content: [{ type: 'text', text }, ...imageParts],
  }
  return result
}

// ============================================================
//  file / dialog / md-preview / external / openPath 域 IPC
// ============================================================
function registerIpc() {
  ipcMain.handle('file:read', (_event, filePath) => {
    try {
      const content = readFileSafe(filePath)
      return { success: true, content }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('file:write', (_event, filePath, content) => {
    try {
      const result = writeFileSafe(filePath, content)
      return { success: true, result }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('file:list', (_event, dirPath) => {
    try {
      const result = listDirSafe(dirPath)
      return { success: true, result }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('file:delete', (_event, filePath) => {
    try {
      const result = deleteFileSafe(filePath)
      return { success: true, result }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('dialog:selectDirectory', async () => {
    const result = await dialog.showOpenDialog(state.mainWindow, {
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true }
    }
    return { canceled: false, path: result.filePaths[0] }
  })

  // 选择要附加的文件（支持多选）—— 只记住路径，不复制文件本身
  ipcMain.handle('dialog:selectFiles', async () => {
    const result = await dialog.showOpenDialog(state.mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: '选择要附加的文件',
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, paths: [] }
    }
    // 只保留仍然存在的文件
    const paths = result.filePaths.filter(p => {
      try { return fs.statSync(p).isFile() } catch { return false }
    })
    return { canceled: false, paths }
  })

  // 使用主进程原生 dialog 替代 window.confirm()，避免后者阻塞渲染进程
  // 时导致的 Chromium 焦点状态损坏问题。对话框关闭后立即恢复窗口焦点。
  ipcMain.handle('dialog:confirm', async (_event, message) => {
    const result = await dialog.showMessageBox(state.mainWindow, {
      type: 'question',
      buttons: ['取消', '确定'],
      defaultId: 1,
      cancelId: 0,
      message: message || '确定？',
      title: '确认',
    })
    // 对话框关闭后强制恢复窗口与 webContents 的焦点，
    // 确保渲染进程后续的 .focus() 调用可以正常生效
    if (state.mainWindow) {
      state.mainWindow.focus()
      state.mainWindow.webContents.focus()
    }
    return result.response === 1
  })

  // --- Open external URL in system browser (帮助页等) ---
  // 只允许 http/https，防止渲染层借此打开任意协议
  ipcMain.handle('app:openExternal', async (_event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { success: false, error: 'only http/https urls allowed' }
    }
    try {
      await shell.openExternal(url)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // --- Open local file path with the system default app (如 xlsx→Excel) ---
  // 复用授权目录白名单校验，防止渲染层借此打开任意文件
  ipcMain.handle('file:openPath', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return { success: false, error: 'invalid path' }
    }
    const resolved = path.resolve(filePath)
    if (!isPathAllowed(resolved)) {
      return { success: false, error: 'Access denied: not in allowed directories' }
    }
    if (!fs.existsSync(resolved)) {
      return { success: false, error: `文件不存在：${filePath}` }
    }
    try {
      const errMsg = await shell.openPath(resolved)
      return errMsg ? { success: false, error: errMsg } : { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // --- 打开独立 md 预览窗口（不受应用内宽度限制，可自由缩放/最大化） ---
  // 复用授权目录白名单校验；渲染层加载 index.html?view=md&path=...，绕过登录走最小入口
  ipcMain.handle('md-preview:open', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return { success: false, error: 'invalid path' }
    }
    const resolved = path.resolve(filePath)
    if (!isPathAllowed(resolved)) {
      return { success: false, error: 'Access denied: not in allowed directories' }
    }
    if (!fs.existsSync(resolved)) {
      return { success: false, error: `文件不存在：${filePath}` }
    }
    // 同一文件已打开时，聚焦已有窗口而不是重复开
    const existing = state.mdPreviewWindows.find((w) => w.filePath === resolved && !w.window.isDestroyed())
    if (existing) {
      if (existing.window.isMinimized()) existing.window.restore()
      existing.window.focus()
      return { success: true }
    }

    const win = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 560,
      minHeight: 400,
      title: path.basename(resolved),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
      show: false,
    })
    hardenWindow(win)
    win.once('ready-to-show', () => win.show())

    const entry = { window: win, filePath: resolved }
    state.mdPreviewWindows.push(entry)
    win.on('closed', () => {
      const i = state.mdPreviewWindows.indexOf(entry)
      if (i >= 0) state.mdPreviewWindows.splice(i, 1)
    })

    try {
      if (process.env.VITE_DEV_SERVER_URL) {
        await win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?view=md&path=${encodeURIComponent(resolved)}`)
      } else {
        await win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'), {
          query: { view: 'md', path: resolved },
        })
      }
    } catch (err) {
      win.destroy()
      return { success: false, error: err.message }
    }
    return { success: true }
  })
}

module.exports = {
  isPathAllowed,
  readFileSafe,
  readFileWithRange,
  writeFileSafe,
  editFileSafe,
  listDirSafe,
  deleteFileSafe,
  imageMimeForPath,
  imagePartFromBuffer,
  // 本机图片文件 → image_url part（read_image 工具用；含白名单校验、10MB 上限、降采样）
  localImagePart,
  MAX_IMAGES_PER_MESSAGE,
  IMG_MAX_DIM,
  MAX_IMAGE_BYTES,
  buildImageParts,
  addImagePartsToLatestUser,
  registerIpc,
}