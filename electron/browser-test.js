const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const { getBrowserDownloadsDir, getTestOutputDir } = require('./settings')
// 图片编码/降采样只有一份实现（tools/fs-safe.js 的 IMG_MAX_DIM / IMG_JPEG_QUALITY），
// 这里复用而不是另写一份 —— 两处参数一旦漂移，token 成本与画质就会在同一应用里不一致。
const { imagePartFromBuffer, MAX_IMAGE_BYTES } = require('./tools/fs-safe')

// ============================================================
//  Browser Test Driver — 网页测试窗口
//  AI 通过 browser_* 工具驱动此窗口加载并测试网页。
//  窗口完全沙箱化（nodeIntegration:false / sandbox:true），
//  JS 只在页面上下文执行，不触碰主进程能力。
//  下载：窗口触发的下载统一落盘到 userData/browser-downloads
//  （will-download 接管，不弹系统保存框），路径经 browser_wait_download
//  返回给 AI 后用 read_file / execute_command 解析。
//  取图：readImages() 把页面里的图下载+降采样成 image_url part，交给上层
//  （tools/index.js 暂存 → chat.js 注入下一轮 user 消息），多模态模型因此能"看"页面。
//  截图 screenshot() 只落盘给用户看，模型看不到 —— 要让自己看图请用 readImages。
// ============================================================

let testWindow = null
let consoleBuffer = []
let lastLoadError = null
const MAX_CONSOLE = 1000
const DEFAULT_TIMEOUT = 10000

// ---------- 下载记录（供 browser_wait_download 查询） ----------
let downloads = []
let downloadSeq = 0
const hookedSessions = new WeakSet()

