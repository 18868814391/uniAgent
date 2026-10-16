// ============================================================
//  Local AI Open —— 主进程装配器
//  启动时序:加载配置 → 注册各域 IPC → 建窗 → 检查更新。
//  领域逻辑已拆分到 settings / context / conversations / chat /
//  tools/* 等模块,本文件只做装配与生命周期。
// ============================================================
const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { autoUpdater } = require('electron-updater')
const log = require('electron-log')

// ============================================================
//  应用身份（开源版）—— 与企业版**完全隔离**，两者可同时安装、各自独立运行
//   1) app.setName         → userData 目录名 / 窗口与通知里的应用名
//   2) setPath('userData') → **必须显式指定**：否则会与企业版共用同一个 %APPDATA% 目录，
//                            配置 / 会话记录 / 归档会互相覆盖
//   3) setAppUserModelId   → 任务栏图标分组与系统通知归属（须与 electron-builder.yml 的 appId 一致）
//  ⚠️ 二次开发请改成你自己的标识（全局唯一即可），并同步 electron-builder.yml。
// ============================================================
app.setName('Local AI Open')
app.setPath('userData', require('path').join(app.getPath('appData'), 'Local AI Open'))

const state = require('./state')
const settings = require('./settings')
const conversations = require('./conversations')
const netHealth = require('./net-health')
const fsSafe = require('./tools/fs-safe')
const chat = require('./chat')
const windows = require('./windows')

const APP_NAME = settings.APP_NAME

// Windows 通知归属标识（AppUserModelID），必须与 electron-builder.yml 的 appId 一致。
// 不设它的话，系统通知（任务完成提醒）会挂在 "electron.app.xxx" 名下、通知中心里显示的
// 是 Electron 而不是本应用，且打包版可能因 AUMID 与安装快捷方式不匹配而**完全不弹**。
// 只在 Windows 上设；其它平台无此概念。
if (process.platform === 'win32') app.setAppUserModelId('com.localai.open')

