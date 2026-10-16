// ============================================================
//  tools/ai-created —— 记账：「这份文件是 AI 自己写出来的」
//
//  需求（syf 原话）：AI 自己生成的文件（例如它写来跑一次性校验的临时脚本），
//  删除时不该弹「该文件从未提交到 git，删除后无法恢复」—— 那是在提醒用户
//  「你要丢东西了」，可这份东西本来就是 AI 造的，不是用户的资产。
//
//  做法是**记账**而不是猜测：write_file / edit_file 写盘成功后，把
//  「路径 + size + mtime」记一笔；删除 / 覆盖前比对当前 stat —— 一致（= 自 AI 最后一次
//  写入后没人碰过）就按 AI 产物放行；对不上（用户手工改过、git checkout 拉回旧版本…）
//  仍然按原逻辑弹确认，因为那时它已经变回「用户的文件」。
//
//  落盘 userData/ai-created-files.json（重启后依然认得），拿不到 electron 时退化成纯内存。
//
//  ⚠️ 只依赖 fs / path（electron 在函数内惰性取），与 tools/guard.js 同款隔离：
//     guard.js 要 require 它，而 tests/dev-guard.test.js 在纯 node 下跑，
//     顶层 require('electron') 会让那个测试直接抛。
//  ⚠️ 记的是 st_size + st_mtimeMs，不是内容 hash：写完一次 statSync 即可，大文件也不用重读。
//     代价是「同尺寸 + 同 mtime」的改动识别不出来 —— 现实中改一个字符而不动 mtime
//     几乎不可能（NTFS 的 mtime 精度是 100ns，两个不同时刻的写入不会撞）。
// ============================================================
const fs = require('fs')
const path = require('path')

const STORE_FILENAME = 'ai-created-files.json'
// 上限：正常一次会话写不了这么多文件；超了按「最久没被写入的」淘汰，
// 记录本身只是「少弹一次确认框」的优化，丢了顶多退回原行为。
const MAX_ENTRIES = 500

let entries = null            // Map<normPath, { size, mtimeMs, at }>
let storePathOverride = null  // 测试用：绕过 electron 直接指定落盘位置

function normPath(p) {
  let r = path.resolve(String(p || ''))
  if (process.platform === 'win32') r = r.toLowerCase()
  return r
}

function storePath() {
  if (storePathOverride) return storePathOverride
  try {
    const { app } = require('electron')
    const dir = app && app.getPath('userData')
    return dir ? path.join(dir, STORE_FILENAME) : null
  } catch {
    return null // 纯 node（单测）/ electron 不可用 → 只在内存里记账
  }
}

function ensureLoaded() {
  if (entries) return entries
  entries = new Map()
  const file = storePath()
  if (!file) return entries
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const files = (raw && raw.files) || {}
    for (const [k, v] of Object.entries(files)) {
      if (v && Number.isFinite(v.size) && Number.isFinite(v.mtimeMs)) {
        entries.set(k, { size: v.size, mtimeMs: v.mtimeMs, at: v.at || 0 })
      }
    }
  } catch {
    // 文件不存在 / 内容损坏 → 空表重来（判定退回「不是 AI 产物」，保守）
  }
  return entries
}

function persist() {
  const file = storePath()
  if (!file || !entries) return
  try {
    const files = {}
    for (const [k, v] of entries) files[k] = v
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: 1, files }), 'utf-8')
  } catch {
    // 落盘失败不影响判定主流程：内存表仍然有效，只是重启后认不出来
  }
}

function trim() {
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    entries.delete(oldest)
  }
}

/**
 * 记一笔「这份文件此刻的内容是 AI 写的」。
 * @param {string} filePath 写盘后的绝对路径
 * @param {boolean} isNew  写盘前该文件是否不存在（AI 新建）
 *
 * 只记两种：① AI 新建的文件；② 已经在册的 AI 文件被 AI 再次写入。
 * 用户自己的文件被 AI 改过一次 **不会**变成「AI 产物」—— 那种文件里多数内容仍是用户的，
 * 删它照样得问（在册才续记，就是为了挡住这条）。
 */