// 清洗下载文件名：去掉 Windows 非法字符与路径分隔符，防目录穿越/覆盖
function sanitizeDownloadName(raw) {
  const name = String(raw || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim()
    .slice(0, 180)
  return name || `download-${Date.now()}`
}

function summarizeDownload(rec) {
  return {
    id: rec.id,
    filename: rec.filename,
    file: rec.file,
    url: rec.url,
    state: rec.state,
    receivedBytes: rec.receivedBytes,
    totalBytes: rec.totalBytes,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    error: rec.error,
  }
}

// 只接管"网页测试窗口"自身触发的下载（默认 session 与主窗口共享，
// 非本窗口触发的下载保持系统默认行为，不影响用户手动下载）
function hookDownloads(session) {
  if (!session || hookedSessions.has(session)) return
  hookedSessions.add(session)
  session.on('will-download', (event, item, wc) => {
    if (!testWindow || testWindow.isDestroyed() || wc !== testWindow.webContents) return
    event.preventDefault()
    const dir = getBrowserDownloadsDir()
    fs.mkdirSync(dir, { recursive: true })
    const filename = sanitizeDownloadName(item.getFilename())
    const ext = path.extname(filename)
    const base = path.basename(filename, ext)
    let savePath = path.join(dir, filename)
    for (let n = 1; fs.existsSync(savePath); n++) {
      savePath = path.join(dir, `${base}(${n})${ext}`)
    }
    item.setSavePath(savePath)

    const rec = {
      id: ++downloadSeq,
      filename,
      file: savePath,
      url: item.getURL(),
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: 0,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
    }
    downloads.push(rec)
    if (downloads.length > 200) downloads = downloads.slice(-200)
    item.on('updated', (_e, st) => {
      rec.state = (st && st.state) || rec.state
      if (st && typeof st.receivedBytes === 'number') rec.receivedBytes = st.receivedBytes
      if (st && typeof st.totalBytes === 'number') rec.totalBytes = st.totalBytes
    })
    item.once('done', (_e, st) => {
      rec.state = (st && st.state) || rec.state
      rec.finishedAt = Date.now()
      rec.error = rec.state === 'completed' ? null : `下载未完成（${rec.state}）`
      if (rec.state !== 'completed') {
        try {
          if (fs.existsSync(savePath)) fs.unlinkSync(savePath)
        } catch {}
      }
    })
  })
}

/**
 * 等待网页测试窗口最近一次触发的下载完成（AI 点击页面「下载」按钮后调用）。
 * @param {object} [opts]
 * @param {string} [opts.name] 文件名关键词（不传则取最新的下载）
 * @param {number} [opts.timeoutMs] 超时，默认 60000
 * @returns {Promise<object>} { success, download?, error?, downloads? }
 */
async function waitForDownload({ name, timeoutMs = 60000 } = {}) {
  if (!testWindow || testWindow.isDestroyed()) {
    return { success: false, error: '网页测试窗口未打开，无法等待下载。请先用 browser_open 打开页面并点击下载。' }
  }
  const since = downloadSeq
  const deadline = Date.now() + Math.max(2000, Number(timeoutMs) || 60000)
  const kw = name ? String(name).toLowerCase() : ''
  const isMatch = (r) => !kw || r.filename.toLowerCase().includes(kw)

  while (Date.now() < deadline) {
    const fresh = downloads.filter((r) => r.id > since && isMatch(r))
    if (fresh.length) {
      const rec = fresh[fresh.length - 1]
      if (rec.state === 'completed') {
        return { success: true, download: summarizeDownload(rec) }
      }
      if (rec.state === 'progressing' || rec.state === 'interrupted') {
        await sleep(400)
        continue
      }
      return { success: false, error: rec.error || `下载状态：${rec.state}`, download: summarizeDownload(rec) }
    }
    // 兼容下载完成早于本次调用：直接命中最近已完成且匹配的文件
    const done = downloads.filter((r) => isMatch(r) && r.state === 'completed')
    if (done.length) {
      const rec = done[done.length - 1]
      if (fs.existsSync(rec.file)) return { success: true, download: summarizeDownload(rec) }
    }
    await sleep(400)
  }

  return {
    success: false,
    error: `等待下载超时（${timeoutMs}ms），未检测到新的下载完成。请确认是否已点击「下载」且目标站点开始传输文件。`,
    downloads: downloads.slice(-5).reverse().map(summarizeDownload),
  }
}

// ---------- Selector resolution helper, injected into the page ----------
// Supports CSS and "text=ExactText" / ":has-text('substring')".
const INJECT_SRC = `(function () {
  if (window.__bt) return
  var INTERACTIVE_ROLES = { button:1, link:1, checkbox:1, radio:1, switch:1, tab:1, menuitem:1, menuitemcheckbox:1, menuitemradio:1, option:1, slider:1, combobox:1, textbox:1, searchbox:1, spinbutton:1, listbox:1, treeitem:1 }
  // 快照句柄：给每个元素分配一个**身份 ID**（首次遇到时分配、写回元素 __btId），
  // ref = "ref=<id>"，refMap 做 id → element 反查。
  // 刻意不用"数组下标"当 ref：下标与位置绑定，表格行一增删，同一个 ref 会静默指向另一个元素
  // （Vue/Element-UI 重渲染是常态）。用身份 ID 时，元素被移除则 isConnected=false → 返回 null，
  // 模型收到"未找到"就会重新快照 —— 报错远比点错元素安全。
  var refMap = {}
  var refSeq = 0
  window.__bt = {
    resolveEl: function (sel) {
      if (typeof sel !== 'string') return null
      sel = sel.trim()
      // 支持 "base >> nth=N" 后缀（Playwright 风格），用于同名元素里精确定位第 N 个。
      // A3：实测 400 个「编辑」按钮时，旧实现恒命中第一个（TreeWalker 取首个匹配），
      // 模型以为点了目标行、实际点了第一行且无从察觉 —— 这就是那个正确性缺陷的修法。
      var nth = -1
      var nthM = sel.match(/^(.*?)\\s*>>\\s*nth=(\\d+)$/)
      if (nthM) { sel = nthM[1].trim(); nth = parseInt(nthM[2], 10) }
      var pick = function (list) {
        if (!list || !list.length) return null
        return list[nth >= 0 ? Math.min(nth, list.length - 1) : 0]
      }
      // ref= 句柄（快照返回的稳定引用）；也接受裸数字，模型有时只复制编号
      var m = sel.match(/^ref=(\\d+)$/) || (/^\\d+$/.test(sel) ? [null, sel] : null)
      if (m) {
        var el = refMap[parseInt(m[1], 10)]
        // 元素已从 DOM 移除（列表重渲染/换页）→ 明确返回 null，让模型重新快照
        if (!el || el.isConnected === false) return null
        return el
      }
      m = sel.match(/^text=(.+)$/)
      if (m) return pick(window.__bt.findByExactText(m[1]))
      m = sel.match(/^:has-text('(.+)')$/)
      if (m) {
        var q2 = m[1]
        var out2 = []
        var all2 = Array.prototype.slice.call(document.querySelectorAll('body *'))
        for (var j = 0; j < all2.length; j++) {
          if (all2[j].children.length === 0 && all2[j].textContent.indexOf(q2) !== -1) out2.push(all2[j])
        }
        return pick(out2)
      }
      try {
        if (nth >= 0) return document.querySelectorAll(sel)[nth] || null
        return document.querySelector(sel)
      } catch (e) { return null }
    },
    // 收集所有"文本精确等于 q"的候选元素（有序、去重）。
    // 旧实现返回单个元素（首个或末个），既无法计数也无法按序号取 → 换成返回候选列表，
    // 由 resolveEl 按 nth 挑选，快照侧也能据此统计重名数量。
    findByExactText: function (q) {
      var out = []
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        var n = walker.currentNode
        if (n.nodeValue && n.nodeValue.trim() === q) {
          var el = n.parentElement
          if (el && out.indexOf(el) === -1) out.push(el)
        }
      }
      if (out.length) return out
      // fallback: innermost element whose trimmed textContent equals q
      // (handles buttons/links with nested spans where no single text node matches)
      var all = Array.prototype.slice.call(document.querySelectorAll('body *'))
      for (var i = 0; i < all.length; i++) {
        if (all[i].children.length === 0 && all[i].textContent && all[i].textContent.trim() === q) out.push(all[i])
      }
      return out
    },
    isVisible: function (el) {
      if (!el) return false
      var r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    },
    // Compact accessibility-tree-style snapshot: only interactive elements, each with a
    // stable ref (ref=N), role and name. Costs a few hundred tokens vs. raw text.
    // A2：不再返回 CSS 选择器（旧版 sel 字段占单次快照 28% 体积）——定位统一走 ref；
    // 需要 CSS 时模型仍可自行书写（resolveEl 仍支持 CSS / text= / :has-text / ">> nth=N"）。
    // 另返回 total：模型据此知道"共 N 个、只给了 max 个"，截断不再是黑盒。
    snapshot: function (opts) {
      opts = opts || {}
      var max = opts.max || 200
      var maxName = opts.maxName || 24
      var items = []
      var seenEls = []
      function textOf(el) {
        return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
      }
      function cssEscape(s) {
        if (window.CSS && CSS.escape) return CSS.escape(s)
        return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\\\' + c })
      }
      function roleOf(el) {
        var tag = el.tagName.toLowerCase()
        var type = (el.getAttribute('type') || '').toLowerCase()
        if (tag === 'button' || type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button'
        if (tag === 'a' && el.getAttribute('href')) return 'link'
        if (tag === 'input') {
          if (type === 'checkbox') return 'checkbox'
          if (type === 'radio') return 'radio'
          return 'input'
        }
        if (tag === 'textarea') return 'textarea'
        if (tag === 'select') return 'select'
        var role = (el.getAttribute('role') || '').toLowerCase()
        if (role) return INTERACTIVE_ROLES[role] ? role : 'skip'
        if (el.isContentEditable) return 'input'
        return 'button'
      }
      function nameOf(el) {
        var aria = el.getAttribute('aria-label')
        if (aria) return aria.trim().slice(0, maxName)
        var lb = el.getAttribute('aria-labelledby')
        if (lb) {
          var ref = document.getElementById(lb)
          if (ref) { var t = textOf(ref); if (t) return t.slice(0, maxName) }
        }
        if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
          var id = el.getAttribute('id')
          if (id) {
            var lbl = document.querySelector('label[for="' + cssEscape(id) + '"]')
            if (lbl) { var lt = textOf(lbl); if (lt) return lt.slice(0, maxName) }
          }
          var wrap = el.closest('label')
          if (wrap) { var wt = textOf(wrap); if (wt && wt !== textOf(el)) return wt.slice(0, maxName) }
          var ph = el.getAttribute('placeholder')
          if (ph) return ph.trim().slice(0, maxName)
        }
        var t2 = textOf(el)
        if (t2) return t2.slice(0, maxName)
        var title = el.getAttribute('title')
        if (title) return title.trim().slice(0, maxName)
        return ''
      }
      // 生成 CSS / text= 形式的选择器。注意：**不返回给模型**（旧版作为 snapshot 的 sel
      // 字段返回，占单次快照 28% 体积）。现在唯一用途是 A5 固化 flow 时把 ref 反解成
      // 跨会话稳定的定位方式，并存进元素 __btSel。
      function selectorFor(el) {
        var id = el.getAttribute('id')
        if (id && id.length < 64) return '#' + cssEscape(id)
        var nm = el.getAttribute('name')
        if (nm && /^[A-Za-z0-9_-]+$/.test(nm)) return el.tagName.toLowerCase() + '[name="' + nm + '"]'
        var tid = el.getAttribute('data-testid') || el.getAttribute('data-test')
        if (tid && /^[A-Za-z0-9_-]+$/.test(tid)) {
          var attr = el.getAttribute('data-testid') !== null ? 'data-testid' : 'data-test'
          return '[' + attr + '="' + tid + '"]'
        }
        var text = textOf(el)
        if (text && text.length <= 30 && (el.tagName === 'BUTTON' || el.tagName === 'A')) return 'text=' + text
        var path = []
        var node = el
        for (var d = 0; d < 2 && node && node !== document.body; d++) {
          var parent = node.parentElement
          var tag = node.tagName.toLowerCase()
          var nth = 1
          if (parent) {
            for (var i = 0; i < parent.children.length; i++) {
              if (parent.children[i] === node) { nth = i + 1; break }
            }
          }
          path.unshift(tag + ':nth-of-type(' + nth + ')')
          node = parent
        }
        return path.join(' > ')
      }
      function collect() {
        var nodes = Array.prototype.slice.call(
          document.querySelectorAll('button, a[href], input, textarea, select, [contenteditable], [role], [onclick], [tabindex]')
        )
        // 先收全量候选（不截断）：截断前必须知道总共有多少、哪些名字重名，
        // 否则模型既不知道"还有 N 个没给我"，也不知道"这个名字有 400 个"。
        var all = []
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i]
          if (seenEls.indexOf(el) !== -1) continue
          if (el.tagName === 'A' && !el.getAttribute('href')) continue
          if (el.getAttribute('aria-hidden') === 'true') continue
          if (!window.__bt.isVisible(el)) continue
          var role = roleOf(el)
          if (role === 'skip') continue
          seenEls.push(el)
          all.push({ el: el, role: role, name: nameOf(el) })
        }
        // 同名计数：只把"重名 > 1"的做成顶层汇总，不给每个元素加 dup 字段 ——
        // 实测 400 行表格里 200 项有 196 项重名，逐项标注要多花 ~1,400 tokens
        // 却不多给任何信息（"编辑×400"这一个汇总就够模型判断必须用 ref 或 ">> nth=N"）。
        var nameCount = {}
        for (var c = 0; c < all.length; c++) {
          var nm = all[c].name
          if (nm) nameCount[nm] = (nameCount[nm] || 0) + 1
        }
        var duplicates = {}
        for (var dn in nameCount) {
          if (nameCount[dn] > 1) duplicates[dn] = nameCount[dn]
        }
        var nameSeen = {}   // 同名元素在本列表内的出现序号（用于生成 ">> nth=N"）
        for (var k = 0; k < all.length && items.length < max; k++) {
          var a = all[k]
          // 身份 ID 只在首次遇到时分配，后续快照复用 → 同一个元素始终是同一个 ref
          if (!a.el.__btId) a.el.__btId = ++refSeq
          refMap[a.el.__btId] = a.el
          var item = { ref: 'ref=' + a.el.__btId, role: a.role, name: a.name }
          if (a.el.tagName === 'INPUT') {
            if (a.role === 'checkbox' || a.role === 'radio') item.checked = !!a.el.checked
            else if (a.el.type !== 'button' && a.el.type !== 'submit' && a.el.type !== 'reset') item.value = a.el.value || ''
          } else if (a.el.tagName === 'SELECT') {
            var opt = a.el.options[a.el.selectedIndex]
            item.value = opt ? opt.text.trim() : ''
          } else if (a.el.tagName === 'TEXTAREA') {
            item.value = a.el.value || ''
          }
          // 选择器不返回给模型（A2 省 token），但留在元素上：A5 固化 flow 时用它把 ref
          // 反解成跨会话稳定的选择器 —— ref 只是当次快照的句柄，写进 YAML 下次就失效了。
          // 重名元素必须补 ">> nth=N"（它在同名列表里的序号），否则固化出来的
          // "text=编辑" 回放时会退回"永远点第一个"的老毛病。
          var baseSel = selectorFor(a.el)
          var dupOrd = 0
          if (a.name) {
            nameSeen[a.name] = (nameSeen[a.name] || 0) + 1
            dupOrd = nameSeen[a.name] - 1
          }
          a.el.__btSel = (a.name && nameCount[a.name] > 1) ? baseSel + ' >> nth=' + dupOrd : baseSel
          items.push(item)
        }
        return { total: all.length, duplicates: duplicates }
      }
      var collected = collect()
      var headings = []
      var hs = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3')).slice(0, 6)
      for (var i = 0; i < hs.length; i++) {
        var ht = textOf(hs[i])
        if (ht && headings.indexOf(ht) === -1) headings.push(ht)
      }
      var result = {
        url: location.href,
        title: (document.title || '').slice(0, 120),
        headings: headings,
        count: items.length,
        total: collected.total,
        truncated: collected.total > items.length,
        elements: items,
      }
      // 只在真有大面积重名时才带这个字段，常规页面（无重名）不占体积
      if (Object.keys(collected.duplicates).length) result.duplicates = collected.duplicates
      return result
    },
  }
})()`

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message || `操作超时 (${ms}ms)`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) }
    )
  })
}

