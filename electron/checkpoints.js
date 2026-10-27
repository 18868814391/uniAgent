// ============================================================
//  checkpoints —— 文件级检查点：写盘前留一份原文，改坏了可以整轮撤销（2026-10-24，P0-7）
//
//  为什么需要：
//  dev 角色拥有本机全盘读写权限。项目内文件有 git 兜底，但**非 git 文件、未跟踪文件、
//  桌面散装脚本**改坏了没有任何退路 —— 现有的 `guard.js` 只能在「动手前」拦一下，
//  拦不住「动手之后发现改错了」。`turn-snapshot` 存的是消息，不是文件。
//  Claude Code 的对应能力是 `utils/fileHistory.ts` + `/rewind`。
//
//  设计（刻意从简，三条边界）：
//   ① **只存会被覆盖/删除的原文**，新建文件不存（没东西可恢复）；单文件 ≤5MB，跳二进制；
//   ② **同一轮同一文件只存第一次**：模型一轮里改同一个文件三次，撤销要回到"这一轮开始前"，
//      不能把中间态当成原文存进去；
//   ③ **敏感目录不落副本**：`.ssh` / `.aws` / `AppData` / `Windows` / `Program Files` 一律跳过 ——
//      别把密钥文件复制进 userData。
//
//  目录：`<userData>/checkpoints/<convHash>/turn-<turnId>/<hash>-<basename>` + `manifest.json`
//  生命周期：保留最近 MAX_TURNS 轮、总量 MAX_TOTAL_BYTES；会话删除时 clearSession。
//
//  ⚠️ 顶层不 require('electron')：单测在纯 node 下 require 本模块。
// ============================================================
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

const MAX_FILE_BYTES = 5 * 1024 * 1024      // 单文件上限：再大就不是"代码"了
const MAX_TURNS = 20                        // 每个会话保留最近多少轮
const MAX_TOTAL_BYTES = 200 * 1024 * 1024   // 每个会话的检查点总量上限

// 不落副本的路径（隐私 + 体积）
const SENSITIVE = /[\\/](\.ssh|\.aws|\.gnupg|\.password-store|AppData|ProgramData|Windows|Program Files(?: \(x86\))?)[\\/]/i
// 不落副本的扩展名（二进制，恢复它没有意义）
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tif', '.tiff', '.psd', '.ai',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite', '.node',
  '.ttf', '.ttc', '.otf', '.woff', '.woff2', '.eot',
  '.mp3', '.wav', '.flac', '.aac', '.ogg', '.mp4', '.avi', '.mov', '.mkv', '.webm',
  '.xls', '.xlsx', '.doc', '.docx', '.ppt', '.pptx', '.pdf', '.vsd',
])

function rootDir() {
  if (!global.__localAiCheckpointRoot) {
    let base = null
    try {
      base = require('electron').app.getPath('userData')
    } catch {
      base = path.join(os.tmpdir(), 'localai-checkpoints')
    }
    global.__localAiCheckpointRoot = path.join(base, 'checkpoints')
  }
  return global.__localAiCheckpointRoot
}

/** 测试用：把根目录指到临时目录（传 null 恢复默认）。 */
function __setRootForTest(dir) {
  global.__localAiCheckpointRoot = dir || null
}

function convKey(convId) {
  return crypto.createHash('sha1').update(String(convId || 'unknown')).digest('hex').slice(0, 16)
}

function turnDir(convId, turnId) {
  return path.join(rootDir(), convKey(convId), `turn-${Number(turnId) || 0}`)
}

function manifestPath(convId, turnId) {
  return path.join(turnDir(convId, turnId), 'manifest.json')
}

function readManifest(convId, turnId) {
  try {
    const raw = fs.readFileSync(manifestPath(convId, turnId), 'utf-8')
    const m = JSON.parse(raw)
    return Array.isArray(m && m.files) ? m.files : []
  } catch {
    return []
  }
}

function writeManifest(convId, turnId, files) {
  const dir = turnDir(convId, turnId)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.manifest-${process.pid}-${Date.now()}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), files }, null, 2), 'utf-8')
  fs.renameSync(tmp, manifestPath(convId, turnId))
}

function shouldSkip(resolved, st) {
  if (!st || !st.isFile()) return true
  if (st.size === 0 || st.size > MAX_FILE_BYTES) return true
  if (SENSITIVE.test(resolved)) return true
  if (SKIP_EXT.has(path.extname(resolved).toLowerCase())) return true
  return false
}

/**
 * 写盘/删除**之前**调用：把原文复制到检查点目录。
 * 同一轮同一个文件只存第一次（撤销要回到这一轮开始前）。
 * @returns {boolean} 是否真的存了副本
 */
