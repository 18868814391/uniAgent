import { defineStore } from 'pinia'
import { ref, computed, watch, reactive } from 'vue'

// 「继续」按钮发出的固定指令文本。单独提出来是因为它现在有两种用法：
// 裸点「继续」直接用；带补充说明时作为正文前缀，后面再拼【本次补充说明】。
const CONTINUE_PROMPT = '请继续完成你刚才正在进行的任务，不要重复已完成的步骤，直接继续执行。'

export const useAppStore = defineStore('app', () => {
  // ========== Settings ==========
  const settings = ref({
    apiKey: '',
    hasApiKey: false,
    model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com/v1',
    contextWindow: 1024 * 1024,
    modelProfiles: [],
    activeProfileId: 'deepseek-default',
    skillsDir: '',
    memoryDir: '',
    allowedDirs: [],
    role: 'general',
  })

  const showSettings = ref(false)
  const apiKeyConfigured = computed(() => !!settings.value.hasApiKey || !!settings.value.apiKey)
  const modelProfiles = computed(() => settings.value.modelProfiles || [])
  const activeProfileId = computed(() => settings.value.activeProfileId || 'deepseek-default')
  const activeProfile = computed(() => modelProfiles.value.find((p) => p.id === activeProfileId.value) || modelProfiles.value[0] || null)

  // ========== 网络健康（右上角状态点） ==========
  // 探测在主进程做（net-health.js，周期 25~45s），这里只负责「取一次初值 + 订阅推送 + 手动触发」。
  // state: 'unknown' | 'good' | 'degraded' | 'bad' | 'unconfigured'
  // 说明：网络差时状态点要变黄/变红并弹气泡，所以这里只存**结论**，文案由组件拼。
  const netHealth = ref({ state: 'unknown', configured: false, checkedAt: null })
  let netHealthRegistered = false

  function registerNetHealth() {
    if (netHealthRegistered) return
    if (!window.electronAPI || !window.electronAPI.onNetHealth) return
    netHealthRegistered = true
    window.electronAPI.onNetHealth((data) => {
      if (data && typeof data === 'object') netHealth.value = data
    })
  }

  // 换了模型 / 改了当前 profile 的 Base URL → 立刻重探一次。
  // 探测目标本来就是每轮现读 settings.getActiveProfile()（不写死域名），但**定时器**仍按
  // 上一轮的间隔走，不补这一下的话状态点会继续显示上一个端点的结论，最长滞后 45s。
  // 同时盯 baseUrl：改地址时 activeProfileId 不变，只看 id 会漏。
  watch(
    () => `${activeProfileId.value}|${(activeProfile.value && activeProfile.value.baseUrl) || ''}`,
    () => {
      refreshNetHealth(true).catch(() => {})
    }
  )

  // force=true → 立刻重新探测（用户点状态点、或聊天报错后调用）；否则只取当前结论
  async function refreshNetHealth(force = false) {
    if (!window.electronAPI || !window.electronAPI.getNetHealth) return netHealth.value
    registerNetHealth()
    try {
      const data =
        force && window.electronAPI.checkNetHealth
          ? await window.electronAPI.checkNetHealth()
          : await window.electronAPI.getNetHealth()
      if (data && typeof data === 'object') netHealth.value = data
    } catch (e) {
      console.error('[net-health] refresh failed:', e)
    }
    return netHealth.value
  }

  // 用户主动清掉「网络异常」警告 —— 警告态**只有**这两条退出路径（都是用户动作）：
  // 关气泡、或点「重新检测」后确认已恢复。别加定时器自动清，第一版就是这么错的。
  async function clearNetHealthFailure() {
    if (!window.electronAPI || !window.electronAPI.clearNetHealthFailure) return netHealth.value
    try {
      const data = await window.electronAPI.clearNetHealthFailure()
      if (data && typeof data === 'object') netHealth.value = data
    } catch (e) {
      console.error('[net-health] clear failure failed:', e)
    }
    return netHealth.value
  }

  async function loadSettings() {
    try {
      const s = await window.electronAPI.getSettings()
      if (s) {
        s.hasApiKey = s.hasApiKey || false
        settings.value = s
        // Restore saved theme
        if (s.themeName) {
          themeName.value = s.themeName
        }
        // Restore autoExecute preference
        if (s.autoExecute !== undefined) {
          autoExecute.value = s.autoExecute
        }
        // Restore saved font scale
        if (s.fontScale !== undefined) {
          fontScale.value = s.fontScale
        }
        // Restore custom primary color (user-defined single custom theme)
        if (typeof s.customTheme === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.customTheme)) {
          customTheme.value = s.customTheme
        }
      }
      const full = await window.electronAPI.getFullSettings()
      if (full.apiKey) {
        settings.value.hasApiKey = true
      }
    } catch (e) {
      console.error('Failed to load settings:', e)
    }
  }

  async function saveSettings(newSettings) {
    try {
      const plain = JSON.parse(JSON.stringify(newSettings))
      // Always include current themeName when saving settings
      plain.themeName = themeName.value
      const s = await window.electronAPI.setSettings(plain)
      if (s) settings.value = s
      if (plain.apiKey) {
        const full = await window.electronAPI.getFullSettings()
        if (full.apiKey) {
          settings.value.hasApiKey = true
        }
      }
    } catch (e) {
      console.error('Failed to load settings:', e)
    }
  }

  // ========== Conversations ==========
  const conversations = ref([])
  const currentConvId = ref(null)
  const sidebarOpen = ref(true)
  const webSearchEnabled = ref(true)
  const autoExecute = ref(true)
  // 思考模式恒为开启（请求体不带 thinking 参数 = 用模型默认行为），无开关可关
  const themeName = ref('light')
  // 用户自定义主色（单套）：存一个 hex，非空时优先于内置主题；选内置主题即清空
  const customTheme = ref(null)
  // 全局字号档位：写字到根容器 --font-scale 变量，仅缩放文字（小/标准/稍大/大），与主题色并存
  const fontScale = ref(1)

  // ========== 每会话独立的流式状态（并发多流） ==========
  // 通用"思考中"占位文案：首字到达前循环切换，避免空窗期只有干巴巴的"思考中"
  // 风格参考 WorkBuddy 的卖萌短句（"正在拾起衣角"之类），让等待过程更有趣
  const THINKING_PHRASES = [
    '正在拾起衣角',
    '正在揉碎星光',
    '正在翻阅思绪',
    '正在召集灵感',
    '正在给脑子除尘',
    '正在偷瞄答案',
    '正在把问题泡进茶里',
    '正在和字符串搏斗',
    '正在翻找合适的词',
    '正在给想法充电',
    '正在把混乱理顺',
    '正在酝酿回答',
    '奋斗奋斗再奋斗',
    '吾心吾行，澄如明镜',
    '明天就是现在',
    '易于心之所向兮',
    '虽千万人吾往矣',
  ]

  // convId -> { messages, loaded, isStreaming, currentAssistantMessage, toolCalls,
  //             error, isSearching, statusMessage, reasoning, turnIssue, askUser, cleanups }
  const convStates = reactive(new Map())

  function createConvState() {
    return {
      messages: [],
      loaded: false,
      isStreaming: false,
      currentAssistantMessage: '',
      toolCalls: [],
      // 结构化任务清单（update_todos 工具）：模型整表覆盖写入，主进程每轮把清单回显给它
      // 自己（electron/tools/todo.js）。这里存一份给 UI 渲染，跨轮次保留 —— 回合结束后
      // 用户仍能看到最终进度；模型传空数组即清空。
      todos: [],
      error: null,
      isSearching: false,
      statusMessage: '',        // 当前 AI 工作状态描述（如"正在整理回答..."）
      toolWaitActive: false,    // 当前 statusMessage 是否为「长耗时工具进度」（主进程 tool_wait 推来）
      contextUsage: null,       // 本次发送的上下文占用 { contextTokens, windowTokens }，null=未发过
      reasoning: '',            // 模型思考过程（节流转发，用于区分"假死"还是仍在工作）
      thinkingText: '',         // 通用"思考中"占位文案（首字到达前循环切换的卖萌短句）
      isWaitingFirstToken: false, // 是否处于"等待首字"空窗期（尚未收到任何思考/正文/工具调用）
      turnIssue: null,          // 本轮未完成提示 { endReason, message, detail } —— 供"重试/继续"
      // 断点续跑：用户主动中断后主进程仍留下了可用快照 → 给一个中性的「继续」入口
      //（用户中断按约定不出错误横幅，不能复用 turnIssue）
      resumeOffer: false,
      // 本次「继续」真的命中了快照（回放了上一轮的工具结果）时的提示 { executed, interrupted }
      resumedInfo: null,
      askUser: null,            // 当前 AI 提问卡片（ask_user）：{ id, question, options }，null 表示无
      cleanups: [],             // 本会话流式监听的清理函数（停止/删除时逐个释放，不影响其他会话）
      subAgents: [],            // 子 Agent 状态列表 [{ subAgentId, task, description, status, startedAt, completedAt }]
      // 流式速度追踪
      estSpeed: 0,              // 流式过程中的实时估算速度（tokens/s），基于字符数/3.5/elapsedSec
      streamSpeed: null,        // 流式结束后的最终精确值 { tokensPerSec, completionTokens, elapsed }
      _streamStartTime: 0,      // 流式开始时间戳（内部计数用）
      _streamCharCount: 0,      // 累计字符数（内部计数用）
    }
  }

  function ensureConvState(convId) {
    if (!convStates.has(convId)) {
      convStates.set(convId, createConvState())
    }
    return convStates.get(convId)
  }

  // 当前正在"查看"的会话状态（未选中会话时返回临时空态，不写入 Map）
  const currentState = computed(() => {
    const cid = currentConvId.value
    if (!cid) return createConvState()
    return convStates.get(cid) || createConvState()
  })

  // 视图级流式状态：UI 只关心当前查看的会话；每个会话各自的流在后台独立继续
  const messages = computed(() => currentState.value.messages)
  const isStreaming = computed(() => currentState.value.isStreaming)
  const currentAssistantMessage = computed(() => currentState.value.currentAssistantMessage)
  const toolCalls = computed(() => currentState.value.toolCalls)
  const todos = computed(() => currentState.value.todos)
  const error = computed(() => currentState.value.error)
  const isSearching = computed(() => currentState.value.isSearching)
  const statusMessage = computed(() => currentState.value.statusMessage)
  const contextUsage = computed(() => currentState.value.contextUsage)
  const reasoning = computed(() => currentState.value.reasoning)
  const thinkingText = computed(() => currentState.value.thinkingText)
  const isWaitingFirstToken = computed(() => currentState.value.isWaitingFirstToken)
  const turnIssue = computed(() => currentState.value.turnIssue)
  // 断点续跑相关的两个视图状态（跟随当前查看的会话）
  const resumeOffer = computed(() => currentState.value.resumeOffer)
  const resumedInfo = computed(() => currentState.value.resumedInfo)
  const askUser = computed(() => currentState.value.askUser)
  const estSpeed = computed(() => currentState.value.estSpeed)
  const streamSpeed = computed(() => currentState.value.streamSpeed)
  const subAgents = computed(() => currentState.value.subAgents)

  // 运行并清空指定会话的流式监听（只影响该会话，不误伤其他并发会话）
  function runCleanups(convId) {
    const st = convStates.get(convId)
    if (st && Array.isArray(st.cleanups)) {
      st.cleanups.forEach((fn) => fn())
      st.cleanups = []
    }
  }

  // 指定会话是否正在生成（供侧边栏卡片背景呼吸提示，跨会话查看时仍能看到该会话在生成）
  function isConvStreaming(convId) {
    const st = convStates.get(convId)
    return !!st && !!st.isStreaming
  }

  // ========== File Attachments (导入文件) ==========
  // 用户"导入"的文件只记住路径，元素为 { path, name }；仅当前对话内存中，切换会话即清空
  const attachedFiles = ref([])

  function attachFiles(paths) {
    const list = attachedFiles.value
    const existing = new Set(list.map(f => f.path))
    const added = []
    for (const p of paths) {
      if (!p || existing.has(p)) continue
      existing.add(p)
      const name = p.split(/[\\/]/).pop() || p
      list.push({ path: p, name })
      added.push(p)
    }
    if (added.length > 0) {
      // 同步到主进程，授予 AI read_file 读取权限
      window.electronAPI.attachFiles(added).catch(e => {
        console.error('[attach] failed to register paths:', e)
      })
    }
  }

  function removeAttachedFile(p) {
    attachedFiles.value = attachedFiles.value.filter(f => f.path !== p)
    window.electronAPI.detachFile(p).catch(e => {
      console.error('[attach] failed to unregister path:', e)
    })
  }

  function clearAttachedFiles() {
    if (attachedFiles.value.length > 0) {
      window.electronAPI.clearAttachments().catch(e => {
        console.error('[attach] failed to clear paths:', e)
      })
    }
    attachedFiles.value = []
  }

  // ========== 文件打开与 Markdown 预览 ==========
  // .md/.markdown 在独立 BrowserWindow 中预览（不受宽度限制），其余扩展名用系统默认程序打开（xlsx→Excel 等）
  // 轻提示 toast：{ message, kind }，kind: 'info' | 'error'
  const notice = ref(null)
  let noticeTimer = null

  async function openFile(path) {
    if (!path || typeof path !== 'string') return
    const lower = path.toLowerCase()
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
      try {
        const res = await window.electronAPI.openMdPreview(path)
        if (res && !res.success) showNotice(res.error || '无法打开文件', 'error')
      } catch (e) {
        showNotice(e.message || '无法打开文件', 'error')
      }
      return
    }
    try {
      const res = await window.electronAPI.openPath(path)
      if (res && !res.success) showNotice(res.error || '无法打开文件', 'error')
    } catch (e) {
      showNotice(e.message || '无法打开文件', 'error')
    }
  }

  // duration：toast 停留时长（ms）。默认 3.5s；需要用户看清的提示（如「暂无试用模型」）可传更长
  function showNotice(message, kind = 'info', duration = 3500) {
    notice.value = { message, kind }
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => { notice.value = null }, duration)
  }

  // 主进程模型生成会话标题后推送，刷新侧栏会话列表
  let conversationsChangedRegistered = false
  function registerConversationsChanged() {
    if (conversationsChangedRegistered) return
    conversationsChangedRegistered = true
    window.electronAPI.onConversationsChanged(() => loadConversations())
  }

  // 开源版：无登录体系（企业版的登录 / 环境切换 / 平台切换已整块移除）。
  // 启动时仍需注册「会话变更」推送，否则侧栏不会随主进程的改动刷新。
  async function checkLogin() {
    registerConversationsChanged()
    return true
  }

  // 开源版：所有角色对所有人开放（企业版这里按登录人分组校验）
  function canSwitchRole() {
    return true
  }

  // ========== 公共试用模型（企业版功能） ==========
  // 企业版由服务端按登录人下发公共模型、写入只读「免费试用」页签；开源版没有该服务。
  // 这里保留同名接口为空实现，避免二次开发时改动面扩散。
  // 若要接入自己的试用/公共模型服务，实现方式见 electron/settings.js 的 profiles:setupTrial。
  async function applyTrialProfile() {
    return { ok: false, reason: 'disabled' }
  }

  function isUsingTrialProfile() {
    return false
  }

  async function refreshTrialProfileOnStartup() {
    return { ok: false, reason: 'skip' }
  }

  function setThemeName(name) {
    themeName.value = name
  }

  function setCustomTheme(hex) {
    customTheme.value = hex
  }

  function setFontScale(scale) {
    fontScale.value = scale
  }

  // Auto-save fontScale to main process whenever it changes
  watch(fontScale, (scale) => {
    window.electronAPI.setSettings({ fontScale: scale }).catch(e => {
      console.error('[font] Failed to persist fontScale:', e)
    })
  })

  // Auto-save themeName to main process whenever it changes
  watch(themeName, (name) => {
    // Persist theme change immediately without full settings reload
    window.electronAPI.setSettings({ themeName: name }).catch(e => {
      console.error('[theme] Failed to persist themeName:', e)
    })
  })

  // Auto-save custom primary color to main process whenever it changes (null = cleared)
  watch(customTheme, (hex) => {
    window.electronAPI.setSettings({ customTheme: hex }).catch(e => {
      console.error('[theme] Failed to persist customTheme:', e)
    })
  })

  // Sync autoExecute to main process whenever toggled, so that an in-progress
  // chat send can read the latest value from settings.autoExecute in real time
  watch(autoExecute, (val) => {
    window.electronAPI.setSettings({ autoExecute: val }).catch(e => {
      console.error('[autoExecute] Failed to sync:', e)
    })
  })

  // 思考模式已无开关：请求体一律不带 thinking 参数（= 模型默认行为，思考恒开启），
  // 主进程也不再读 settings.thinkingEnabled，因此这里没有任何同步逻辑。
  async function loadConversations() {
    try {
      const list = await window.electronAPI.listConversations()
      // 运行期间新建的空会话（0 消息、saved===false 尚未落盘）不在主进程索引里。
      // 重载列表（如 AI 生成标题后刷新）时把仍在跟踪的空会话一并补回顶部——
      // 运行中它们等同历史记录条目，可随时点回继续输入，不能因一次刷新就丢掉
      const keptUnsaved = conversations.value.filter(c => c.saved === false)
      for (let i = keptUnsaved.length - 1; i >= 0; i--) {
        const c = keptUnsaved[i]
        if (!list.some(x => x.id === c.id)) list.unshift(c)
      }
      conversations.value = list
    } catch (e) {
      console.error('Failed to load conversations:', e)
    }
  }

  async function newConversation() {
    try {
      // Save current conversation first
      await saveCurrentConversation()
      clearAttachedFiles()
      // 之前新建的 0 消息空会话不在这里清理：运行期间它们等同历史记录，可切回继续用。
      // 空会话不会落盘（无索引、无消息文件），应用重启即自然消失，历史里不会堆积
      const conv = await window.electronAPI.createConversation()
      conversations.value.unshift(conv)
      // 新会话有自己独立的状态槽，不影响其他正在进行的会话
      currentConvId.value = conv.id
      const st = ensureConvState(conv.id)
      st.messages = []
      st.loaded = true
      st.isStreaming = false
      st.currentAssistantMessage = ''
      st.toolCalls = []
      st.error = null
      st.isSearching = false
      st.statusMessage = ''
      st.contextUsage = null
      st.reasoning = ''
      st.turnIssue = null
      st.askUser = null
    } catch (e) {
      console.error('Failed to create conversation:', e)
    }
  }

  async function switchConversation(id) {
    if (id === currentConvId.value) return
    try {
      // Save current view first
      await saveCurrentConversation()
      clearAttachedFiles()
      // 切走不中断任何正在进行的流：只加载目标会话自己的状态
      const st = ensureConvState(id)
      if (!st.loaded) {
        st.messages = await window.electronAPI.getConversationMessages(id)
        st.loaded = true
      }
      currentConvId.value = id
      // 被留下的空会话（0 消息未落盘）不从这里移除：运行期间保留在侧栏，
      // 用户可随时切回继续输入；0 条消息的会话统一在应用重启时清除，不占历史记录
    } catch (e) {
      console.error('Failed to switch conversation:', e)
    }
  }

  async function deleteConversation(id) {
    try {
      // 只停被删会话自己的流，其他正在进行的会话不受影响
      const st = convStates.get(id)
      if (st && st.isStreaming) {
        window.electronAPI.stopChat(id)
        runCleanups(id)
        st.isStreaming = false
        st.currentAssistantMessage = ''
        st.reasoning = ''
        st.statusMessage = ''
        st.contextUsage = null
        st.error = null
        st.turnIssue = null
        st.askUser = null
        st.isSearching = false
      }
      await window.electronAPI.deleteConversation(id)
      conversations.value = conversations.value.filter(c => c.id !== id)
      convStates.delete(id)
      if (currentConvId.value === id) {
        // Switch to another conversation or create new
        if (conversations.value.length > 0) {
          await switchConversation(conversations.value[0].id)
        } else {
          await newConversation()
        }
      }
    } catch (e) {
      console.error('Failed to delete conversation:', e)
    }
  }

  // 归档会话为 Markdown：把该会话内存里的消息（若有）随 IPC 传给主进程，
  // 主进程落盘到 userData/archives/ 后弹原生对话框告知保存路径。
  // 非破坏性：不删会话、不动历史列表，归档只是「多出一份留档副本」。
  async function archiveConversation(id) {
    if (!id) return null
    try {
      const st = convStates.get(id)
      // 深拷贝剥离 Vue 响应式代理（与 saveConversationToDisk 同一套字段口径）；
      // 会话未加载/无消息时传 null，由主进程回退读磁盘消息文件
      const plainMessages = st && Array.isArray(st.messages) && st.messages.length > 0
        ? st.messages.map(m => ({
            role: m.role,
            content: m.content,
            ...(m.partial ? { partial: true } : {}),
          }))
        : null
      const res = await window.electronAPI.archiveConversation(id, plainMessages)
      if (!res || !res.success) {
        showNotice((res && res.error) || '归档失败', 'error')
        return null
      }
      // 保存路径由主进程原生对话框负责告知；这里再轻提示一次，对话框关掉后仍留有痕迹
      showNotice(`已归档：${res.fileName}`, 'info')
      return res
    } catch (e) {
      console.error('[archive] 归档会话失败:', e)
      showNotice(e.message || '归档失败', 'error')
      return null
    }
  }

  async function renameConversation(id, title) {
    try {
      const updated = await window.electronAPI.renameConversation(id, title)
      if (updated) {
        const idx = conversations.value.findIndex(c => c.id === id)
        if (idx >= 0) conversations.value[idx] = updated
      }
    } catch (e) {
      console.error('Failed to rename conversation:', e)
    }
  }

  // 会话标记色（侧栏色点）：flag 为 '#RRGGBB'，null = 取消标记。
  // 只替换列表里这一条（用 splice 触发响应式），不整表重载避免排序跳动。
  async function setConversationFlag(id, flag) {
    if (!id) return null
    try {
      const res = await window.electronAPI.setConversationFlag(id, flag)
      if (!res || !res.success) {
        if (res && res.error) showNotice(res.error, 'error')
        return null
      }
      const idx = conversations.value.findIndex(c => c.id === id)
      if (idx >= 0) {
        const next = { ...conversations.value[idx] }
        if (res.flag) next.flag = res.flag
        else delete next.flag
        conversations.value.splice(idx, 1, next)
      }
      return res.flag
    } catch (e) {
      console.error('Failed to set conversation flag:', e)
      return null
    }
  }

  async function saveCurrentConversation() {
    if (!currentConvId.value) {
      console.log('[save] skip: no currentConvId')
      return
    }
    await saveConversationToDisk(currentConvId.value, convStates.get(currentConvId.value))
  }

  // 把某个会话的消息落盘（并发场景下由各会话自己的 done/error 触发，落到正确会话，互不串写）
  async function saveConversationToDisk(convId, st) {
    if (!convId || !st || st.messages.length === 0) {
      console.log(`[save] skip ${convId}: no state or messages empty`)
      return
    }
    try {
      // 深拷贝消息数组，剥离 Vue 响应式代理后传给 IPC
      // （partial 标记保留：中断保留的半截回答，重载会话后仍能在界面上标识"回答不完整"）
      const plainMessages = st.messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.partial ? { partial: true } : {}),
        ...(m.usage ? { usage: { prompt_tokens: m.usage.prompt_tokens, completion_tokens: m.usage.completion_tokens, total_tokens: m.usage.total_tokens, cached_tokens: m.usage.cached_tokens || 0 } } : {}),
      }))
      console.log(`[save] saving ${plainMessages.length} msgs for ${convId}`)
      // 带上首次创建时间：空会话首次落盘时（主进程补建索引）沿用原始 createdAt，
      // 而不是用落盘时刻，避免会话创建时间漂移
      const localConv = conversations.value.find(c => c.id === convId)
      const result = await window.electronAPI.saveConversationMessages(
        convId,
        plainMessages,
        localConv && Number.isFinite(localConv.createdAt) ? { createdAt: localConv.createdAt } : undefined,
      )
      console.log('[save] result:', result)
      // 更新本地会话项（不重新加载整个列表，避免 updatedAt 更新导致排序跳动）
      const idx = conversations.value.findIndex(c => c.id === convId)
      if (idx >= 0) {
        const conv = conversations.value[idx]
        conv.saved = true // 已落盘：之后离开/新建时不会被当作空会话清理
        conv.messageCount = plainMessages.length
        if (!conv.title || conv.title === '新对话') {
          const firstUser = plainMessages.find(m => m.role === 'user')
          if (firstUser) {
            conv.title = firstUser.content.slice(0, 30) + (firstUser.content.length > 30 ? '...' : '')
          }
        }
        // 触发表单更新（替换引用触发响应式）
        conversations.value.splice(idx, 1, { ...conv })
      }
      console.log('[save] local list updated')
    } catch (e) {
      console.error(`[save] Failed to save conversation ${convId}:`, e)
    }
  }

  // ========== Chat ==========
  function addMessage(msg) {
    currentState.value.messages.push(msg)
  }

  function clearMessages() {
    const st = currentState.value
    st.messages = []
    st.currentAssistantMessage = ''
    st.toolCalls = []
    st.error = null
    st.reasoning = ''
    st.turnIssue = null
    st.resumeOffer = false
    st.resumedInfo = null
  }

  // ========== Turn issue (本轮未完成) ==========
  function clearTurnIssue() {
    const st = currentState.value
    st.turnIssue = null
    st.error = null
  }

  // 用户关掉「已中断，可从断点继续」提示条（快照本身不删，用户仍可自己输入"继续"）
  function dismissResumeOffer() {
    currentState.value.resumeOffer = false
  }

  function buildTurnIssue(endReason, detail) {
    const reasons = {
      timeout: '网络连接超时：超过 180 秒没有收到 AI 的数据，连接可能已断开',
      max_iterations: 'AI 长时间调用工具仍未给出最终回答（多次无进展被强制收口）',
      no_answer: 'AI 本轮未生成有效回答',
      // 网关不支持原生 function calling：工具调用被写进正文，工具实际一次都没执行
      text_tool_call: '模型把工具调用写成了正文，本轮工具没有执行',
      error: '本轮请求出错，未能完成',
    }
    return { endReason, message: reasons[endReason] || reasons.error, detail: detail || '' }
  }

  // 重试：用最后一条用户消息重新发起（从头重新生成）
  async function retryLastTurn() {
    const st = currentState.value
    const lastUser = [...st.messages].reverse().find(m => m.role === 'user')
    clearTurnIssue()
    if (!lastUser) return
    await sendMessage(lastUser.content)
  }

  // 继续：接着上一轮往下做。
  // resume=true → 主进程若命中"中断续跑快照"，直接回放上一轮真实的消息序列
  // （含工具调用与工具结果），已跑过的工具不再重跑；未命中则退回原来的重建历史方式。
  // note：可选的「本次补充说明」（2026-10-04 加）。中途停下想追加一句要求时用它 ——
  // **仍然带 resume 标记**，因此任务清单不会被清空（只有"新发一条消息"才清，见下面 sendMessage），
  // 模型也照旧看得见进度；补充说明由主进程拼进续跑提示一起下发（`resumeNote`），不会被丢掉。
  async function continueTurn(note = '') {
    clearTurnIssue()
    const extra = typeof note === 'string' ? note.trim() : ''
    const content = extra ? `${CONTINUE_PROMPT}\n\n【本次补充说明】${extra}` : CONTINUE_PROMPT
    await sendMessage(content, { resume: true, note: extra })
  }

  // 回答 AI 的 ask_user 提问：回传主进程（继续工具循环）并关闭卡片
  function answerAskUser(payload) {
    try {
      // 带当前会话 id，主进程按会话路由到挂起的工具循环
      window.electronAPI.answerAskUser({ convId: currentConvId.value, ...payload })
    } catch (e) {
      console.error('[ask] failed to answer:', e)
    }
    currentState.value.askUser = null
  }

  // ========== 角色代码仓库（企业版：切身份自动拉取内网仓库） ==========
  // 开源版没有该能力：产品 / 测试角色改为读用户在设置里授权的代码目录
  // （占位符 {{CODE_REPO_DIR}}，见 electron/settings.js 的 getCodeRepoDir）。
  // 这里保留同名接口为空实现，避免调用方改动面扩散。
  const roleRepoSync = ref(null)
  function roleNeedsRepo() {
    return false
  }
  async function syncRoleRepos() {
    return null
  }
  async function checkRoleRepos() {
    return null
  }
  function closeRepoPane() {
    roleRepoSync.value = null
  }
  async function cancelRepoPane() {}
  async function retryRepoPane() {
    return null
  }

  // 切换角色（通用/产品/测试）：先校验当前用户是否有权切换到目标角色，
  // 无权限则提示"您当前暂无该身份"并中止；有权则只中断当前会话的流 → 持久化 → 新建对话（等价重新实例化 AI）
  async function switchRole(role) {
    if (!role || role === settings.value.role) return
    // 若有正在进行的回复，只中断当前会话，不影响其他会话
    const cid = currentConvId.value
    const st = cid ? convStates.get(cid) : null
    if (st && st.isStreaming) {
      window.electronAPI.stopChat(cid)
      runCleanups(cid)
      st.isStreaming = false
      st.currentAssistantMessage = ''
      st.reasoning = ''
      st.statusMessage = ''
      st.contextUsage = null
      st.error = null
      st.turnIssue = null
      st.askUser = null
      st.isSearching = false
    }
    settings.value.role = role
    await saveSettings(JSON.parse(JSON.stringify(settings.value)))
    await newConversation()
  }

  // opts.resume：本次是「继续」按钮发起的断点续跑（主进程命中快照时回放上一轮的工具结果）
  async function sendMessage(content, opts = {}) {
    const resumeTurn = opts.resume === true
    const fullSettings = await window.electronAPI.getFullSettings()
    if (!fullSettings || !fullSettings.apiKey) {
      currentState.value.error = '请先在设置中配置 DeepSeek API Key'
      console.error('sendMessage: no key in fullSettings', fullSettings)
      showSettings.value = true
      return
    }
    settings.value.hasApiKey = true

    // Auto-create conversation if none exists
    if (!currentConvId.value) {
      await newConversation()
    }

    const convId = currentConvId.value
    const st = ensureConvState(convId)

    st.messages.push({ role: 'user', content })
    st.isStreaming = true
    st.error = null
    st.currentAssistantMessage = ''
    st.toolCalls = []
    // 任务清单（update_todos）：新发一条消息 = 新任务 → 清掉上一轮那份，让模型按新任务重新列。
    // 「继续」（resumeTurn）是同一任务的断点续跑，保留清单。主进程侧也会清（权威），
    // 这里清是为了界面即时消失、不必等这轮请求回来。
    if (!resumeTurn) st.todos = []
    st.reasoning = ''
    st.statusMessage = ''
    st.contextUsage = null
    st.turnIssue = null
    // 新一轮开始：上一轮的「可续跑」提示与「已接续」提示都作废（真命中了会有 chat:status 回来）
    st.resumeOffer = false
    st.resumedInfo = null
    st.askUser = null
    st.isSearching = false
    // 重置流式速度追踪
    st.estSpeed = 0
    st.streamSpeed = null
    st._streamStartTime = 0
    st._streamCharCount = 0
    st.subAgents = []  // 清除上一轮子 Agent 状态

    // 通用"思考中"占位：进入"等待首字"空窗期，循环切换卖萌文案，直到首字（思考/正文/工具）到达
    let thinkingTimer = null
    const stopWaitingFirstToken = () => {
      if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null }
      st.isWaitingFirstToken = false
    }
    st.isWaitingFirstToken = true
    st.thinkingText = THINKING_PHRASES[0]
    let thinkingIdx = 0
    thinkingTimer = setInterval(() => {
      // 随机选一句（避免与上一次重复），让等待提示更自然
      let next
      do {
        next = Math.floor(Math.random() * THINKING_PHRASES.length)
      } while (next === thinkingIdx && THINKING_PHRASES.length > 1)
      thinkingIdx = next
      st.thinkingText = THINKING_PHRASES[thinkingIdx]
    }, 2200)

    const history = st.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }))

    // 本会话专属监听器：按 data.convId 过滤，只更新本会话状态；
    // 多会话并发时互不干扰，结束后只清理自己的监听
    const cleanups = []

    // 注册到本会话 cleanups：无论正常结束(finalize)还是中断/删除/切角色(runCleanups)都能清理定时器
    cleanups.push(stopWaitingFirstToken)

    cleanups.push(window.electronAPI.onChatChunk((data) => {
      if (data.convId !== convId) return
      // 首字（正文）到达：结束"等待首字"空窗期，停掉卖萌占位
      if (data.content) stopWaitingFirstToken()
      // 重试成功后流式恢复：清除"请求连接失败，正在重试..."等状态提示
      if (data.content && st.statusMessage) st.statusMessage = ''
      // 注意：不在这里清空 st.reasoning，让思考内容持续显示到本轮流式结束
      // （chat.js 已在正文到达前 flush 完整思考文本，此处无需干扰）
      st.currentAssistantMessage += data.content
      // 实时估算生成速度（字符数 / 3.5 ≈ token 数）
      if (data.content) {
        st._streamCharCount += data.content.length
        const elapsedSec = (Date.now() - st._streamStartTime) / 1000
        if (elapsedSec > 0.5) {
          st.estSpeed = Math.round((st._streamCharCount / 3.5) / elapsedSec)
        }
      }
    }))

    // 兼容 preload 与渲染产物版本不一致（只重建前端产物时该 API 可能不存在），
    // 不能让注册监听这一步抛错 —— 那会连带整个会话的事件链都装不上。
    cleanups.push(window.electronAPI.onChatContentReset ? window.electronAPI.onChatContentReset((data) => {
      if (data.convId !== convId) return
      // 模型把工具调用写成了正文 → 主进程已还原成结构化调用并继续执行，
      // 这里用「清理掉 XML 之后」的正文整体替换已累积内容（不是追加）。
      const removed = st.currentAssistantMessage.length - (data.content || '').length
      st.currentAssistantMessage = data.content || ''
      if (removed > 0) st._streamCharCount = Math.max(0, st._streamCharCount - removed)
    }) : () => {})

    cleanups.push(window.electronAPI.onChatReasoning((data) => {
      if (data.convId !== convId) return
      // 首字（思考内容）到达：结束"等待首字"空窗期，停掉卖萌占位
      if (data.content) stopWaitingFirstToken()
      // 重试成功后思考恢复：清除重试提示
      if (data.content && st.statusMessage) st.statusMessage = ''
      // 主进程已累积完整思考文本，直接取最近 2000 字符显示（不再拼接，避免重复）
      st.reasoning = (data.content || '').slice(-2000)
    }))

    cleanups.push(window.electronAPI.onAskUser((data) => {
      if (data.convId !== convId) return
      // AI 调用 ask_user：弹出提问/选择卡片，等待用户回答
      st.askUser = { id: data.id, question: data.question, options: data.options || [] }
    }))

    cleanups.push(window.electronAPI.onChatTool((data) => {
      if (data.convId !== convId) return
      const tc = st.toolCalls

      if (data.status === 'executing') {
        // 首字（工具调用）到达：结束"等待首字"空窗期，停掉卖萌占位
        stopWaitingFirstToken()
        // 重试成功后工具恢复执行：清除重试提示
        if (st.statusMessage) st.statusMessage = ''
        st.toolWaitActive = false
        // Tool is about to execute — show indicator immediately
        if (data.name === 'search_web') {
          st.isSearching = true
        }
        // Update the last pending tool or add a new one
        const pending = tc[tc.length - 1]
        if (pending && !pending.result) {
          pending.name = data.name
          pending.args = data.args
        } else {
          tc.push({
            name: data.name,
            args: data.args,
            result: null,
            done: false,
          })
        }
      } else if (data.status === 'done') {
        // Tool execution completed
        const doneIdx = tc.findIndex(t => t.name === data.name && !t.done)
        if (doneIdx >= 0) {
          tc[doneIdx] = { ...tc[doneIdx], result: data.result, done: true }
        } else {
          tc.push({
            name: data.name,
            args: data.args,
            result: data.result,
            done: true,
          })
        }
        if (data.name === 'search_web') {
          st.isSearching = false
        }
        // 工具结束：清掉执行期间的进度提示（如「正在检索代码…已扫描 N 个文件」），
        // 否则它会在工具跑完之后继续挂在输入框上方。
        // 用标记位而不是文案前缀比对，避免以后改文案时这里悄悄失配。
        if (st.toolWaitActive) {
          st.toolWaitActive = false
          if (st.statusMessage) st.statusMessage = ''
        }

        // 任务清单（update_todos）：整表覆盖，这里同步一份给 UI 渲染。
        // 只在**主进程校验通过**（result.success）时才更新 —— 否则会把被拒的清单显示出来。
        if (data.name === 'update_todos') {
          try {
            const res = JSON.parse(data.result || '{}')
            if (res.success) {
              const args = JSON.parse(data.args || '{}')
              st.todos = Array.isArray(args.todos) ? args.todos : []
            }
          } catch {
            // args/result 不是合法 JSON（理论上不会发生）：保留原清单，不影响主流程
          }
        }
      }
    }))

    cleanups.push(window.electronAPI.onChatStatus((data) => {
      if (data.convId !== convId) return
      if (data.type === 'generating_answer') {
        st.statusMessage = data.message || '正在生成回答...'
      } else if (data.type === 'retrying') {
        st.statusMessage = data.message || '网络波动，正在重试...'
      } else if (data.type === 'compacting') {
        st.statusMessage = data.message || '正在压缩更早的对话历史...'
      } else if (data.type === 'tool_wait') {
        // 长耗时工具（grep_code / glob_files 扫大仓库）由主进程节流推来的进度。
        // 显示在输入框上方，让"正在扫几万个文件"有可见反馈，而不是看起来像界面卡死。
        st.statusMessage = data.message || '正在检索…'
        st.toolWaitActive = true
      } else if (data.type === 'resumed') {
        // 断点续跑命中：上一轮的工具结果被原样回放，不会重跑。
        // statusMessage 会被首个正文 chunk 清掉，所以另存一份供常驻提示条使用。
        st.statusMessage = data.message || '已接续上一次被中断的执行...'
        st.resumedInfo = { executed: data.executed || 0, interrupted: data.interrupted || 0 }
      }
    }))

    cleanups.push(window.electronAPI.onChatContext((data) => {
      if (data.convId !== convId) return
      st.contextUsage = { contextTokens: data.contextTokens, windowTokens: data.windowTokens }
    }))

    // 子 Agent 状态更新
    cleanups.push(window.electronAPI.onChatSubAgent((data) => {
      if (data.convId !== convId) return
      const existing = st.subAgents.find(s => s.subAgentId === data.subAgentId)
      if (existing) {
        Object.assign(existing, {
          status: data.status,
          result: data.result,
          duration: data.duration,
          completedAt: data.completedAt || null,
        })
      } else {
        st.subAgents.push({
          subAgentId: data.subAgentId,
          task: data.task,
          description: data.description || '',
          status: data.status,
          result: null,
          duration: null,
          startedAt: data.startedAt,
          completedAt: null,
        })
      }
    }))

    // 收尾：清掉本会话所有监听（只影响本会话，不误伤其他并发会话）
    const finalize = () => {
      cleanups.forEach(fn => fn())
      const rs = convStates.get(convId)
      if (rs) rs.cleanups = []
    }

    cleanups.push(window.electronAPI.onChatDone(async (data) => {
      if (data.convId !== convId) return
      if (st.currentAssistantMessage) {
        const assistantMsg = { role: 'assistant', content: st.currentAssistantMessage }
        // 附带本轮 token 用量（从主进程 chat:done 传回）
        // cached_tokens = 缓存命中的输入 token（服务端自动前缀缓存），用于在徽标里显示命中率
        if (data.usage && data.usage.total_tokens > 0) {
          assistantMsg.usage = {
            prompt_tokens: data.usage.prompt_tokens || 0,
            completion_tokens: data.usage.completion_tokens || 0,
            total_tokens: data.usage.total_tokens || 0,
            cached_tokens: data.usage.cached_tokens || 0,
          }
        }
        st.messages.push(assistantMsg)
      }
      // 计算本轮精确速度：优先用服务端真实 token 数，否则用字符估算兜底
      const totalSec = (Date.now() - st._streamStartTime) / 1000
      if (data.usage && data.usage.completion_tokens > 0 && totalSec > 0) {
        st.streamSpeed = {
          tokensPerSec: Math.round(data.usage.completion_tokens / totalSec),
          completionTokens: data.usage.completion_tokens,
          elapsed: Math.round(totalSec),
        }
      } else if (st._streamCharCount > 0 && totalSec > 0.5) {
        const estTokens = Math.round(st._streamCharCount / 3.5)
        st.streamSpeed = {
          tokensPerSec: Math.round(estTokens / totalSec),
          completionTokens: estTokens,
          elapsed: Math.round(totalSec),
        }
      }
      st.currentAssistantMessage = ''
      st.isStreaming = false
      st.isSearching = false
      st.statusMessage = ''
      st.reasoning = ''
      st.estSpeed = 0

      // 开源版：企业版这里会把本轮用量上报到服务端统计（按登录人 + 是否试用模型）。
      // 该服务与登录体系一并移除；如需自建统计，在此处改成你自己的上报调用。
      // 主进程汇报了"异常结束"（截断/超时/工具未执行/无回答）时，提示用户重试/继续。
      // 注意排除 'aborted'：用户主动点"中断"属于预期操作，只复位状态、不出横幅
      // （主进程现在也会为中断发 chat:done，用它来收尾复位，不再依赖"静默 return"）。
      const er = data && data.endReason
      if (er && er !== 'complete' && er !== 'aborted') {
        st.turnIssue = buildTurnIssue(er, (data && data.endDetail) || '')
        st.resumeOffer = false
      } else if (er === 'aborted' && data && data.resumable === true) {
        // 用户主动中断但主进程留下了续跑快照：给一个中性的「继续」入口
        // （按约定用户中断不出错误横幅，所以不能走 turnIssue，否则会被当成出错了）
        st.resumeOffer = true
      } else {
        st.resumeOffer = false
      }
      // 会话已被删除则跳过落盘，避免把结果写回已删除会话
      if (convStates.has(convId)) {
        await saveConversationToDisk(convId, st)
      }
      st.askUser = null
      finalize()
    }))

    cleanups.push(window.electronAPI.onChatError(async (data) => {
      if (data.convId !== convId) return
      st.error = data.message
      st.isStreaming = false
      st.isSearching = false
      st.statusMessage = ''
      st.reasoning = ''
      st.currentAssistantMessage = ''
      st.estSpeed = 0
      st.streamSpeed = null
      // 明确告知用户"为何失败"，并提供重试/继续
      st.turnIssue = buildTurnIssue((data && data.endReason) || 'error', data.message || '')
      // 网络异常的上报**不在这里**：主进程 chat.js 在真实出错处直接调
      // netHealth.noteChatNetworkFailure()（那里有 err.cause.code，比正则准），
      // 由主进程负责立刻染色 + 补探，再经 net-health:update 推回本 store。
      // 原先这里靠正则匹配 data.message，实测在"探针判 good、长连接却一直断"时
      // 毫无用处 —— 不如让真实失败自己说话。
      // 异常结束一律走 turnIssue 横幅（它自带「继续」按钮，点击时会带 resume 标记）
      st.resumeOffer = false
      // 保存已有消息（用户消息），防止数据丢失
      if (convStates.has(convId)) {
        await saveConversationToDisk(convId, st)
      }
      st.askUser = null
      finalize()
    }))

    st.cleanups = cleanups

    try {
      // 附件是 Vue 响应式 Proxy，直接传 IPC 无法序列化，需先转成普通对象
      const plainAttached = attachedFiles.value.map(f => ({ path: f.path, name: f.name }))
      // 记录流式开始时间（用于估算 tokens/s）
      st._streamStartTime = Date.now()
      // resumeNote：「带补充说明的继续」时，用户写的那句要求。主进程命中续跑快照时会把
      // 末尾那条 user 消息换成续跑提示，所以补充说明必须单独传过去拼上，否则会被静默丢掉。
      await window.electronAPI.sendChat(convId, history, activeProfileId.value, webSearchEnabled.value, autoExecute.value, plainAttached, resumeTurn, opts.note || '')
    } catch (e) {
      st.error = e.message
      st.isStreaming = false
      st.isSearching = false
      st.statusMessage = ''
      st.reasoning = ''
      st.turnIssue = buildTurnIssue('error', e.message || '')
      // 保存已有消息（用户消息），防止数据丢失
      if (convStates.has(convId)) {
        await saveConversationToDisk(convId, st)
      }
      finalize()
    }
  }

  // 停止当前查看会话的生成（"中断"按钮）：只停本会话，其他会话不受影响
  function stopCurrentStream() {
    const cid = currentConvId.value
    if (!cid) return
    const st = convStates.get(cid)
    if (!st) return
    const wasStreaming = st.isStreaming
    if (wasStreaming) {
      window.electronAPI.stopChat(cid)
      runCleanups(cid)
    }
    st.isStreaming = false
    st.resumeOffer = false
    // 保留已生成的部分回答：中断后把半截内容收进消息列表并落盘，标记 partial 表示不完整
    if (st.currentAssistantMessage) {
      st.messages.push({ role: 'assistant', content: st.currentAssistantMessage, partial: true })
      if (convStates.has(cid)) saveConversationToDisk(cid, st)
    }
    st.currentAssistantMessage = ''
    st.reasoning = ''
    st.turnIssue = null
    st.statusMessage = ''
    st.askUser = null
    st.isSearching = false
    st.estSpeed = 0
    st.streamSpeed = null
    // 用户主动中断（按约定不出错误横幅）也常常想在断点继续：主进程在 chat:stop 里已同步写好
    // 续跑快照，这里问一次即可给一个中性的「继续」入口。
    // 上面 runCleanups 已摘掉本会话的监听，所以只能主动问、等不到 chat:done。
    if (wasStreaming) probeResumeOffer(cid, st)
  }

  // 探测本会话是否留有续跑快照。IPC 是顺序投递的，正常情况下第一次就能拿到；
  // 万一主进程写盘落在后面，再补问一次（不轮询、不重试多次）。
  function probeResumeOffer(cid, st, retried = false) {
    window.electronAPI
      .canResume(cid)
      .then((ok) => {
        if (ok === true) {
          const cur = convStates.get(cid)
          // 期间用户已发新消息 / 会话被删 / 又开始了新的流式 → 不再补提示
          if (cur === st && !cur.isStreaming) cur.resumeOffer = true
          return
        }
        if (!retried) setTimeout(() => probeResumeOffer(cid, st, true), 350)
      })
      .catch(() => {})
  }

  return {
    // Settings
    settings,
    showSettings,
    apiKeyConfigured,
    modelProfiles,
    activeProfileId,
    activeProfile,
    // 网络健康（右上角状态点）
    netHealth,
    refreshNetHealth,
    clearNetHealthFailure,
    loadSettings,
    saveSettings,
    checkLogin,
    // 公共试用模型（「立即试用」按钮 / 启动自动更新）
    applyTrialProfile,
    isUsingTrialProfile,
    refreshTrialProfileOnStartup,
    // Conversations
    conversations,
    currentConvId,
    sidebarOpen,
    webSearchEnabled,
    autoExecute,
    isSearching,
    themeName,
    setThemeName,
    customTheme,
    setCustomTheme,
    fontScale,
    setFontScale,
    loadConversations,
    newConversation,
    switchConversation,
    deleteConversation,
    archiveConversation,
    renameConversation,
    setConversationFlag,
    // Chat（视图级流式状态 + 并发相关）
    currentState,
    messages,
    isStreaming,
    currentAssistantMessage,
    toolCalls,
    todos,
    error,
    reasoning,
    statusMessage,
    contextUsage,
    thinkingText,
    isWaitingFirstToken,
    turnIssue,
    resumeOffer,
    resumedInfo,
    estSpeed,
    streamSpeed,
    subAgents,
    addMessage,
    clearMessages,
    sendMessage,
    clearTurnIssue,
    dismissResumeOffer,
    retryLastTurn,
    continueTurn,
    stopCurrentStream,
    isConvStreaming,
    // AI 提问卡片（ask_user）
    askUser,
    answerAskUser,
    // File Attachments
    attachedFiles,
    attachFiles,
    removeAttachedFile,
    clearAttachedFiles,
    // 文件打开与 Markdown 预览
    notice,
    openFile,
    showNotice,
  }
})