// Wait until the webContents finishes its current (initial) load before
// executing JS — calling executeJavaScript on a not-yet-ready renderer hangs.
function whenReady(wc, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!wc.isLoading()) return resolve()
    const timer = setTimeout(() => resolve(), timeoutMs)
    wc.once('did-stop-loading', () => { clearTimeout(timer); resolve() })
    wc.once('did-fail-load', () => { clearTimeout(timer); resolve() })
    wc.once('render-process-gone', () => { clearTimeout(timer); resolve() })
  })
}

// executeJavaScript with a hard timeout, so a page stuck mid-navigation
// can never hang the tool loop.
function safeEval(wc, code, timeoutMs = 8000, userGesture) {
  return withTimeout(wc.executeJavaScript(code, userGesture), timeoutMs, '页面 JS 执行超时')
}

// ---------- Window management ----------

function getWC() {
  if (!testWindow || testWindow.isDestroyed()) {
    throw new Error('测试浏览器未打开，请先调用 browser_open 打开一个网页')
  }
  return testWindow.webContents
}

async function ensureHelper() {
  const wc = getWC()
  await whenReady(wc, 8000)
  await safeEval(wc, INJECT_SRC, 5000).catch(() => {})
}

function normalizeConsoleLevel(level) {
  if (typeof level === 'number') {
    return level === 0 ? 'log' : level === 1 ? 'info' : level === 2 ? 'warning' : 'error'
  }
  const s = String(level || 'log').toLowerCase()
  if (s === 'verbose' || s === 'debug') return 'debug'
  if (s === 'warning' || s === 'warn') return 'warning'
  if (s === 'error') return 'error'
  if (s === 'info') return 'info'
  return 'log'
}