// 字节 → 人类可读（用于更新日志与前端展示）
function formatBytes(n) {
  if (!n || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

// ========== 更新相关 IPC（供前端「应用更新」面板调用）============
// 当前已安装版本号
ipcMain.handle('app:getVersion', () => app.getVersion())

// 打开 DevTools（开发调试用）
ipcMain.handle('app:openDevTools', () => {
  if (state.mainWindow && state.mainWindow.webContents) {
    state.mainWindow.webContents.openDevTools({ mode: 'right' })
  }
})

// 手动触发一次更新检查（dev 模式无 app-update.yml，直接返回 dev）
ipcMain.handle('app:checkForUpdates', async () => {
  if (!app.isPackaged) {
    log.warn('[autoUpdater] dev 模式不支持检查更新')
    // 关键：dev 模式下 setupAutoUpdater 不会注册任何事件监听，
    // 必须主动推一个错误事件给前端，否则 UI 会永久停在「检查中...」
    if (state.mainWindow) {
      state.mainWindow.webContents.send('app:updateError', {
        message: '当前为开发模式(未打包)，不检查更新；请打包后再测试增量更新。',
      })
    }
    return { ok: false, reason: 'dev' }
  }
  try {
    await autoUpdater.checkForUpdates()
    return { ok: true }
  } catch (err) {
    const msg = err.message || String(err)
    log.error('[autoUpdater] 手动检查失败:', msg)
    // 打包模式下 autoUpdater 的 error 事件通常会另行推送 app:updateError；
    // 这里兜底再推一次，确保前端一定能复位。
    if (state.mainWindow) {
      state.mainWindow.webContents.send('app:updateError', { message: msg })
    }
    return { ok: false, reason: msg }
  }
})


// ============================================================
//  Auto updater — 检查服务器 new-version 清单，询问用户后下载并安装
// ============================================================
function setupAutoUpdater() {
  // dev 模式下不检查更新（app-update.yml 只存在于打包产物里）
  if (!app.isPackaged) {
    log.info('[autoUpdater] dev 模式，跳过更新检查')
    return
  }

  // 下载与安装都由用户确认后才进行
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  // 用 electron-log 接管 updater 日志：同时输出到终端与文件，
  // 差分/全量回退的关键信息（如 "Full: X, To download: Y (Z%)" / "fallback to full download"）
  // 都会落到日志，便于在 UI 之外也能排查更新行为。
  autoUpdater.logger = log
  log.transports.file.level = 'info'
  log.transports.console.level = 'info'
  log.info('[autoUpdater] 初始化完成，差分(增量)更新已开启')

  // 整包大小(字节)：在 update-available 时从 info.files 取出，
  // 用于 download-progress 判断「本次是增量还是全量」。
  let updateFullSize = 0

  // 增量(差分)更新：electron-updater 对 NSIS 安装包默认开启，
  // 依据「旧安装包 + 新旧 blockmap」只下载变化的字节块，而非整包。
  // 要真正生效，发布服务器必须满足两点（已对本项目服务器验证）：
  //   1) 保留历史版本的 *.blockmap（如 local-ai-1.0.2-Setup.exe.blockmap），
  //      不能只留最新版，否则该版本用户会回退到全量下载；
  //   2) 支持 HTTP Range 请求（nginx 已验证支持单段/多段 206 Partial Content）。
  // 任一不满足时 updater 会打印 "fallback to full download" 并自动全量下载。
  // 另：安装时 NSIS 会把 installer.exe 缓存到 %LOCALAPPDATA%/local-ai-updater/，
  // 该缓存被删也会让下一次更新退化为全量。
  autoUpdater.disableDifferentialDownload = false

  autoUpdater.on('checking-for-update', () => {
    log.info('[autoUpdater] 正在检查更新...')
    if (state.mainWindow) state.mainWindow.webContents.send('app:updateChecking')
  })

  autoUpdater.on('update-available', async (info) => {
    log.info(`[autoUpdater] 发现新版本 v${info.version}`)
    // 记录整包大小（字节），供 download-progress 判断增量/全量
    const fileInfo = (info.files || []).find(f => String(f.url).endsWith('.exe')) || (info.files || [])[0]
    updateFullSize = fileInfo && fileInfo.size ? fileInfo.size : 0
    const win = state.mainWindow
    if (win) win.webContents.send('app:updateAvailable', { version: info.version, fullSize: updateFullSize })
    if (!win) return
    // 构建弹窗详情：当前版本 + 更新内容（releaseNotes 为 electron-updater 原生字段）
    const parts = [`当前版本：v${app.getVersion()}`]
    if (info.releaseNotes) {
      parts.push('', '更新内容：', info.releaseNotes)
    }
    parts.push('', '是否立即下载并安装更新？')
    const result = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['稍后', '立即更新'],
      defaultId: 1,
      cancelId: 0,
      message: `发现新版本 v${info.version}`,
      detail: parts.join('\n'),
      title: '软件更新',
    })
    if (result.response === 1) {
      try {
        await autoUpdater.downloadUpdate()
      } catch (err) {
        log.error('[autoUpdater] download error:', err.message || err)
      }
    }
  })

  autoUpdater.on('update-not-available', (info) => {
    log.info('[autoUpdater] 已是最新版本')
    if (state.mainWindow) state.mainWindow.webContents.send('app:updateNotAvailable', { version: info && info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent || 0)
    // progress 字段含义（已读 electron-updater 源码确认）：
    //   transferred —— 本次实际从网络下载的字节（差分模式下不含从磁盘 COPY 的部分）
    //   total       —— 本次「实际要下载的总量」：增量时 = 变化块总和(远小于整包)，全量时 = 整包大小
    //   fullSize    —— 完整安装包大小（来自 update-available 的 info.files[].size）
    // 因此 total 显著小于 fullSize 即说明本次走的是增量(差分)更新。
    const transferred = progress.transferred || 0
    const total = progress.total || 0
    const bytesPerSecond = progress.bytesPerSecond || 0
    const isIncremental = updateFullSize > 0 && total > 0 && total < updateFullSize * 0.85
    const downloadRatio = updateFullSize > 0 ? total / updateFullSize : 0
    log.info(
      `[autoUpdater] 下载 ${percent}% | 已下载 ${formatBytes(transferred)} / 整包 ${formatBytes(updateFullSize)} | ` +
      `${isIncremental ? `增量(仅传输 ${(downloadRatio * 100).toFixed(1)}%)` : '全量'}`
    )
    if (state.mainWindow) {
      // 原生窗口标题栏：百分比 + 已下载/整包大小 + 速度 + 增量标识，与设置页进度展示保持一致
      // 分母优先用整包大小(updateFullSize)，未知时退回本次实际下载总量(total)
      const denomSize = updateFullSize > 0 ? updateFullSize : total
      const sizeText = `已下载 ${formatBytes(transferred)} / 整包 ${formatBytes(denomSize)}`
      const speedText = bytesPerSecond > 0 ? ` · ${formatBytes(bytesPerSecond)}/s` : ''
      const typeText = isIncremental ? ' · 增量' : ''
      state.mainWindow.setTitle(`${APP_NAME} - 更新中 ${percent}% · ${sizeText}${typeText}${speedText}`)
      state.mainWindow.webContents.send('app:updateProgress', {
        percent,
        transferred,
        total,
        fullSize: updateFullSize,
        bytesPerSecond,
        isIncremental,
        downloadRatio,
      })
    }
  })

  autoUpdater.on('update-downloaded', async (info) => {
    log.info(`[autoUpdater] 更新下载完成：v${info.version}`)
    const win = state.mainWindow
    if (win) {
      win.setTitle(APP_NAME)
      win.webContents.send('app:updateDownloaded', { version: info.version })
    }
    if (!win) {
      // 窗口已关闭，直接静默安装并重启新版本
      autoUpdater.quitAndInstall(true, true)
      return
    }
    const result = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['稍后', '立即重启'],
      defaultId: 1,
      cancelId: 0,
      message: '新版本已下载完成',
      detail: '重启应用即可完成安装，期间应用会自动关闭并重新打开。',
      title: '软件更新',
    })
    if (result.response === 1) {
      autoUpdater.quitAndInstall(true, true)
    }
  })

  autoUpdater.on('error', (err) => {
    // 检查/下载失败静默处理，不影响正常使用
    log.error('[autoUpdater] error:', err.message || err)
    if (state.mainWindow) state.mainWindow.webContents.send('app:updateError', { message: err.message || String(err) })
  })

  // 开源版默认**不配置发布源**（electron-builder.yml 里 publish 段被注释），因此不做启动自动检查，
  // 否则每次启动都会去请求一个不存在的更新服务器。二次开发接入自己的发布源后，把下面几行恢复即可。
  // setTimeout(() => {
  //   autoUpdater.checkForUpdates().catch((err) => {
  //     log.error('[autoUpdater] checkForUpdates failed:', err.message || err)
  //   })
  // }, 3000)
}

