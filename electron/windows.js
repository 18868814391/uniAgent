// ============================================================
//  窗口创建与加固 —— 主窗口 / md 预览窗口共用的安全处理
//  主窗口由 main.js 在 app ready 后调用 createWindow() 创建,
//  md 预览窗口由 tools/fs-safe.js 的 md-preview:open 创建。
// ============================================================
const { BrowserWindow, Menu, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const state = require('./state')

const APP_NAME = 'Local AI Open'

// 应用图标：优先用打包内置的 icon.ico，dev 模式同样可用；缺失时退回 exe 自身图标
function resolveIcon() {
  const candidates = [
    path.join(__dirname, '..', 'build', 'icon.ico'),
    path.join(__dirname, 'icon.ico'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return undefined
}

const APP_ICON = resolveIcon()

// 安全加固：禁止窗口内的链接把窗口导航走（主窗口与 md 预览窗口共用）
// - window.open / target=_blank → 一律拦截，http(s) 交给系统浏览器
// - 页面内跳转（点击链接、location 变更）→ 拦截；纯锚点（#xxx）与首次加载不受影响
function hardenWindow(win) {
  if (!win || !win.webContents) return
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL()
    if (url === current) return
    if (url.split('#')[0] === current.split('#')[0]) return // 纯锚点跳转，放行
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })
}

function createWindow() {
  state.mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: APP_NAME,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  })

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    state.mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    state.mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // 移除默认的窗口菜单栏 (File, Edit, View, Windows, Help)
  Menu.setApplicationMenu(null)

  hardenWindow(state.mainWindow)

  state.mainWindow.once('ready-to-show', () => {
    state.mainWindow.show()
  })

  state.mainWindow.on('closed', () => {
    // 窗口关闭：解除所有挂起的 ask_user、中止所有会话的运行，避免工具循环永久等待
    const { resolvePendingAskAsCancelled } = require('./chat')
    resolvePendingAskAsCancelled()
    for (const r of state.chatRuns.values()) r.controller.abort()
    state.chatRuns.clear()
    state.mainWindow = null
  })
}

module.exports = { hardenWindow, createWindow, APP_NAME }