function handleConsoleMessage(...args) {
  const event = args[0]
  let level, message, sourceId
  if (event && typeof event.message === 'string') {
    // Electron 30+ signature: event carries message/level/lineNumber/sourceId
    level = event.level
    message = event.message
    sourceId = event.sourceId
  } else {
    // Legacy signature: (event, level, message, line, sourceId)
    level = args[1]
    message = args[2]
    sourceId = args[4]
  }
  consoleBuffer.push({
    type: normalizeConsoleLevel(level),
    message: String(message || ''),
    source: sourceId || '',
  })
  if (consoleBuffer.length > MAX_CONSOLE) {
    consoleBuffer.splice(0, consoleBuffer.length - MAX_CONSOLE)
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 750,
    minWidth: 640,
    minHeight: 480,
    title: '网页测试',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const wc = win.webContents
  consoleBuffer = []
  lastLoadError = null

  wc.on('console-message', handleConsoleMessage)
  wc.on('did-start-loading', () => { consoleBuffer = [] })
  wc.on('did-finish-load', () => { lastLoadError = null })
  wc.on('did-fail-load', (_e, code, desc, url) => {
    // code -3 = aborted (e.g. superseded by a new navigation) — ignore
    if (code !== -3) lastLoadError = `页面加载失败 (${code}): ${desc} — ${url}`
  })
  wc.on('did-crash', () => { lastLoadError = '页面崩溃 (renderer crashed)' })

  // window.open / target=_blank → keep testing contained: load in this window
  wc.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl && /^https?:/i.test(targetUrl)) {
      wc.loadURL(targetUrl).catch(() => {})
    }
    return { action: 'deny' }
  })

  // 下载接管：本窗口触发的下载（如官网「下载」按钮）统一落盘，不弹系统保存框
  hookDownloads(wc.session)

  win.on('closed', () => {
    if (testWindow === win) testWindow = null
    consoleBuffer = []
  })

  testWindow = win
  return win
}

// ---------- Tool implementations (called from main.js tool loop) ----------

/**
 * Open (or reuse) the test browser and navigate to a URL.
 * Returns current page state: { url, title, text, links }.
 */
async function openBrowser(url, timeoutMs = DEFAULT_TIMEOUT) {
  let target = String(url || '').trim()
  if (!target) throw new Error('browser_open 缺少 url 参数')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    target = 'https://' + target
  }

  let win
  if (testWindow && !testWindow.isDestroyed()) {
    win = testWindow
  } else {
    win = createWindow()
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()

  lastLoadError = null
  await ensureHelper()
  try {
    await withTimeout(win.webContents.loadURL(target), timeoutMs, `页面加载超时 (${timeoutMs}ms): ${target}`)
  } catch (err) {
    throw new Error(lastLoadError || err.message)
  }
  // 让页面 JS 短暂运行后返回当前状态
  await sleep(600)
  return getPage(6000)
}

/**
 * Read the current page state: url, title, visible text (truncated), top links.
 */
async function getPage(maxLen = 6000) {
  const wc = getWC()
  const limit = Math.max(500, Math.min(Number(maxLen) || 6000, 20000))
  const code = `(async () => {
    const maxLen = ${limit}
    const links = Array.prototype.slice.call(document.querySelectorAll('a[href]')).slice(0, 30)
      .map(function (a) { return { text: (a.textContent || '').trim().slice(0, 80), href: a.href } })
      .filter(function (l) { return /^https?:/i.test(l.href) })
    const text = document.body ? (document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, maxLen) : ''
    return { url: location.href, title: document.title || '', text: text, links: links }
  })()`
  const info = await safeEval(wc, code, 8000).catch((err) => ({ error: err.message }))
  return info
}

/**
 * Snapshot interactive elements as a compact list:
 * [{ ref, role, name, value?, checked? }] plus url/title/headings/total/duplicates.
 * A2：不再返回 CSS 选择器（旧版 sel 占单次快照 28% 体积），定位统一走 ref；
 * 并新增 total（全部候选数，暴露截断）与 duplicates（重名汇总，提示用 ref 或 ">> nth=N"）。
 */
async function snapshot(max = 200) {
  const wc = getWC()
  await ensureHelper()
  const cap = Math.max(10, Math.min(Number(max) || 200, 400))
  const code = `(function(){
    var s = window.__bt.snapshot({ max: ${cap} });
    return JSON.parse(JSON.stringify(s));
  })()`
  return safeEval(wc, code, 8000).catch((err) => ({ error: err.message }))
}

/**
 * Click an element. Selector supports CSS and "text=ExactText".
 * Sends a real mouse down/up at the element center.
 */
async function click(selector, timeoutMs = 5000) {
  if (!selector) throw new Error('browser_click 缺少 selector 参数')
  const wc = getWC()
  await ensureHelper()

  const sel = JSON.stringify(selector)
  const deadline = Date.now() + timeoutMs
  let box = null
  while (Date.now() < deadline) {
    box = await safeEval(wc, `(function(){
      var el = window.__bt.resolveEl(${sel});
      if (!el || !window.__bt.isVisible(el)) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      var r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 60) };
    })()`, 3000).catch(() => null)
    if (box) break
    await sleep(200)
  }
  if (!box) throw new Error(`未找到可点击的元素: "${selector}"（超时 ${timeoutMs}ms）`)

  const x = Math.round(box.x)
  const y = Math.round(box.y)
  wc.sendInputEvent({ type: 'mouseMove', x, y })
  await sleep(30)
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  await sleep(40)
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  await sleep(150)

  return { ok: true, selector, tag: box.tag, text: box.text, x, y }
}

/**
 * Focus an input/textarea/contenteditable and type text (appends like real typing).
 */
async function type(selector, text) {
  if (!selector) throw new Error('browser_type 缺少 selector 参数')
  const wc = getWC()
  await ensureHelper()

  const focused = await safeEval(wc, `(function(){
    var el = window.__bt.resolveEl(${JSON.stringify(selector)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.focus();
    return true;
  })()`, 5000)
  if (!focused) throw new Error(`未找到输入元素: "${selector}"`)

  await sleep(80)
  if (testWindow && !testWindow.isDestroyed()) {
    testWindow.show()
    testWindow.focus()
  }
  wc.focus()
  wc.insertText(String(text ?? ''))
  await sleep(120)

  const value = await safeEval(wc, `(function(){
    var el = document.activeElement;
    if (!el) return '';
    return el.value !== undefined ? el.value : (el.textContent || '');
  })()`, 5000).catch(() => '')

  return { ok: true, selector, value }
}

const KEY_MOD_MAP = { control: 'control', ctrl: 'control', shift: 'shift', alt: 'alt', option: 'alt', meta: 'meta', command: 'meta', cmd: 'meta' }
const SPECIAL_KEYS = {
  enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', home: 'Home', end: 'End',
  space: 'Space', ' ': 'Space', pageup: 'PageUp', pagedown: 'PageDown',
  insert: 'Insert', printscreen: 'PrintScreen',
  arrowup: 'ArrowUp', up: 'ArrowUp', arrowdown: 'ArrowDown', down: 'ArrowDown',
  arrowleft: 'ArrowLeft', left: 'ArrowLeft', arrowright: 'ArrowRight', right: 'ArrowRight',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6', f7: 'F7', f8: 'F8',
  f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12', f13: 'F13', f14: 'F14', f15: 'F15',
  f16: 'F16', f17: 'F17', f18: 'F18', f19: 'F19', f20: 'F20', f21: 'F21', f22: 'F22',
  f23: 'F23', f24: 'F24',
}

