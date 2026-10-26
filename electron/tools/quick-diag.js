// ============================================================
//  quick-diag —— 写盘后的「秒级」语法/编译诊断（2026-10-24）
//
//  为什么需要（P0-2）：
//  edit_file / write_file 以前只回一份 unified diff，**不告诉模型"这份文件现在编译得过吗"**。
//  而系统提示词明确禁止跑全项目 typecheck / 全量 build（huatie-pc2 上一次 4~5 分钟），
//  模型于是只跑"改动文件的 eslint" —— 语法/编译错误一路漏到用户打包时才炸，
//  中间白烧 2~3 个来回（用户报错 → 模型重读 → 再改）。
//  Claude Code 的做法是编辑后向 IDE/LSP 发 didSave、把诊断作为 attachment 回灌；
//  我们没有 IDE 连接，就退一步：**用本地能跑的单文件检查器**给出同等信息。
//
//  设计约束（三条，改之前先读）：
//   ① **绝不把一次成功的写盘变成失败**：任何异常/超时/工具链缺失 → 返回 null，静默跳过；
//   ② **只报语法/编译错误，不报风格问题**：eslint 那类慢检查不进这里（走 chat.js 的一轮一次）；
//   ③ **有预算**：单文件 3 秒、1MB 上限、错误最多 20 条 —— 它挂在关键路径上，
//      慢一秒就是每处编辑慢一秒。
//
//  检查器（按扩展名，全部是"项目内有才跑，没有就跳过"）：
//    .js/.cjs/.mjs  → node --check（Electron 下用 ELECTRON_RUN_AS_NODE 复用自身二进制）
//    .json          → JSON.parse
//    .vue           → 项目内 @vue/compiler-sfc：parse + compileScript + compileTemplate
//    .ts/.tsx/.jsx  → 项目内 esbuild：transformSync（只查语法，不做类型检查）
//    .py            → py_compile（PYTHONPYCACHEPREFIX 指到临时目录，不污染仓库）
//
//  ⚠️ 顶层不 require('electron')：单测在纯 node 下 require 本模块。
// ============================================================
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')

const BUDGET_MS = 3000                  // 单个文件的检查预算
const MAX_FILE_BYTES = 1024 * 1024      // 超过 1MB 不查（生成出来的巨型文件，查了也没人改）
const MAX_ERRORS = 20                   // 报太多只会挤掉 diff，取前 20 条
const PY_PYCACHE_DIR = path.join(os.tmpdir(), 'localai-diag-pyc')

/** 定位项目内的依赖（从被改文件所在目录向上找 node_modules）。找不到返回 null。 */
function resolveFromProject(file, name) {
  try {
    return require.resolve(name, { paths: [path.dirname(file)] })
  } catch {
    return null
  }
}

/** 统一把各类检查器的错误对象/字符串规整成 {line, message}。 */
function toDiagList(errors) {
  if (!Array.isArray(errors)) return []
  return errors.filter(Boolean).map((e) => {
    if (typeof e === 'string') return { line: null, message: e }
    const loc = e.loc || (e.location && { start: { line: e.location.line } })
    const line = loc && loc.start && Number.isInteger(loc.start.line) ? loc.start.line : null
    return { line, message: String(e.message || e.text || e).replace(/\s+/g, ' ').trim().slice(0, 300) }
  })
}

// ------------------------------------------------------------
//  JS：node --check
//  Electron 主进程里 process.execPath 是 electron.exe，直接 `--check` 会被当成应用启动参数；
//  加 ELECTRON_RUN_AS_NODE=1 才退化成 node。单测环境是纯 node，这个环境变量无副作用。
// ------------------------------------------------------------
function checkNodeSyntax(file) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--check', file],
      { timeout: BUDGET_MS, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      (err, stdout, stderr) => {
        if (!err) return resolve([])
        const text = String(stderr || stdout || '')
        // 形如：C:\path\a.js:12\nconst a = {\n        ^\n\nSyntaxError: Unexpected end of input
        const lineM = /^.*?:(\d+)\s*$/m.exec(text)
        const msgM = /([A-Za-z]*Error:[^\n]*)/.exec(text)
        resolve([{
          line: lineM ? Number(lineM[1]) : null,
          message: msgM ? msgM[1].trim() : String(err.message || 'node --check 失败').slice(0, 300),
        }])
      },
    )
  })
}

// ------------------------------------------------------------
//  JSON：JSON.parse（顺带把 position 换算成行号）
// ------------------------------------------------------------
async function checkJson(file) {
  const raw = fs.readFileSync(file, 'utf8')
  try {
    JSON.parse(raw)
    return []
  } catch (e) {
    const m = /position (\d+)/.exec(String(e.message || ''))
    const line = m ? raw.slice(0, Number(m[1])).split('\n').length : null
    return [{ line, message: String(e.message || e) }]
  }
}

// ------------------------------------------------------------
//  Vue SFC：parse（模板/脚本块结构） + compileScript + compileTemplate
// ------------------------------------------------------------
async function checkVueSfc(file) {
  const modPath = resolveFromProject(file, '@vue/compiler-sfc')
  if (!modPath) return null
  let sfc = null
  try {
    sfc = require(modPath)
  } catch {
    return null
  }
  const source = fs.readFileSync(file, 'utf8')
  const out = []
  let descriptor = null
  try {
    const parsed = sfc.parse(source, { filename: file })
    descriptor = parsed.descriptor
    out.push(...toDiagList(parsed.errors))
  } catch (e) {
    return [{ line: null, message: `SFC 解析失败：${String(e.message || e).slice(0, 280)}` }]
  }
  if (descriptor && (descriptor.script || descriptor.scriptSetup)) {
    try {
      sfc.compileScript(descriptor, { id: 'localai-quick-diag' })
    } catch (e) {
      out.push({ line: null, message: String(e.message || e).slice(0, 300) })
    }
  }
  if (descriptor && descriptor.template && descriptor.template.content) {
    try {
      const r = sfc.compileTemplate({
        source: descriptor.template.content,
        filename: file,
        id: 'localai-quick-diag',
      })
      out.push(...toDiagList(r.errors))
    } catch (e) {
      out.push({ line: null, message: String(e.message || e).slice(0, 300) })
    }
  }
  return out
}