// ============================================================
//  App lifecycle
// ============================================================
app.whenReady().then(() => {
  settings.loadSettings()
  settings.ensureDir(state.settings.skillsDir)
  settings.ensureDir(state.settings.memoryDir)
  settings.ensureDir(settings.getProductOutputDir())
  settings.ensureDir(settings.getTestOutputDir())
  settings.ensureDir(settings.getExcelOutputDir())
  // 清扫 Excel/本地任务临时工作目录(.xl-work)里的孤儿目录与散落文件：上次 app 异常退出时
  // 未能延迟删除的残留（仅删 .xl-work 内超过 1 天的条目，不碰用户业务文件）
  const xlWork = require('./xl-work')
  xlWork.sweepOrphanWorkDirs()
  // 清扫上次运行遗留的「孤儿脚本进程」（bash → py.exe → python.exe 整条链）：
  // 应用异常退出/被重启时，execFile 的超时定时器随主进程消失，
  // 而 before-quit 的 killAllChildren 只在正常退出路径上跑 —— 实测残留过占 6GB 的 python。
  // 延迟 3 秒异步做，不抢启动时的资源；失败只记日志，绝不影响启动。
  setTimeout(() => {
    require('./tools/orphan-cleanup')
      .killOrphanScriptProcesses()
      .then((res) => {
        if (res.found > 0) console.log(`[startup] cleaned ${res.found} orphan script process(es): ${res.killed.join(', ')}`)
        else if (res.error) console.warn('[startup] orphan cleanup failed:', res.error)
      })
      .catch(() => {})
  }, 3000)
  // 各域 IPC 注册（顺序无强依赖，均幂等）
  settings.registerIpc()
  conversations.registerIpc()
  fsSafe.registerIpc()
  chat.registerIpc()
  // 网络健康探测：周期性对当前活动端点做轻量连通检查，结论推给右上角状态点
  netHealth.registerIpc()

  // 通用网络请求 IPC：绕过 Chromium 安全限制（SSL 证书、CORS 等），由 Node.js 发起
  // 自动跟随 301/302 重定向，HTTPS 侧不校验证书（内部服务器证书过期场景）
  ipcMain.handle('network:fetchJson', async (_event, { url, method = 'GET', headers = {}, body, maxRedirects = 5 }) => {
    function doRequest(targetUrl, redirectCount) {
      const parsed = new URL(targetUrl)
      const isHttps = parsed.protocol === 'https:'
      const mod = isHttps ? require('https') : require('http')
      return new Promise((resolve, reject) => {
        const req = mod.request({
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
          rejectUnauthorized: false, // 内部服务器，跳过证书校验
        }, (res) => {
          // 跟随 301/302/307/308 重定向
          if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
            if (redirectCount >= maxRedirects) return reject(new Error('重定向次数过多'))
            const next = new URL(res.headers.location, targetUrl).href
            res.resume() // 丢弃 body
            return doRequest(next, redirectCount + 1).then(resolve, reject)
          }
          let data = ''
          res.on('data', (chunk) => { data += chunk })
          res.on('end', () => {
            try { resolve(JSON.parse(data)) }
            catch { reject(new Error(`响应不是 JSON: ${data.slice(0, 200)}`)) }
          })
        })
        req.on('error', reject)
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')) })
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body))
        req.end()
      })
    }
    return doRequest(url, 0)
  })
  windows.createWindow()
  setupAutoUpdater()


  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windows.createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  chat.resolvePendingAskAsCancelled()
  netHealth.stop()
  require('./browser-test').closeBrowser()
  // 强杀所有仍在运行的子进程（Python/bash 等），防止孤儿进程占用磁盘和内存
  try { require('./tools/shell').killAllChildren() } catch {}
})