function mapKeyCode(key) {
  const k = String(key).trim()
  const lower = k.toLowerCase()
  if (SPECIAL_KEYS[lower]) return SPECIAL_KEYS[lower]
  if (k.length === 1) return k
  return k
}

/**
 * Press a key or a chord, e.g. "Enter", "Escape", "Control+S", "Shift+Tab".
 */
async function press(key) {
  if (!key) throw new Error('browser_press 缺少 key 参数')
  const wc = getWC()

  const parts = String(key).split('+').map((s) => s.trim()).filter(Boolean)
  const modifiers = []
  while (parts.length > 1) {
    const mod = parts[0].toLowerCase()
    if (KEY_MOD_MAP[mod]) modifiers.push(KEY_MOD_MAP[mod])
    parts.shift()
  }
  const keyCode = mapKeyCode(parts[0] || key)

  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  await sleep(30)
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await sleep(80)
  return { ok: true, key, keyCode, modifiers }
}

/**
 * Evaluate JavaScript in the page context. `arg` is available as a local.
 * Use for complex reads, custom waits, or one-off actions.
 */
async function evalJs(js, arg) {
  if (typeof js !== 'string' || !js.trim()) throw new Error('browser_eval 缺少 js 参数')
  const wc = getWC()
  const wrapped = `(async () => { const arg = ${JSON.stringify(arg ?? null)}; ${js}\n })()`
  const result = await safeEval(wc, wrapped, 8000, true).catch((err) => ({ error: err.message }))
  return result
}

/**
 * Wait until a selector becomes visible, or a JS condition returns truthy.
 */
async function waitFor(selector, condition, timeoutMs = DEFAULT_TIMEOUT) {
  if (!selector && !condition) throw new Error('browser_wait_for 需要 selector 或 condition 参数')
  const wc = getWC()
  await ensureHelper()

  const deadline = Date.now() + timeoutMs
  let ok = false
  while (Date.now() < deadline) {
    if (selector) {
      ok = await safeEval(wc, `(function(){
        var el = window.__bt.resolveEl(${JSON.stringify(selector)});
        return !!el && window.__bt.isVisible(el);
      })()`, 3000).catch(() => false)
    } else {
      const wrapped = `(async () => { const arg = ${JSON.stringify(null)}; ${condition}\n })()`
      ok = !!(await safeEval(wc, wrapped, 3000).catch(() => false))
    }
    if (ok) break
    await sleep(200)
  }
  if (!ok) throw new Error(`等待条件超时 (${timeoutMs}ms)`)
  return { ok: true, selector: selector || null, waitedMs: timeoutMs - Math.max(0, deadline - Date.now()) }
}

// ============================================================
//  A4/A5：browser_flow —— 批量执行 + 断言 + 流程固化
//
//  动机（实测）：黑盒测试 20 步 = 40+ 次 LLM 往返（每步"看快照 → 决策 → 点 → 再看"），
//  而每份快照都永久留在上下文里。把一串**已经确定的**步骤交给主进程顺序执行，
//  往返降到 1~2 次；失败即停，并**附带失败时的快照**，省掉模型"再补看一眼"的往返。
//
//  A5：跑通的流程可以 saveAs 固化成 YAML，之后零 LLM 回放（回归期直接重跑）。
//  固化时会把 "ref=N" 反解成稳定选择器 —— ref 只是当次快照的句柄，写进文件下次必然失效。
// ============================================================
const FLOW_ACTIONS = [
  'goto', 'click', 'type', 'press', 'wait', 'sleep',
  'assertText', 'assertValue', 'assertVisible', 'assertUrl', 'assertEval',
]

