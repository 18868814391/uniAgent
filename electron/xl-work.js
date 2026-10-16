// ============================================================
//  xl-work —— Excel/本地任务的「会话级临时工作目录」管理
//
//  解决:Excel 专家等角色处理表格时会用 write_file 生成过程 Python 脚本
//  (temp_excel_task.py 等),旧约定直接写进授权目录根,任务结束不删,污染用户业务目录。
//
//  约定(与 harness/roles/excel/system-prompt.md 配套):
//    - AI 的"过程脚本/中间文件"一律写入 <授权目录>/.xl-work/<runKey>/ 临时目录;
//    - 交付产物仍写 <授权目录>(EXCEL_OUTPUT_DIR),二者目录语义彻底分开;
//    - 本轮对话结束(chat.js finally)对该 run 目录延迟自动删除 —— 不依赖 LLM 记得删,
//      中断/超时/进程被杀也会在 run 收尾时兜底;
//    - 应用启动清扫超过 1 天的孤儿目录**与散落文件**(app 异常退出时 scheduleCleanup 没跑完的残留);
//    - 每轮收尾额外剪一次根下的散落文件(pruneRootLeftovers):AI 有时把脚本写到
//      `.xl-work/` 根而不是本轮 run 子目录,那些文件不属于任何 run,scheduleCleanup 碰不到。
//
//  安全边界:scheduleCleanup/sweepOrphanWorkDirs 只操作位于 excelWorkRoot()
//  (授权目录/.xl-work)之内的路径,绝不触碰用户业务文件。路径经 path.resolve 规范化。
// ============================================================
const fs = require('fs')
const path = require('path')
const settings = require('./settings')

const WORK_SUBDIR = '.xl-work'
// 本轮结束后延迟删除:留出尾部异步写盘与新请求窗口;配合 chat:send 新 run 用新目录,
// 延迟删除不会误伤正在进行的下一轮(它们的目录 key 不同)。
const DEFAULT_CLEANUP_DELAY_MS = 90 * 1000
// 启动清扫:超过该年龄的 .xl-work 子目录视为孤儿(scheduleCleanup 未执行完的残留)。
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 1 天

let runSeq = 0

/** 工作目录根:<EXCEL_OUTPUT_DIR>/.xl-work (EXCEL_OUTPUT_DIR 在授权目录或 userData/excel-output) */
function excelWorkRoot() {
  return path.join(settings.getExcelOutputDir(), WORK_SUBDIR)
}

/** 规范化后 dir 是否位于 root 内(含 root 本身)——双保险,拒绝清理越界路径 */
function isInside(root, dir) {
  const r = path.resolve(root)
  const t = path.resolve(dir)
  return t === r || t.startsWith(r + path.sep)
}

/**
 * 为一次对话 run 创建新的临时工作目录(独立 key,多轮/多会话互不干扰)。
 * 返回目录绝对路径;目录确保已创建。
 */
function newRunWorkDir(conversationId) {
  const root = excelWorkRoot()
  try {
    fs.mkdirSync(root, { recursive: true })
  } catch (e) {
    console.warn('[xl-work] mkdir root failed:', e.message)
  }
  runSeq++
  const safe = String(conversationId || 'conv')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'conv'
  const key = `${safe}-${Date.now()}-${runSeq}`
  const dir = path.join(root, key)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (e) {
    console.warn('[xl-work] mkdir failed:', e.message)
  }
  return dir
}

/** 延迟删除一个 run 工作目录。越界路径一律拒绝(返回 false)。 */
function scheduleCleanup(dir, delayMs = DEFAULT_CLEANUP_DELAY_MS) {
  if (!dir) return false
  if (!isInside(excelWorkRoot(), dir)) {
    console.warn(`[xl-work] refuse cleanup outside work root: ${dir}`)
    return false
  }
  const timer = setTimeout(() => {
    try {
      if (fs.existsSync(dir)) {
        console.log(`[xl-work] removing run work dir: ${dir}`)
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } catch (e) {
      console.warn(`[xl-work] cleanup failed ${dir}: ${e.message}`)
    }
  }, delayMs)
  if (timer.unref) timer.unref() // 不阻塞应用退出;退出残留由启动清扫兜底
  return true
}

/**
 * 启动清扫:删除 work 根下超过 maxAgeMs 未变动的孤儿目录**与散落文件**。返回删除数量。
 *
 * ⚠️ 不能只看目录(旧版只清 isDirectory):AI 偶尔会把过程脚本写到 `.xl-work/` **根**
 * 而不是本轮的 run 子目录(2026-09-30 实测:.xl-work 根下堆了 explore1~7.py / fill.py /
 * verify*.py 共十几个文件)。这些文件不在任何 run 目录里,`scheduleCleanup` 永远碰不到,
 * 只能靠这里按年龄兜底。
 */
function sweepOrphanWorkDirs(maxAgeMs = ORPHAN_MAX_AGE_MS, root = excelWorkRoot()) {
  if (!fs.existsSync(root)) return 0
  let removed = 0
  const now = Date.now()
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name)
    try {
      const st = fs.statSync(p)
      if (now - st.mtimeMs > maxAgeMs) {
        fs.rmSync(p, { recursive: true, force: true })
        removed++
      }
    } catch (e) {
      // 目录/文件已消失、无权限等 —— 忽略,下次启动再试
    }
  }
  if (removed > 0) console.log(`[xl-work] swept ${removed} orphan item(s) from ${root}`)
  return removed
}

/**
 * 剪掉 work 根下的散落文件(只处理根下的直接文件,不递归子目录)。
 *
 * 阈值用"早于本轮开始时间":正在被写的文件(本轮自己、或并发会话) mtime 必然 >= 该时刻,
 * 因此不会误伤正在使用的脚本。用途——每轮对话收尾时,把上一轮/上次运行写错位置、
 * 落在根下的过程脚本清掉,而不是等 1 天的启动清扫。
 */
function pruneRootLeftovers(beforeTs, root = excelWorkRoot()) {
  if (!beforeTs || !fs.existsSync(root)) return 0
  let removed = 0
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name)
    try {
      const st = fs.statSync(p)
      if (!st.isFile()) continue
      if (st.mtimeMs < beforeTs) {
        fs.rmSync(p, { force: true })
        removed++
      }
    } catch (e) {
      // 文件已消失 / 无权限等 —— 忽略
    }
  }
  if (removed > 0) console.log(`[xl-work] pruned ${removed} stray file(s) from ${root}`)
  return removed
}

module.exports = {
  WORK_SUBDIR,
  excelWorkRoot,
  isInside,
  newRunWorkDir,
  scheduleCleanup,
  sweepOrphanWorkDirs,
  pruneRootLeftovers,
}
