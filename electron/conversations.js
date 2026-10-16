// ============================================================
//  Conversations —— 会话存储 / 搜索 / 标题生成 / 附加文件授权
//  拥有:会话索引与消息文件读写、过期清理、历史全文搜索、
//  AI 标题生成、附加文件读取授权,以及 conversations / attachments
//  域的 IPC 注册。
// ============================================================
const { app, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const state = require('./state')
const { generateConversationTitle } = require('./ai')
const { deleteConvSummary } = require('./context')
const { deleteToolActivity } = require('./tool-activity')
const { clearTurnSnapshot } = require('./turn-snapshot')
const { clearTodos } = require('./tools/todo')

// CONVERSATIONS_DIR 需在 app ready 后才能取 userData，故惰性求值（模块可能在 ready 前被 require）
function getConversationsDir() {
  if (!global.__localAiConvDir) {
    global.__localAiConvDir = path.join(app.getPath('userData'), 'conversations')
  }
  return global.__localAiConvDir
}

function ensureConversationsDir() {
  const dir = getConversationsDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function getConvIndexPath() {
  return path.join(getConversationsDir(), 'index.json')
}

function getConvMessagesPath(id) {
  return path.join(getConversationsDir(), `${id}.json`)
}

function loadConvIndex() {
  ensureConversationsDir()
  const p = getConvIndexPath()
  if (!fs.existsSync(p)) return []
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch { return [] }
}

function saveConvIndex(list) {
  ensureConversationsDir()
  fs.writeFileSync(getConvIndexPath(), JSON.stringify(list, null, 2), 'utf-8')
}

// 每次应用启动时清理超过 30 天（按最后活跃时间）的对话记录
function cleanupExpiredConversations() {
  const MAX_AGE = 30 * 24 * 60 * 60 * 1000 // 30 天
  const cutoff = Date.now() - MAX_AGE
  let list = loadConvIndex()
  const kept = []
  let removed = 0
  for (const conv of list) {
    const lastActive = conv.updatedAt || conv.createdAt || 0
    if (lastActive > cutoff) {
      kept.push(conv)
    } else {
      removed++
      const mp = getConvMessagesPath(conv.id)
      if (fs.existsSync(mp)) {
        try { fs.unlinkSync(mp) } catch (e) { console.error('[cleanup] 删除消息文件失败:', e) }
      }
      deleteConvSummary(conv.id)   // 同步清理历史摘要 sidecar
      deleteToolActivity(conv.id)  // 以及工具活动台账（压缩时喂给摘要器的那份）
      clearTurnSnapshot(conv.id)   // 以及中断续跑快照，避免留下孤儿文件
    }
  }
  if (removed > 0) {
    saveConvIndex(kept)
    console.log(`[cleanup] 已清理 ${removed} 条超过 30 天的对话记录`)
  }
  return removed
}

// 清理 0 条消息的空对话（消息文件为空数组或不存在）：
// 旧版本每次启动/点「新对话」都会立刻落盘一条空的「新对话」，
// 升级后历史里堆积了大量无内容记录。这里在每次启动时把它们从索引与磁盘一并清掉。
function cleanupEmptyConversations() {
  const list = loadConvIndex()
  const kept = []
  let removed = 0
  for (const conv of list) {
    let count = 0
    const mp = getConvMessagesPath(conv.id)
    if (fs.existsSync(mp)) {
      try {
        const msgs = JSON.parse(fs.readFileSync(mp, 'utf-8'))
        count = Array.isArray(msgs) ? msgs.length : 0
      } catch {
        count = 0
      }
    }
    if (count > 0) {
      kept.push(conv)
    } else {
      removed++
      if (fs.existsSync(mp)) {
        try { fs.unlinkSync(mp) } catch (e) { console.error('[cleanup] 删除空对话消息文件失败:', e) }
      }
      deleteConvSummary(conv.id)
      deleteToolActivity(conv.id)
      clearTurnSnapshot(conv.id)
    }
  }
  if (removed > 0) {
    saveConvIndex(kept)
    console.log(`[cleanup] 已清理 ${removed} 条 0 消息的空对话`)
  }
  return removed
}

// ============================================================
//  历史全文搜索（界面搜索框 + AI search_history 工具共用）
// ============================================================

// 从消息内容里截取命中关键词附近的一小段，用于搜索结果展示（匹配位置前后各留一些上下文）
function extractSearchSnippet(content, q) {
  const idx = content.toLowerCase().indexOf(q)
  if (idx < 0) return ''
  const start = Math.max(0, idx - 20)
  const end = Math.min(content.length, idx + q.length + 40)
  const s = content.slice(start, end).replace(/\s+/g, ' ').trim()
  return (start > 0 ? '…' : '') + s + (end < content.length ? '…' : '')
}

// 搜索用户的历史会话记录（标题 + 消息内容，大小写不敏感）。
// 供两处复用：界面搜索框（conversations:search，不带全文）与 AI 的 search_history 工具
// （withContent=true，附带截断的对话全文，让模型能直接基于内容回答）。
// 返回结果已按最近更新排序、截断到 maxResults 条。
async function searchConversationHistory(query, { withContent = false, maxResults = 50 } = {}) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []
  const dir = getConversationsDir()
  const indexPath = getConvIndexPath()
  let list = []
  try {
    if (fs.existsSync(indexPath)) list = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
  } catch {}
  const results = []
  for (const conv of Array.isArray(list) ? list : []) {
    const title = typeof conv.title === 'string' ? conv.title : ''
    const titleHit = title.toLowerCase().includes(q)
    let snippet = ''
    let content = ''
    let matchCount = 0
    const mp = path.join(dir, `${conv.id}.json`)
    if (fs.existsSync(mp)) {
      try {
        const msgs = JSON.parse(await fs.promises.readFile(mp, 'utf-8'))
        if (Array.isArray(msgs)) {
          const parts = []
          for (const m of msgs) {
            const raw = typeof m.content === 'string' ? m.content : ''
            if (!raw) continue
            if (raw.toLowerCase().includes(q)) {
              matchCount++
              if (!snippet) snippet = extractSearchSnippet(raw, q)
            }
            if (withContent) {
              const label = m.role === 'user' ? '用户' : 'AI'
              parts.push(`${label}: ${raw.length > 400 ? raw.slice(0, 400) + '…' : raw}`)
              if (parts.join('\n').length > 10000) {
                parts.push('…（内容较多已截断，可用更精确的关键词再搜）')
                break
              }
            }
          }
          if (withContent) content = parts.join('\n')
        }
      } catch {}
    }
    if (titleHit || matchCount > 0) {
      results.push({
        convId: conv.id,
        title: title || '(无标题)',
        updatedAt: conv.updatedAt || 0,
        messageCount: conv.messageCount || 0,
        titleHit,
        snippet,
        matchCount,
        content,
      })
    }
  }
  results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return results.slice(0, maxResults)
}

// ============================================================
//  会话归档（导出 Markdown）
//  侧边栏「归档」按钮：把单个会话的消息导出为 .md 文件落盘，
//  再用原生对话框告知保存路径（可一键在资源管理器中定位）。
//  非破坏性：不动会话索引与消息文件，历史列表里该会话照旧保留。
// ============================================================

// 归档文件统一落地 userData/archives/（与 conversations/ 同级）。
// 不写用户授权目录：归档是「留档副本」，不应往用户自己的工作目录里塞文件。
function getArchiveDir() {
  return path.join(app.getPath('userData'), 'archives')
}

function ensureArchiveDir() {
  const dir = getArchiveDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function formatDateTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// 文件名清洗：Windows 非法字符 / 控制字符 / 结尾点与空格（资源管理器不接受），并截断长度
function sanitizeFileName(name, maxLen = 40) {
  let s = String(name || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  if (s.length > maxLen) s = s.slice(0, maxLen).trim()
  return s || '未命名会话'
}

// 同名文件不覆盖：已存在则追加 -2 / -3 …
function uniqueArchivePath(dir, baseName, ext = '.md') {
  let target = path.join(dir, `${baseName}${ext}`)
  let i = 2
  while (fs.existsSync(target)) {
    target = path.join(dir, `${baseName}-${i}${ext}`)
    i++
  }
  return target
}

// 消息正文本身是 Markdown（AI 输出），其标题会和归档文档的结构标题「## N · 用户」同级，
// 导致大纲错乱。这里把正文里的 ATX 标题整体降一级——必须跳过 ``` 围栏内的内容，
// 否则 Python / Shell 代码的行首 # 注释会被误判成标题。
function demoteHeadings(text) {
  let inFence = false
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```+|~~~+)/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(/^(\s*)(#{1,5})(\s)/, '$1#$2$3')
    })
    .join('\n')
}

// 组装归档 Markdown：头部元信息（时间/消息数，便于日后检索溯源）+ 逐条消息正文
function buildConversationMarkdown({ conv, messages, title }) {
  const userCount = messages.filter((m) => m.role === 'user').length
  const aiCount = messages.filter((m) => m.role === 'assistant').length
  const lines = []
  lines.push(`# ${title}`, '')
  lines.push('> 本文件由 Local AI Open 自动归档生成')
  lines.push(`> 归档时间：${formatDateTime(Date.now())}`)
  if (conv && conv.id) lines.push(`> 会话 ID：${conv.id}`)
  if (conv && conv.createdAt) lines.push(`> 创建时间：${formatDateTime(conv.createdAt)}`)
  if (conv && conv.updatedAt) lines.push(`> 最后更新：${formatDateTime(conv.updatedAt)}`)
  lines.push(`> 消息数：${messages.length}（用户 ${userCount} / AI ${aiCount}）`)
  lines.push('', '---')
  messages.forEach((m, idx) => {
    const label = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : String(m.role || '消息')
    const text = typeof m.content === 'string' && m.content.trim() ? m.content.trim() : '（空消息）'
    lines.push('', `## ${idx + 1} · ${label}`, '')
    if (m.partial) lines.push('> ⚠️ 该回答被中断，内容不完整', '')
    lines.push(demoteHeadings(text))
  })
  lines.push('', '---', '')
  return lines.join('\n')
}

// 渲染层传来的是结构化克隆后的普通对象，这里再收窄一次字段，避免脏数据写进归档文件
function normalizeMessages(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({
      role: typeof m.role === 'string' ? m.role : 'user',
      content: typeof m.content === 'string' ? m.content : '',
      partial: m.partial === true,
    }))
}

// ============================================================
//  conversations / attachments 域 IPC
// ============================================================
function registerIpc() {
  cleanupEmptyConversations()
  cleanupExpiredConversations()

  ipcMain.handle('conversations:list', () => {
    const list = loadConvIndex()
    // Sync messageCount from actual data files
    for (const conv of list) {
      const mp = getConvMessagesPath(conv.id)
      try {
        if (fs.existsSync(mp)) {
          const raw = fs.readFileSync(mp, 'utf-8')
          const msgs = JSON.parse(raw)
          conv.messageCount = Array.isArray(msgs) ? msgs.length : 0
        } else {
          conv.messageCount = 0
        }
      } catch {
        conv.messageCount = 0
      }
    }
    // Sort newest first
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return list
  })

  // 搜索历史记录（界面搜索框用）：复用 searchConversationHistory，返回渲染层需要的字段。
  // 命中会话列表带标题命中标记与内容命中片段；最多 50 条，按最近更新排序。
  ipcMain.handle('conversations:search', async (_event, query) => {
    const hits = await searchConversationHistory(query, { maxResults: 50 })
    return hits.map((h) => ({
      id: h.convId,
      title: h.title,
      updatedAt: h.updatedAt,
      messageCount: h.messageCount,
      titleHit: h.titleHit,
      snippet: h.snippet,
    }))
  })

  ipcMain.handle('conversations:create', () => {
    // 惰性落盘：0 条消息的「新对话」不写入 index / 不创建空消息文件（不进历史记录）。
    // 只在首次收到真实消息（conversations:saveMessages）时才建档持久化；
    // 应用重启后未使用过的空会话自然消失，侧边栏不再堆积「新对话」。
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const now = Date.now()
    return { id, title: '新对话', createdAt: now, updatedAt: now, messageCount: 0, saved: false }
  })

  ipcMain.handle('conversations:delete', (event, id) => {
    let list = loadConvIndex()
    list = list.filter(c => c.id !== id)
    saveConvIndex(list)
    // Remove messages file
    const mp = getConvMessagesPath(id)
    if (fs.existsSync(mp)) fs.unlinkSync(mp)
    deleteConvSummary(id)   // 同步清理历史摘要 sidecar
    deleteToolActivity(id)  // 同步清理工具活动台账
    clearTurnSnapshot(id)   // 同步清理中断续跑快照
    clearTodos(id)          // 同步清理任务清单（update_todos）
    return { success: true }
  })

  // 归档会话：把消息导出为 Markdown 落盘（userData/archives/），完成后弹原生对话框
  // 告知保存路径（可一键打开所在文件夹）。非破坏性——会话索引与消息文件都不动。
  // inMemoryMessages：渲染层当前内存里的消息（会话正在流式或尚未落盘时磁盘数据不完整），
  // 有则优先使用，否则回退读磁盘消息文件。
  ipcMain.handle('conversations:archive', async (_event, id, inMemoryMessages) => {
    try {
      const conv = loadConvIndex().find((c) => c.id === id) || null

      let messages = normalizeMessages(inMemoryMessages)
      if (messages.length === 0) {
        const mp = getConvMessagesPath(id)
        if (fs.existsSync(mp)) {
          try {
            messages = normalizeMessages(JSON.parse(fs.readFileSync(mp, 'utf-8')))
          } catch {
            messages = []
          }
        }
      }
      if (messages.length === 0) {
        return { success: false, error: '该会话还没有任何消息，无法归档' }
      }

      // 标题：优先用索引里的标题（排除占位名），否则退回首条用户消息
      const firstUser = messages.find((m) => m.role === 'user')
      const rawTitle =
        conv && conv.title && conv.title !== '新对话'
          ? conv.title
          : (firstUser && firstUser.content) || '新对话'
      const title = String(rawTitle).replace(/\s+/g, ' ').trim().slice(0, 60) || '新对话'

      const dir = ensureArchiveDir()
      const base = new Date(conv && conv.createdAt ? conv.createdAt : Date.now())
      const stamp = `${base.getFullYear()}${pad2(base.getMonth() + 1)}${pad2(base.getDate())}`
      const filePath = uniqueArchivePath(dir, `${stamp}_${sanitizeFileName(title)}`)
      fs.writeFileSync(filePath, buildConversationMarkdown({ conv, messages, title }), 'utf-8')

      const win = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : null
      const options = {
        type: 'info',
        buttons: ['打开所在文件夹', '知道了'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: '归档完成',
        detail: [
          `已归档：${title}`,
          `消息数：${messages.length} 条`,
          '',
          '文件位置：',
          filePath,
          '',
          '（该会话仍保留在左侧历史列表中，未被删除）',
        ].join('\n'),
        title: '归档完成',
      }
      const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
      if (result.response === 0) shell.showItemInFolder(filePath)
      // 与 dialog:confirm 一致：对话框关闭后恢复窗口焦点，避免渲染层后续 focus 失效
      if (win) {
        win.focus()
        win.webContents.focus()
      }
      return {
        success: true,
        path: filePath,
        dir,
        fileName: path.basename(filePath),
        messageCount: messages.length,
        title,
      }
    } catch (err) {
      console.error('[archive] 会话归档失败:', err)
      return { success: false, error: err.message || String(err) }
    }
  })

  ipcMain.handle('conversations:rename', (_event, id, title) => {
    const list = loadConvIndex()
    const conv = list.find(c => c.id === id)
    if (conv) {
      conv.title = title
      conv.updatedAt = Date.now()
      saveConvIndex(list)
    }
    return conv || null
  })

  // 会话标记色（侧栏色点）：用户在同一天开了多个会话时随手标记区分。
  // 只写索引里的 flag 字段，**刻意不动 updatedAt** —— 标记不该把会话顶到列表最上面。
  // flag 传 null / 空串 = 取消标记；只接受 #RRGGBB，脏数据一律拒绝（不回显）。
  ipcMain.handle('conversations:setFlag', (_event, id, flag) => {
    const list = loadConvIndex()
    const conv = list.find(c => c.id === id)
    if (!conv) return { success: false, error: '会话不存在' }
    if (flag === null || flag === undefined || flag === '') {
      delete conv.flag
    } else if (typeof flag === 'string' && /^#[0-9a-fA-F]{6}$/.test(flag)) {
      conv.flag = flag.toLowerCase()
    } else {
      return { success: false, error: '标记颜色非法' }
    }
    saveConvIndex(list)
    return { success: true, flag: conv.flag || null }
  })

  ipcMain.handle('conversations:getMessages', (_event, id) => {
    const p = getConvMessagesPath(id)
    if (!fs.existsSync(p)) return []
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'))
    } catch { return [] }
  })

  ipcMain.handle('conversations:saveMessages', (_event, id, messages, convMeta = {}) => {
    const sender = _event.sender
    ensureConversationsDir()
    fs.writeFileSync(getConvMessagesPath(id), JSON.stringify(messages, null, 2), 'utf-8')
    // Update index
    const list = loadConvIndex()
    const now = Date.now()
    let conv = list.find(c => c.id === id)
    if (!conv) {
      // 首次落盘：此前只是内存中的空会话（0 消息未建档），现在才进入历史记录。
      // createdAt 沿用会话首次创建的时间戳（渲染层随 convMeta 传回），不随落盘漂移。
      conv = {
        id,
        title: '新对话',
        createdAt: convMeta && Number.isFinite(convMeta.createdAt) ? convMeta.createdAt : now,
        updatedAt: now,
        messageCount: 0,
      }
      list.push(conv)
    }
    conv.updatedAt = Date.now()
    conv.messageCount = messages.length
    // Auto-generate title from first user message
    if (!conv.title || conv.title === '新对话') {
      const firstUser = messages.find(m => m.role === 'user')
      if (firstUser) {
        // 即时兜底：先截断首条消息，保证标题不为空、不阻塞保存
        conv.title = firstUser.content.slice(0, 30) + (firstUser.content.length > 30 ? '...' : '')
        // 异步用模型生成更贴切的标题（JSON mode），成功则覆盖；失败静默保留兜底
        if (!state.pendingTitleFor.has(id)) {
          state.pendingTitleFor.add(id)
          generateConversationTitle(firstUser.content)
            .then((title) => {
              if (!title) return
              const refreshed = loadConvIndex()
              const target = refreshed.find((c) => c.id === id)
              if (target) {
                target.title = title
                saveConvIndex(refreshed)
                // 通知渲染层刷新会话列表，让侧栏立即显示模型生成的标题
                try { sender.send('conversations:changed', { id }) } catch {}
              }
            })
            .catch((err) => {
              console.warn('[title] 模型生成标题失败，保留兜底标题:', err.message)
            })
            .finally(() => state.pendingTitleFor.delete(id))
        }
      }
    }
    saveConvIndex(list)
    return { success: true }
  })

  // --- File Attachments (导入文件：授予读取权限) ---
  ipcMain.handle('attachments:register', (_event, paths) => {
    const list = (Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string')
    const registered = []
    for (const p of list) {
      const resolved = path.resolve(p)
      try {
        if (fs.statSync(resolved).isFile()) {
          state.attachedFilePaths.add(resolved)
          registered.push(resolved)
        }
      } catch {
        // 文件已不存在，忽略
      }
    }
    return { success: true, registered }
  })

  ipcMain.handle('attachments:unregister', (_event, p) => {
    if (typeof p === 'string') {
      state.attachedFilePaths.delete(path.resolve(p))
    }
    return { success: true }
  })

  ipcMain.handle('attachments:clear', () => {
    state.attachedFilePaths.clear()
    return { success: true }
  })
}

module.exports = {
  getConversationsDir,
  getArchiveDir,
  cleanupEmptyConversations,
  cleanupExpiredConversations,
  searchConversationHistory,
  buildConversationMarkdown,
  sanitizeFileName,
  registerIpc,
}