// 流程名 → 安全 slug（同时用作目录名与文件名）
function safeSlug(name) {
  const s = String(name || '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return s || `flow-${Date.now()}`
}

function flowDir(slug) {
  return path.join(getTestOutputDir(), 'work', slug)
}

function flowFile(slug) {
  return path.join(flowDir(slug), `${slug}.flow.yaml`)
}

// 把 "ref=N" 反解成跨会话稳定的选择器（固化用）。非 ref 形式原样返回。
async function stabilizeTarget(target) {
  const t = String(target == null ? '' : target)
  if (!/^ref=\d+$/.test(t)) return target
  const wc = getWC()
  const sel = await safeEval(wc, `(function(){
    var el = window.__bt.resolveEl(${JSON.stringify(t)});
    return el ? (el.__btSel || null) : null;
  })()`, 5000).catch(() => null)
  return sel || target
}

async function runFlowAssert(action, step) {
  const wc = getWC()
  await ensureHelper()
  const code = `(function(){
    var action = ${JSON.stringify(action)};
    var target = ${JSON.stringify(step.target == null ? null : String(step.target))};
    var value = ${JSON.stringify(step.value == null ? null : step.value)};
    function norm(s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); }
    if (action === 'assertUrl') {
      var href = location.href;
      return { ok: value === null ? true : href.indexOf(String(value)) !== -1, actual: href };
    }
    if (action === 'assertEval') {
      var r;
      try { r = !!(new Function('return (' + value + ')')()); }
      catch (e) { return { ok: false, actual: 'eval 执行失败（可能被页面 CSP 拦截）：' + e.message }; }
      return { ok: !!r, actual: String(r) };
    }
    var el = window.__bt.resolveEl(target);
    if (!el) return { ok: false, actual: '元素未找到：' + target };
    var visible = window.__bt.isVisible(el);
    if (action === 'assertVisible') return { ok: visible, actual: visible ? '可见' : '元素存在但不可见' };
    if (!visible) return { ok: false, actual: '元素存在但不可见（尺寸为 0）' };
    if (action === 'assertValue') {
      var av = el.value !== undefined ? el.value : norm(el.textContent);
      return { ok: String(av) === String(value), expected: String(value), actual: String(av).slice(0, 200) };
    }
    var text = norm(el.innerText || el.textContent);
    return { ok: text.indexOf(String(value)) !== -1, expected: String(value), actual: text.slice(0, 200) };
  })()`
  const res = await safeEval(wc, code, 8000).catch((err) => ({ ok: false, actual: `断言执行失败：${err.message}` }))
  if (!res || !res.ok) {
    const parts = []
    if (res && res.expected !== undefined) parts.push(`期望包含 ${JSON.stringify(res.expected)}`)
    parts.push(`实际：${res && res.actual !== undefined ? res.actual : '（无返回）'}`)
    throw new Error(`断言未通过 — ${parts.join('，')}`)
  }
  return { actual: res.actual }
}

// 执行单步。复用既有的 click/type/press/waitFor/openBrowser，保证与单步工具行为一致。
async function runFlowStep(action, step) {
  if (action.indexOf('assert') === 0) return runFlowAssert(action, step)
  switch (action) {
    case 'goto': {
      const url = String(step.value != null ? step.value : (step.target || '')).trim()
      if (!url) throw new Error('goto 需要 value（目标 URL）')
      await openBrowser(url, step.timeoutMs || DEFAULT_TIMEOUT)
      return { url }
    }
    case 'click': {
      if (!step.target) throw new Error('click 需要 target')
      const r = await click(step.target, step.timeoutMs || 5000)
      return { tag: r.tag, text: r.text }
    }
    case 'type': {
      if (!step.target) throw new Error('type 需要 target')
      const r = await type(step.target, String(step.value == null ? '' : step.value))
      return { value: r.value }
    }
    case 'press': {
      const key = String(step.value != null ? step.value : (step.target || '')).trim()
      if (!key) throw new Error('press 需要 value（键名，如 Enter / Control+S）')
      await press(key)
      return { key }
    }
    case 'wait': {
      if (step.target) {
        await waitFor(step.target, null, step.timeoutMs || DEFAULT_TIMEOUT)
        return { waitedFor: 'selector' }
      }
      const ms = Math.max(0, Math.min(Number(step.value) || 500, 30000))
      await sleep(ms)
      return { waitedFor: `${ms}ms` }
    }
    case 'sleep': {
      const ms = Math.max(0, Math.min(Number(step.value) || 500, 30000))
      await sleep(ms)
      return { waitedFor: `${ms}ms` }
    }
    default:
      throw new Error(`未知 action：${action}`)
  }
}

async function currentUrl() {
  try {
    const wc = getWC()
    return (await safeEval(wc, 'location.href', 3000)) || ''
  } catch {
    return ''
  }
}

// ---------- YAML 固化（不引依赖：A 路线的前提就是零新依赖） ----------

function toYamlValue(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') + '"'
}

function buildFlowYaml(meta, steps) {
  const lines = []
  lines.push('# localAi 黑盒回归流程（由 browser_flow 固化，可零 LLM 回放）')
  lines.push(`# 回放：browser_flow({ flow: "${meta.slug}" })`)
  lines.push(`name: ${toYamlValue(meta.name)}`)
  if (meta.url) lines.push(`url: ${toYamlValue(meta.url)}`)
  lines.push(`generatedAt: ${toYamlValue(new Date().toISOString())}`)
  lines.push('steps:')
  for (const s of steps) {
    let first = true
    for (const k of ['action', 'target', 'value', 'note', 'timeoutMs']) {
      if (s[k] === undefined || s[k] === null || s[k] === '') continue
      lines.push(`${first ? '  - ' : '    '}${k}: ${toYamlValue(s[k])}`)
      first = false
    }
    if (first) lines.push('  - action: click')
  }
  return lines.join('\n') + '\n'
}

/**
 * 极简 YAML 子集解析器：只认 buildFlowYaml 产出的格式
 * （顶层 `key: value`、`steps:` 下 `  - key: value` 与 `    key: value`）。
 * 刻意不引 js-yaml —— A 路线的前提是零新依赖。调用方先试 JSON.parse 再走这里。
 */
function parseFlowYaml(text) {
  const out = { steps: [] }
  let cur = null
  const unquote = (raw) => {
    let v = String(raw).trim()
    if (!v) return ''
    if (v === 'null') return null
    if (v === 'true') return true
    if (v === 'false') return false
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
    if ((v.charAt(0) === '"' && v.slice(-1) === '"') || (v.charAt(0) === "'" && v.slice(-1) === "'")) {
      v = v.slice(1, -1)
      // 单次扫描反转义：分步 replace（先 \n 再 \" 再 \\）会把字面 "\\n" 误读成换行
      if (v.indexOf('\\') !== -1) {
        v = v.replace(/\\(.)/g, (_m, c) => (c === 'n' ? '\n' : c))
      }
    }
    return v
  }
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim() || line.trim().charAt(0) === '#') continue
    const itemM = line.match(/^\s*-\s+([A-Za-z0-9_]+)\s*:\s*(.*)$/)
    if (itemM) {
      cur = {}
      out.steps.push(cur)
      cur[itemM[1]] = unquote(itemM[2])
      continue
    }
    const kvM = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/)
    if (!kvM) continue
    if (kvM[1] === 'steps') { cur = null; continue }
    if (/^\s+\S/.test(line) && cur) cur[kvM[1]] = unquote(kvM[2])
    else { out[kvM[1]] = unquote(kvM[2]); cur = null }
  }
  return out
}

function loadFlow(slugOrPath) {
  const raw = String(slugOrPath || '').trim()
  if (!raw) throw new Error('需要 flow 名称或文件路径')
  const looksPath = /\.(ya?ml|json)$/i.test(raw)
  const file = looksPath && (path.isAbsolute(raw) || raw.indexOf('/') !== -1 || raw.indexOf('\\') !== -1)
    ? raw
    : flowFile(safeSlug(raw.replace(/\.(ya?ml|json)$/i, '')))
  if (!fs.existsSync(file)) throw new Error(`流程文件不存在：${file}`)
  const text = fs.readFileSync(file, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = parseFlowYaml(text)
  }
  const steps = parsed && Array.isArray(parsed.steps) ? parsed.steps : null
  if (!steps || !steps.length) throw new Error(`流程文件里没有可执行的 steps：${file}`)
  return { file, name: parsed.name || '', steps }
}

/**
 * 批量执行一组步骤（A4），可选固化落盘（A5）。
 * @param {object} opts
 * @param {Array}  [opts.steps]  内联步骤数组
 * @param {string} [opts.flow]   已固化的流程名/slug（与 steps 二选一），走零 LLM 回放
 * @param {string} [opts.saveAs] 跑完后固化的流程名
 * @param {string} [opts.name]   流程显示名
 * @param {boolean}[opts.stopOnFail] 失败即停（默认 true）
 */