function noteAiWrite(filePath, isNew) {
  if (!filePath) return
  const map = ensureLoaded()
  const key = normPath(filePath)
  if (!isNew && !map.has(key)) return
  let st
  try {
    st = fs.statSync(path.resolve(String(filePath)))
  } catch {
    map.delete(key) // 文件没写成功 / 已被删 → 撤账
    persist()
    return
  }
  map.delete(key) // 重新插入 = 移到队尾（淘汰时先扔最久没写过的）
  map.set(key, { size: st.size, mtimeMs: Math.round(st.mtimeMs), at: Date.now() })
  trim()
  persist()
}

/**
 * 这个文件是不是「AI 写出来、且之后再没人动过」？
 * 任一条件不满足（没记账 / 文件没了 / size 或 mtime 对不上）都返回 false —— 保守。
 */
function isAiAuthored(filePath) {
  if (!filePath) return false
  const entry = ensureLoaded().get(normPath(filePath))
  if (!entry) return false
  let st
  try {
    st = fs.statSync(path.resolve(String(filePath)))
  } catch {
    return false
  }
  return st.size === entry.size && Math.round(st.mtimeMs) === entry.mtimeMs
}

/** 文件被删掉了 → 撤账（不然以后同名新文件会被误当成 AI 产物） */
function forgetPath(filePath) {
  if (!filePath) return
  const map = ensureLoaded()
  if (map.delete(normPath(filePath))) persist()
}

// ------------------------------------------------------------
//  目录树判定 —— 给「rm -rf <目录>」那条路径用（tools/guard.js 消费）
// ------------------------------------------------------------
// 递归上限：记账表本身最多 MAX_ENTRIES 条，AI 造的临时目录不可能有几百个文件。
// 超限立刻放弃豁免 —— 宁可弹一次确认框，也不能让 `rm -rf node_modules` 在主进程里
// 同步遍历几万个文件（同步 IO 卡死主进程的教训见 tools/search.js 头部）。
const MAX_TREE_SCAN = 200

/**
 * 这棵目录树是不是「整棵树都是 AI 的草稿」？
 *
 * 判据：目录**非空**，且树内每个普通文件都在账上（size + mtime 都对得上）。
 * 任一条件不满足就返回 false —— 不确定一律按「不是 AI 的」处理，退回确认框。
 *
 * 注：目录本身不参与记账比对（mkdir 出来的目录没有「内容」可比），因此**空目录
 * 判为不豁免** —— 那有可能是用户自己建的目录。
 */
function isAiDraftTree(dirPath) {
  if (!dirPath) return false
  let root
  try {
    root = path.resolve(String(dirPath))
    if (!fs.statSync(root).isDirectory()) return false
  } catch {
    return false
  }
  const stack = [root]
  let sawFile = false
  let scanned = 0
  while (stack.length) {
    const dir = stack.pop()
    let items
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const it of items) {
      const full = path.join(dir, it.name)
      if (it.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!it.isFile()) return false // 符号链接 / 设备文件：认不出来，保守拒绝
      sawFile = true
      if (++scanned > MAX_TREE_SCAN) return false
      if (!isAiAuthored(full)) return false
    }
  }
  return sawFile
}

// ---- 测试辅助（生产代码不调用）----
function __setStorePathForTest(p) {
  storePathOverride = p || null
  entries = null
}
function __resetForTest() {
  entries = null
  storePathOverride = null
}

module.exports = {
  noteAiWrite,
  isAiAuthored,
  isAiDraftTree,
  forgetPath,
  normPath,
  STORE_FILENAME,
  MAX_ENTRIES,
  __setStorePathForTest,
  __resetForTest,
}