// ------------------------------------------------------------
//  TS / TSX / JSX：esbuild 只做语法转译（不做类型检查 —— 全项目类型检查是被明令禁止的）
// ------------------------------------------------------------
async function checkWithEsbuild(file, loader) {
  const modPath = resolveFromProject(file, 'esbuild')
  if (!modPath) return null
  let esbuild = null
  try {
    esbuild = require(modPath)
  } catch {
    return null
  }
  const source = fs.readFileSync(file, 'utf8')
  try {
    esbuild.transformSync(source, { loader, sourcefile: file, logLevel: 'silent' })
    return []
  } catch (e) {
    const errs = (e && e.errors) || []
    if (errs.length) {
      return errs.slice(0, 5).map((x) => ({
        line: x.location && Number.isInteger(x.location.line) ? x.location.line : null,
        message: String(x.text || x).replace(/\s+/g, ' ').slice(0, 300),
      }))
    }
    return [{ line: null, message: String(e.message || e).slice(0, 300) }]
  }
}

// ------------------------------------------------------------
//  Python：py_compile（stderr 形如 「File "x.py", line 3 … SyntaxError: …」）
//  PYTHONPYCACHEPREFIX 把 .pyc 重定向到临时目录，避免在用户仓库里生成 __pycache__。
// ------------------------------------------------------------
let pythonBinCache
function resolvePython() {
  if (pythonBinCache !== undefined) return Promise.resolve(pythonBinCache)
  const candidates = ['python', 'py', 'python3']
  return new Promise((resolve) => {
    let i = 0
    const next = () => {
      if (i >= candidates.length) {
        pythonBinCache = null
        return resolve(null)
      }
      const bin = candidates[i++]
      execFile(bin, ['--version'], { timeout: 1500, windowsHide: true }, (err) => {
        if (!err) {
          pythonBinCache = bin
          return resolve(bin)
        }
        next()
      })
    }
    next()
  })
}

async function checkPython(file) {
  const bin = await resolvePython()
  if (!bin) return null
  return new Promise((resolve) => {
    execFile(
      bin,
      ['-m', 'py_compile', file],
      {
        timeout: BUDGET_MS,
        windowsHide: true,
        env: { ...process.env, PYTHONPYCACHEPREFIX: PY_PYCACHE_DIR },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve([])
        const text = String(stderr || stdout || '')
        const lineM = /\bline (\d+)/.exec(text)
        const msgM = /([A-Za-z]*Error:[^\n]*)/.exec(text)
        resolve([{
          line: lineM ? Number(lineM[1]) : null,
          message: msgM ? msgM[1].trim() : String(err.message || 'py_compile 失败').slice(0, 300),
        }])
      },
    )
  })
}

const CHECKERS = {
  '.js': checkNodeSyntax,
  '.cjs': checkNodeSyntax,
  '.mjs': checkNodeSyntax,
  '.json': checkJson,
  '.vue': checkVueSfc,
  '.ts': (f) => checkWithEsbuild(f, 'ts'),
  '.tsx': (f) => checkWithEsbuild(f, 'tsx'),
  '.jsx': (f) => checkWithEsbuild(f, 'jsx'),
  '.py': checkPython,
}

/**
 * 检查一个文件。
 * @returns {Promise<Array<{line:number|null,message:string}>|null>}
 *   null      —— 不检查（扩展名不认识 / 文件太小太大 / 项目里没有对应工具链 / 任何异常）
 *   []        —— 检查过，没问题
 *   [{...}]   —— 检查过，有错误
 */
async function diagnoseFile(filePath) {
  try {
    if (typeof filePath !== 'string' || !filePath) return null
    const abs = path.resolve(filePath)
    // 依赖目录里的文件不查：既慢又不是用户代码
    if (/[\\/]node_modules[\\/]/i.test(abs)) return null
    const checker = CHECKERS[path.extname(abs).toLowerCase()]
    if (!checker) return null
    const st = fs.statSync(abs)
    if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) return null
    const res = await checker(abs)
    if (res === null) return null
    return res.slice(0, MAX_ERRORS)
  } catch {
    return null
  }
}

/**
 * 把诊断结果附到写盘工具的返回对象上（**只在有错误时**附加，干净的写盘不加任何字段 ——
 * 每次编辑都带一句"语法没问题"纯属白烧 token）。
 *
 * 只改传进来的对象，返回它本身，方便 handler 里链式使用。
 */
async function attachDiagnostics(result, filePath) {
  if (!result || typeof result !== 'object') return result
  const diags = await diagnoseFile(filePath || result.path)
  if (!diags || diags.length === 0) return result
  result.diagnostics = diags
  result.diagnosticsNote =
    '该文件这次写盘后**编译不过**（上面是错误位置与原因）。先把这些语法/编译错误修掉，'
    + '再继续做别的、再声称"已完成" —— 不要把带语法错误的文件当成交付物。'
  return result
}

module.exports = {
  BUDGET_MS,
  MAX_ERRORS,
  CHECKERS,
  diagnoseFile,
  attachDiagnostics,
}