async function runFlow(opts = {}) {
  let list = Array.isArray(opts.steps) ? opts.steps : null
  let loadedFrom = null
  let name = opts.name
  if (!list && opts.flow) {
    const lf = loadFlow(opts.flow)
    list = lf.steps
    loadedFrom = lf.file
    if (!name && lf.name) name = lf.name
  }
  if (!list || !list.length) throw new Error('browser_flow 需要 steps 数组，或 flow（已固化的流程名）')
  if (list.length > 100) throw new Error(`单次最多 100 步（收到 ${list.length} 步）`)

  const stop = opts.stopOnFail !== false
  const results = []
  let failedAt = null

  for (let i = 0; i < list.length; i++) {
    const step = list[i] || {}
    const action = String(step.action || '').trim()
    const t0 = Date.now()
    if (FLOW_ACTIONS.indexOf(action) === -1) {
      failedAt = { index: i, action, ok: false, ms: 0, error: `未知 action：${action}（可用：${FLOW_ACTIONS.join(' / ')}）` }
      results.push(failedAt)
      if (stop) break
      continue
    }
    try {
      const detail = await runFlowStep(action, step)
      results.push({ index: i, action, ok: true, ms: Date.now() - t0, ...(detail || {}) })
    } catch (err) {
      failedAt = { index: i, action, target: step.target || null, value: step.value, ok: false, ms: Date.now() - t0, error: err.message }
      results.push(failedAt)
      if (stop) break
    }
  }

  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  const out = {
    success: failed === 0 && results.length === list.length,
    total: list.length,
    executed: results.length,
    passed,
    failed,
    // 每步只回一行摘要：明细留给失败那步（成功步骤的明细对模型没用，白占 token）
    steps: results.map((r) => {
      const brief = { i: r.index, action: r.action, ok: r.ok, ms: r.ms }
      if (!r.ok) brief.error = r.error
      return brief
    }),
  }
  if (loadedFrom) out.loadedFrom = loadedFrom
  if (failedAt) {
    out.failedAt = failedAt
    // 失败即附带当前快照：省掉模型"再补看一眼页面"的那次往返（这正是往返成本的大头）
    try {
      out.snapshot = await snapshot(80)
    } catch (e) {
      out.snapshotError = e.message
    }
  }

  if (opts.saveAs) {
    try {
      const slug = safeSlug(opts.saveAs)
      const stable = []
      for (const s of list) {
        const item = { action: s.action }
        if (s.target !== undefined && s.target !== null) item.target = await stabilizeTarget(s.target)
        if (s.value !== undefined && s.value !== null) item.value = s.value
        if (s.note) item.note = s.note
        if (s.timeoutMs) item.timeoutMs = s.timeoutMs
        stable.push(item)
      }
      fs.mkdirSync(flowDir(slug), { recursive: true })
      const file = flowFile(slug)
      fs.writeFileSync(file, buildFlowYaml({ slug, name: name || slug, url: await currentUrl() }, stable), 'utf8')
      out.saved = { slug, file, steps: stable.length }
    } catch (e) {
      out.saveError = e.message
    }
  }
  return out
}

/**
 * Capture the VISIBLE VIEWPORT of the page (not the whole scrollable page) and save it to
 * <userData>/browser-screenshots/<name>.png. 返回值里除了路径，还有一份视觉载荷（part）——
 * 上层（tools/index.js）在「读图配置开启」时会把它暂存起来注入下一轮，模型因此能自己看这张截图。
 */
async function screenshot(name = 'page') {
  const wc = getWC()
  const image = await withTimeout(wc.capturePage(), 8000, '截图超时')
  const base = String(name || 'page').replace(/[^\w-]/g, '_').slice(0, 60)
  const dir = path.join(app.getPath('userData'), 'browser-screenshots')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${base}-${Date.now()}.png`)
  const png = image.toPNG()
  fs.writeFileSync(filePath, png)
  const size = image.getSize()
  // 顺手编码一份视觉载荷（上层按配置决定要不要真发给模型；不发给就用不到，代价只是几毫秒）。
  // ⚠️ 这里刻意用 JPEG 而不是 PNG：截图（尤其 2880 宽的整屏）转 PNG data URL 能到 1.5MB 二进制
  //    ≈ 2MB 字符，正好撞上 tool-images 的单轮字符预算被丢掉；JPEG q82 通常只有它的 1/5~1/10。
  // ⚠️ getSize() 返回**对象**，不是数组（写成 `const [w,h] = ...` 会抛，见 fs-safe 的注释）。
  const part = imagePartFromBuffer(png, 'image/jpeg')
  return { path: filePath, width: size.width, height: size.height, part }
}

// ---------- 页面取图（视觉模型输入，2026-10-05） ----------
// 背景：Chat Completions 的 tool 消息只能放字符串，所以工具抓到的图必须先编码成
// image_url part 交给上层（电子侧通道 electron/tool-images.js），再由 chat.js 注入
// **下一轮**的 user 消息。本函数只负责「拿到 part」，不做注入。
const DEFAULT_IMAGE_MAX = 3
const IMAGE_HARD_MAX = 4          // 与 fs-safe 的单条消息图片上限同口径
const IMG_MIN_SIDE = 48           // 小于这个边长的多是图标/角标
const IMG_MIN_AREA = 4000         // 再叠加面积闸门，拦掉细长条与 tracking pixel
const IMG_FETCH_TIMEOUT = 8000

// 页面侧取图脚本：单独抽出来并导出，好让单测用**假 DOM** 直接跑它。
// 为什么必须这么测：这是一段模板字符串，`node --check` 只校验外层字面量，**不会**校验里面的 JS ——
// 里面有语法错只会在页面侧静默失败（safeEval 的 catch 把异常吃掉），表现成
// 「页面里没有找到符合条件的图片」，排查时完全看不出是代码坏了。
async function collectImageCandidates(limit) {
  const wc = getWC()
  await ensureHelper()
  const code = buildImageCollectScript(limit)
  return safeEval(wc, code, 8000).catch((err) => ({ error: err.message }))
}

// 在页面上下文里挑候选图：优先级 = 视口内 > 渲染面积大。
// 懒加载图取 data-src / srcset（此时 img 还没真正加载，currentSrc 是空的），
// 这样"还没滚到"的图也能拿到真实地址。
function buildImageCollectScript(limit) {
  return `(function () {
    var MIN_SIDE = ${IMG_MIN_SIDE}, MIN_AREA = ${IMG_MIN_AREA}, LIMIT = ${limit};
    var vh = window.innerHeight || 800;
    function abs(u) { try { return new URL(u, document.baseURI || location.href).href } catch (e) { return '' } }
    var seen = {}, out = [];
    function add(rawUrl, alt, w, h, top, source) {
      var u = abs(String(rawUrl || '').trim());
      if (!u || u.indexOf('data:') === 0) return;
      if (!/^https?:/i.test(u)) return;
      if (seen[u]) return;
      w = w || 0; h = h || 0;
      if (w > 0 && h > 0 && (w < MIN_SIDE || h < MIN_SIDE || w * h < MIN_AREA)) return;
      seen[u] = 1;
      out.push({ url: u, alt: String(alt || '').replace(/\\s+/g, ' ').trim().slice(0, 120), w: w, h: h, top: top, source: source });
    }
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var el = imgs[i];
      var r = {};
      try { r = el.getBoundingClientRect() || {} } catch (e) { r = {} }
      var url = el.currentSrc || el.src || el.getAttribute('data-src') || el.getAttribute('data-original') || el.getAttribute('data-lazy-src') || '';
      if (!url) {
        var ss = el.getAttribute('srcset') || el.getAttribute('data-srcset') || '';
        if (ss) url = String(ss).split(',')[0].trim().split(/\\s+/)[0];
      }
      add(url, el.getAttribute('alt') || el.getAttribute('title'), el.naturalWidth || Math.round(r.width || 0), el.naturalHeight || Math.round(r.height || 0), Math.round(r.top || 0), 'img');
    }
    var metas = document.querySelectorAll('meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"]');
    for (var m = 0; m < metas.length; m++) add(metas[m].getAttribute('content'), 'og:image', 0, 0, 0, 'meta');
    out.sort(function (a, b) {
      var av = a.top >= -50 && a.top <= vh ? 1 : 0, bv = b.top >= -50 && b.top <= vh ? 1 : 0;
      if (av !== bv) return bv - av;
      return (b.w * b.h) - (a.w * a.h);
    });
    return { url: location.href, title: document.title || '', count: out.length, images: out.slice(0, LIMIT) };
  })()`
}

// 下载单张图并编码成 image_url part。
// 走测试窗口自己的 session.fetch —— 这是本方案的关键：**自带该站点的 cookie**，
// 所以登录态/鉴权图能拿到（纯 HTTP 抓取做不到），并显式带 Referer 绕防盗链。
async function fetchImagePart(wc, url, pageUrl) {
  const init = { headers: { Referer: pageUrl, Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8' } }
  const doFetch = typeof wc.session.fetch === 'function'
    ? wc.session.fetch(url, init)          // Electron >= 25：带 session cookie，且不受 CORS 限制
    : fetch(url, init)                      // 兜底：无 session.fetch 时用全局 fetch（丢 cookie）
  const res = await withTimeout(doFetch, IMG_FETCH_TIMEOUT, `图片下载超时（${IMG_FETCH_TIMEOUT}ms）`)
  if (!res || !res.ok) throw new Error(`HTTP ${(res && res.status) || '?'}`)
  const ctype = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!/^image\//.test(ctype)) throw new Error(`不是图片（content-type: ${ctype || '未知'}）`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) throw new Error('图片内容为空')
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片过大（${Math.round(buf.length / 1024 / 1024)}MB > 10MB）`)
  const part = imagePartFromBuffer(buf, ctype)
  if (!part) throw new Error(`无法解码该图片格式（${ctype}）`)
  return { part, bytes: buf.length }
}

