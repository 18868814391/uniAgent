const { contextBridge, ipcRenderer } = require('electron')

/**
 * Expose a safe API to the renderer process via contextBridge.
 * The renderer accesses these as window.electronAPI.xxx
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // ========== Settings ==========
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getFullSettings: () => ipcRenderer.invoke('settings:getFull'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  testConnection: (key, baseUrl, model) => ipcRenderer.invoke('settings:testConnection', key, baseUrl, model),
  // ========== File Operations ==========
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('file:write', filePath, content),
  listDirectory: (dirPath) => ipcRenderer.invoke('file:list', dirPath),
  deleteFile: (filePath) => ipcRenderer.invoke('file:delete', filePath),
  // 用系统默认程序打开本地文件（校验授权目录，xlsx→Excel）
  openPath: (filePath) => ipcRenderer.invoke('file:openPath', filePath),
  // 在独立 BrowserWindow 中打开 md 预览（免登录最小入口，?view=md&path=...）
  openMdPreview: (filePath) => ipcRenderer.invoke('md-preview:open', filePath),

  // ========== Dialog ==========
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  selectFiles: () => ipcRenderer.invoke('dialog:selectFiles'),
  showConfirmDialog: (message) => ipcRenderer.invoke('dialog:confirm', message),

  // ========== Network (Node.js 侧发请求，绕过 Chromium 限制) ==========
  fetchJson: (opts) => ipcRenderer.invoke('network:fetchJson', opts),

  // ========== 网络健康（右上角状态点） ==========
  // 主进程周期性探测当前活动端点的连通质量，结论经 net-health:update 推送
  getNetHealth: () => ipcRenderer.invoke('net-health:get'),
  // 立刻重新探测一次（用户点状态点 / 聊天报错后）
  checkNetHealth: () => ipcRenderer.invoke('net-health:check'),
  // 用户主动清掉「网络异常」警告（关气泡；或重新检测后确认已恢复）
  clearNetHealthFailure: () => ipcRenderer.invoke('net-health:clearFailure'),
  onNetHealth: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('net-health:update', handler)
    return () => ipcRenderer.removeListener('net-health:update', handler)
  },

  // ========== File Attachments (导入文件) ==========
  attachFiles: (paths) => ipcRenderer.invoke('attachments:register', paths),
  detachFile: (path) => ipcRenderer.invoke('attachments:unregister', path),
  clearAttachments: () => ipcRenderer.invoke('attachments:clear'),
  // 粘贴/拖拽的图片：渲染层只有 data URL（剪贴板与拖拽都拿不到本地路径），
  // 交给主进程落盘成真实文件并授予读取权限，返回 [{ path, name, index }]
  savePastedImages: (convId, dataUrls) => ipcRenderer.invoke('attachments:savePastedImages', convId, dataUrls),
  // 图片附件缩略图：主进程按已授权路径从文件生成 96px 宽的 PNG data URL，
  // 返回 { thumbs: { [path]: dataUrl } }（导入 / 粘贴 / 拖拽三种入口共用）
  imageThumbnails: (paths) => ipcRenderer.invoke('attachments:thumbnails', paths),

  // ========== External ==========
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // ========== Conversations ==========
  listConversations: () => ipcRenderer.invoke('conversations:list'),
  searchConversations: (query) => ipcRenderer.invoke('conversations:search', query),
  createConversation: () => ipcRenderer.invoke('conversations:create'),
  deleteConversation: (id) => ipcRenderer.invoke('conversations:delete', id),
  renameConversation: (id, title) => ipcRenderer.invoke('conversations:rename', id, title),
  // 会话标记色（侧栏色点）：flag 为 '#RRGGBB'，传 null 取消标记
  setConversationFlag: (id, flag) => ipcRenderer.invoke('conversations:setFlag', id, flag),
  // 归档会话为 Markdown（落 userData/archives/），主进程写完后弹原生对话框告知路径。
  // messages 传渲染层内存里的消息（可缺省，缺省时主进程读磁盘消息文件）
  archiveConversation: (id, messages) => ipcRenderer.invoke('conversations:archive', id, messages),
  getConversationMessages: (id) => ipcRenderer.invoke('conversations:getMessages', id),
  saveConversationMessages: (id, messages, convMeta) => ipcRenderer.invoke('conversations:saveMessages', id, messages, convMeta),
  onConversationsChanged: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('conversations:changed', handler)
    return () => ipcRenderer.removeListener('conversations:changed', handler)
  },

  // ========== Model Profiles ==========
  listModelProfiles: () => ipcRenderer.invoke('profiles:list'),
  createModelProfile: (name) => ipcRenderer.invoke('profiles:create', name),
  // 「立即试用」专用：由主进程写入下发的试用参数并打上 trial 标记（该配置只读，只能删除）
  setupTrialProfile: (data) => ipcRenderer.invoke('profiles:setupTrial', data),
  updateModelProfile: (id, patch) => ipcRenderer.invoke('profiles:update', id, patch),
  deleteModelProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  setActiveModelProfile: (id) => ipcRenderer.invoke('profiles:setActive', id),
  testModelProfile: (id, patch) => ipcRenderer.invoke('profiles:test', id, patch),

  // conversationId 标识本次请求归属的会话 —— 多会话可并发，互不影响
  // resumeTurn：本次是「继续」按钮发起的断点续跑（主进程命中快照时直接回放上一轮的工具结果，不重跑）
  sendChat: (conversationId, messages, profileId, enableWebSearch, autoExecute, attachedFiles, resumeTurn, resumeNote) => ipcRenderer.invoke('chat:send', { conversationId, messages, profileId, enableWebSearch, autoExecute, attachedFiles, resumeTurn, resumeNote }),
  // 真正取消主进程指定会话的流式请求（配合"中断"按钮，只影响该会话）
  stopChat: (conversationId) => ipcRenderer.send('chat:stop', conversationId),
  // 该会话是否留有可从断点续跑的快照（用户主动中断后用于决定要不要给「继续」入口）
  canResume: (conversationId) => ipcRenderer.invoke('chat:canResume', conversationId),
  // 回答 AI 的 ask_user 提问（主进程等待此回答后继续工具循环）
  answerAskUser: (payload) => ipcRenderer.send('chat:askUserAnswer', payload),

  // --- Chat event listeners ---
  onChatChunk: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('chat:chunk', handler)
    return () => ipcRenderer.removeListener('chat:chunk', handler)
  },
  onChatTool: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('chat:tool', handler)
    return () => ipcRenderer.removeListener('chat:tool', handler)
  },
  // 正文纠正：模型把工具调用写成正文时，主进程已把这坨 XML 流式推给渲染层，
  // 还原成结构化调用后用它整体替换 currentAssistantMessage，避免界面上残留标签。
  onChatContentReset: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('chat:content_reset', handler)
    return () => ipcRenderer.removeListener('chat:content_reset', handler)
  },
  onChatDone: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('chat:done', handler)
    return () => ipcRenderer.removeListener('chat:done', handler)
  },
  onChatError: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('chat:error', handler)
    return () => ipcRenderer.removeListener('chat:error', handler)
  },
  onChatStatus: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('chat:status', handler)
    return () => ipcRenderer.removeListener('chat:status', handler)
  },
  onChatContext: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('chat:context', handler)
    return () => ipcRenderer.removeListener('chat:context', handler)
  },
  onChatReasoning: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('chat:reasoning', handler)
    return () => ipcRenderer.removeListener('chat:reasoning', handler)
  },
  onAskUser: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('chat:ask', handler)
    return () => ipcRenderer.removeListener('chat:ask', handler)
  },
  onChatSubAgent: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('chat:subagent', handler)
    return () => ipcRenderer.removeListener('chat:subagent', handler)
  },

  // ========== System Info & Downloads ==========
  getSystemInfo: () => ipcRenderer.invoke('system:getInfo'),
  downloadNode: () => ipcRenderer.invoke('system:downloadNode'),
  downloadPython: () => ipcRenderer.invoke('system:downloadPython'),
  downloadGit: () => ipcRenderer.invoke('system:downloadGit'),
  downloadXlsxEnv: () => ipcRenderer.invoke('system:downloadXlsxEnv'),
  downloadLibreOffice: () => ipcRenderer.invoke('system:downloadLibreOffice'),
  onDownloadProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('system:downloadProgress', handler)
    return () => ipcRenderer.removeListener('system:downloadProgress', handler)
  },

  // ========== App Update ==========
  // 当前已安装版本号
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  // 打开 DevTools（开发调试用）
  openDevTools: () => ipcRenderer.invoke('app:openDevTools'),
  // 手动触发一次更新检查
  checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
  // 应用自更新下载进度（主进程通过 app:updateProgress 推送）
  onUpdateProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('app:updateProgress', handler)
    return () => ipcRenderer.removeListener('app:updateProgress', handler)
  },
  onUpdateChecking: (callback) => {
    const handler = (_event) => callback()
    ipcRenderer.on('app:updateChecking', handler)
    return () => ipcRenderer.removeListener('app:updateChecking', handler)
  },
  onUpdateAvailable: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('app:updateAvailable', handler)
    return () => ipcRenderer.removeListener('app:updateAvailable', handler)
  },
  onUpdateNotAvailable: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('app:updateNotAvailable', handler)
    return () => ipcRenderer.removeListener('app:updateNotAvailable', handler)
  },
  onUpdateDownloaded: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('app:updateDownloaded', handler)
    return () => ipcRenderer.removeListener('app:updateDownloaded', handler)
  },
  onUpdateError: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('app:updateError', handler)
    return () => ipcRenderer.removeListener('app:updateError', handler)
  },
})