function snapshotBeforeWrite(convId, turnId, filePath) {
  try {
    if (!convId || turnId === undefined || turnId === null) return false
    if (typeof filePath !== 'string' || !filePath) return false
    const resolved = path.resolve(filePath)
    let st
    try {
      st = fs.statSync(resolved)
    } catch {
      return false   // 新建文件：没有原文可存
    }
    if (shouldSkip(resolved, st)) return false

    const files = readManifest(convId, turnId)
    if (files.some((f) => f && f.path === resolved)) return false   // 本轮已存过

    const key = `${crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 12)}-`
      + path.basename(resolved).replace(/[^\w.\-]/g, '_').slice(0, 48)
    const dir = turnDir(convId, turnId)
    fs.mkdirSync(dir, { recursive: true })
    const backup = path.join(dir, key)
    fs.copyFileSync(resolved, backup)
    files.push({ path: resolved, backup: key, size: st.size })
    writeManifest(convId, turnId, files)
    prune(convId)
    return true
  } catch (e) {
    console.warn('[checkpoints] 存快照失败（不影响写盘）:', e && e.message)
    return false
  }
}

/**
 * 撤销某一轮的全部改动：把存下来的原文复制回去。
 * @returns {{ok:boolean, restored:string[], failed:Array<{path:string,error:string}>, reason?:string}}
 */
function restoreTurn(convId, turnId) {
  const files = readManifest(convId, turnId)
  if (files.length === 0) {
    return { ok: false, restored: [], failed: [], reason: '这一轮没有可恢复的文件（可能没有覆盖过已存在的文件）' }
  }
  const restored = []
  const failed = []
  for (const f of files) {
    try {
      const backup = path.join(turnDir(convId, turnId), f.backup)
      if (!fs.existsSync(backup)) {
        failed.push({ path: f.path, error: '备份文件已丢失（可能已被清理）' })
        continue
      }
      fs.mkdirSync(path.dirname(f.path), { recursive: true })
      fs.copyFileSync(backup, f.path)
      restored.push(f.path)
    } catch (e) {
      failed.push({ path: f.path, error: String((e && e.message) || e) })
    }
  }
  return { ok: restored.length > 0, restored, failed }
}

/** 某一轮存了几个文件（给 UI 判断要不要显示「撤销本轮」）。 */
function turnFileCount(convId, turnId) {
  return readManifest(convId, turnId).length
}

/** 列出该会话有检查点的轮次（新→旧）。 */
function listTurns(convId) {
  try {
    const dir = path.join(rootDir(), convKey(convId))
    return fs.readdirSync(dir)
      .filter((n) => /^turn-\d+$/.test(n))
      .map((n) => {
        const turnId = Number(n.slice(5))
        const files = readManifest(convId, turnId)
        return { turnId, files: files.length, bytes: files.reduce((s, f) => s + (f.size || 0), 0) }
      })
      .filter((t) => t.files > 0)
      .sort((a, b) => b.turnId - a.turnId)
  } catch {
    return []
  }
}

/** 只保留最近 MAX_TURNS 轮 + 总量上限（超了从最旧的轮次整目录删）。 */
function prune(convId) {
  try {
    const dir = path.join(rootDir(), convKey(convId))
    const turns = fs.readdirSync(dir)
      .filter((n) => /^turn-\d+$/.test(n))
      .sort((a, b) => Number(b.slice(5)) - Number(a.slice(5)))   // 新 → 旧
    let total = 0
    turns.forEach((n, idx) => {
      const full = path.join(dir, n)
      let bytes = 0
      try {
        for (const f of readManifest(convId, Number(n.slice(5)))) bytes += f.size || 0
      } catch { /* ignore */ }
      total += bytes
      if (idx >= MAX_TURNS || total > MAX_TOTAL_BYTES) {
        try { fs.rmSync(full, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 会话删除时清空（conversations.js 调用）。 */
function clearSession(convId) {
  try {
    fs.rmSync(path.join(rootDir(), convKey(convId)), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

/** IPC：渲染层查「哪些轮次可撤销」+ 执行撤销。 */
function registerIpc() {
  const { ipcMain } = require('electron')
  ipcMain.handle('checkpoint:list', (_e, convId) => listTurns(convId))
  ipcMain.handle('checkpoint:restore', (_e, payload = {}) => {
    const { convId, turnId } = payload || {}
    const res = restoreTurn(convId, turnId)
    console.log(`[checkpoints] 撤销 turn-${turnId}：恢复 ${res.restored.length} 个，失败 ${res.failed.length} 个`)
    return res
  })
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_TURNS,
  MAX_TOTAL_BYTES,
  snapshotBeforeWrite,
  restoreTurn,
  turnFileCount,
  listTurns,
  prune,
  clearSession,
  registerIpc,
  // 测试用
  __setRootForTest,
}