function imageLabel(alt, w, h, url, index) {
  const name = String(alt || '').replace(/\s+/g, ' ').trim().slice(0, 60) || `页面图片 ${index}`
  const size = w && h ? `${w}×${h}` : '尺寸未知'
  return `${name}（${size}）— ${url}`
}

/**
 * 抓当前测试页面的图片，编码成可直接喂给视觉模型的 image_url part。
 * 图片本体通过返回值的 parts 交给上层（由 tools/index.js 暂存、chat.js 注入下一轮 user 消息）。
 * @param {object} [opts]
 * @param {number} [opts.max] 最多取几张（默认 3，上限 4）
 * @returns {Promise<object>} { url, title, total, images, parts, skipped, note }
 */
async function readImages({ max } = {}) {
  const wc = getWC()
  const limit = Math.max(1, Math.min(Number(max) || DEFAULT_IMAGE_MAX, IMAGE_HARD_MAX))
  const page = await collectImageCandidates(limit)
  if (page && page.error) throw new Error(`读取页面图片失败：${page.error}`)
  const candidates = (page && page.images) || []
  const pageUrl = (page && page.url) || wc.getURL()

  const images = []
  const parts = []
  const skipped = []
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    const label = imageLabel(c.alt, c.w, c.h, c.url, i + 1)
    try {
      const { part, bytes } = await fetchImagePart(wc, c.url, pageUrl)
      images.push({
        index: parts.length + 1,
        url: c.url,
        alt: c.alt,
        width: c.w,
        height: c.h,
        source: c.source,
        bytes,
      })
      parts.push({ label, part })
    } catch (err) {
      skipped.push({ url: c.url, reason: err.message })
    }
  }

  let note
  if (parts.length > 0) {
    note = `已把 ${parts.length} 张图作为图像发给你（见下一条消息），你现在能直接看到它们。`
      + (candidates.length > parts.length ? `另有 ${candidates.length - parts.length} 张候选图未能取回（见 skipped）。` : '')
  } else if (candidates.length > 0) {
    note = `页面里找到 ${candidates.length} 张候选图，但一张都没能取回（见 skipped 的原因：多为鉴权/防盗链/格式不支持）。`
  } else {
    note = '页面里没有找到符合条件的图片（可能全是小图标 / 背景图 / canvas 绘制，这类图本工具取不到）。'
  }
  return { url: pageUrl, title: (page && page.title) || '', total: (page && page.count) || 0, images, parts, skipped, note }
}

/**
 * Read recent console messages from the test page.
 */
function consoleLogs(limit = 50, type, clear) {
  let entries = consoleBuffer
  if (type) {
    const t = String(type).toLowerCase()
    entries = entries.filter((e) => e.type === t)
  }
  const out = entries.slice(-Math.max(1, Math.min(Number(limit) || 50, 500)))
  if (clear) consoleBuffer = []
  return { count: out.length, entries: out }
}

/**
 * Close the test browser window.
 */
function closeBrowser() {
  if (testWindow && !testWindow.isDestroyed()) {
    testWindow.destroy()
  }
  testWindow = null
  consoleBuffer = []
  lastLoadError = null
  return { closed: true }
}

/**
 * Current test-browser state (used internally / by browser_open).
 */
function getState() {
  if (!testWindow || testWindow.isDestroyed()) return { open: false }
  const wc = testWindow.webContents
  return {
    open: true,
    url: wc.getURL(),
    title: testWindow.getTitle(),
    isLoading: wc.isLoading(),
    screenshotsDir: path.join(app.getPath('userData'), 'browser-screenshots'),
  }
}

module.exports = {
  openBrowser,
  getPage,
  snapshot,
  click,
  type,
  press,
  evalJs,
  waitFor,
  screenshot,
  readImages,
  consoleLogs,
  closeBrowser,
  getState,
  waitForDownload,
  // A4/A5：批量执行 + 固化回放。导出内部件供 tests/browser-flow.test.js 直接断言。
  runFlow,
  loadFlow,
  parseFlowYaml,
  buildFlowYaml,
  safeSlug,
  FLOW_ACTIONS,
  // 注入到页面上下文的脚本源码。导出仅供自检：它是一段模板字符串，
  // `node --check` 只校验外层模板字面量，**不会**校验里面的 JS ——
  // 内部语法错误只会在页面侧静默失败。自检脚本用 new Function(INJECT_SRC) 兜住这一层。
  INJECT_SRC,
  // 取图脚本同理，且多一个用途：单测用假 DOM 直接跑它，验证过滤/排序/去重逻辑
  // （tests/browser-page-images.test.js）。改这段 JS 时务必跑那个测试。
  buildImageCollectScript,
  IMG_MIN_SIDE,
  IMG_MIN_AREA,
}
