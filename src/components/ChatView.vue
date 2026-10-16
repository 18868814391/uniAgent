<template>
  <div class="chat-container">
    <!-- Messages Area -->
    <div class="messages-area" ref="messagesRef" @scroll="handleScroll">
      <!-- Empty state -->
      <div v-if="store.messages.length === 0 && !store.isStreaming" class="empty-state">
        <div class="empty-icon">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
        </div>
        <h2 class="empty-title">Local AI Open 助手</h2>
        <p class="empty-desc">OpenAI 兼容的桌面 AI 助手</p>
        <div class="empty-hints">
          <div class="hint-item" @click="quickSend('你好，请介绍一下你的能力')">
            <span class="hint-icon">👋</span>
            <span>自我介绍</span>
          </div>
          <div class="hint-item" @click="quickSend('列出当前位置的文件')">
            <span class="hint-icon">📂</span>
            <span>浏览文件</span>
          </div>
        </div>
      </div>

      <!-- Message list -->
      <div v-for="(msg, idx) in store.messages" :key="idx" class="message-wrapper">
        <MessageBubble :message="msg" @open-file="store.openFile" @open-external="openExternal" />
      </div>

      <!-- Streaming message -->
      <div v-if="store.isStreaming && store.currentAssistantMessage" class="message-wrapper">
        <MessageBubble
          :message="{ role: 'assistant', content: store.currentAssistantMessage }"
          :is-streaming="true"
          @open-file="store.openFile"
          @open-external="openExternal"
        />
      </div>

      <!-- Web Search indicator -->
      <div v-if="store.isSearching" class="search-indicator">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <span>联网搜索中...</span>
        <span class="search-spinner" />
      </div>

      <!-- 通用"思考中"占位：首字到达前的空窗期循环切换卖萌文案，避免只有干巴巴的"思考中" -->
      <div v-if="store.isStreaming && store.isWaitingFirstToken" class="thinking-placeholder">
        <span class="thinking-emoji">🤔</span>
        <span class="thinking-text">{{ store.thinkingText }}</span>
        <span class="thinking-dots"><i></i><i></i><i></i></span>
      </div>

      <!-- Model reasoning — 显示思考过程，区分"正在工作"和"卡死" -->
      <div v-if="store.isStreaming && store.reasoning" class="reasoning-box">
        <span class="reasoning-label">🤔 正在思考…</span>
        <div ref="reasoningTextRef" class="reasoning-text">{{ store.reasoning }}</div>
      </div>

      <!-- 任务清单（update_todos）：模型自己维护的多步任务进度。
           主进程每轮都会把这份清单回显给模型（electron/tools/todo.js），所以它不是装饰 ——
           它和模型实际看到的是同一份。跨轮次保留，模型传空数组才清空。 -->
      <div v-if="store.todos.length > 0" class="todo-area">
        <div class="todo-panel">
          <div class="todo-header" @click="todoCollapsed = !todoCollapsed">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
            </svg>
            <span class="todo-title">任务清单</span>
            <span class="todo-badge">{{ todoStats.done }}/{{ store.todos.length }}</span>
            <span v-if="todoStats.doing" class="todo-progress">进行中 · {{ todoStats.doing }}</span>
            <span class="todo-toggle">{{ todoCollapsed ? '展开' : '收起' }}</span>
          </div>
          <ul v-if="!todoCollapsed" class="todo-list">
            <li v-for="(t, i) in store.todos" :key="i" class="todo-item" :class="'is-' + t.status">
              <span class="todo-mark">{{ t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○' }}</span>
              <span class="todo-text">{{ t.text }}</span>
            </li>
          </ul>
        </div>
      </div>

      <!-- Tool calls display —— 折叠态与原来一致（一行汇总），点开可看每个工具调用；
           其中 edit_file / write_file 直接展示主进程算好的改动 diff -->
      <div v-if="store.toolCalls.length > 0" class="tool-calls-area">
        <div class="tool-call-item">
          <div
            class="tool-call-header tool-call-toggle"
            @click="toolCallsExpanded = !toolCallsExpanded"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
            </svg>
            <span class="tool-call-name">工具调用</span>
            <span class="tool-call-badge">× {{ store.toolCalls.length }}</span>
            <span v-if="diffCount > 0" class="tool-call-diff-badge">{{ diffCount }} 处改动可查看</span>
            <span v-if="pendingToolCalls > 0" class="tool-call-status tool-call-running">⏳ {{ pendingToolCalls }} 个执行中</span>
            <span v-else class="tool-call-status">✓ 完成</span>
            <span class="tool-call-chevron" :class="{ open: toolCallsExpanded }">▾</span>
          </div>

          <div v-if="toolCallsExpanded" class="tool-call-detail">
            <div v-for="v in toolCallViews" :key="v.index" class="tool-call-row">
              <div
                class="tool-call-row-head"
                :class="{ 'is-clickable': v.diff }"
                @click="v.diff && toggleDiff(v.index)"
              >
                <span class="tool-call-row-name">{{ v.name }}</span>
                <span class="tool-call-row-info" :title="v.info">{{ v.info || '—' }}</span>
                <span v-if="!v.done" class="tool-call-row-state">执行中…</span>
                <span v-else-if="v.diff" class="tool-call-row-link">{{ openDiffs.has(v.index) ? '收起改动' : '查看改动' }}</span>
              </div>
              <div v-if="v.diff && openDiffs.has(v.index)" class="tool-diff">
                <div
                  v-for="(line, li) in v.lines"
                  :key="li"
                  class="tool-diff-line"
                  :class="diffLineClass(line)"
                >{{ line || ' ' }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Sub-agent status indicators -->
      <SubAgentStatus :sub-agents="store.subAgents" />

      <!-- Error display -->
      <div v-if="store.error && !store.isStreaming && !store.turnIssue" class="error-banner">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        <span>{{ store.error }}</span>
        <button class="error-dismiss" @click="store.error = null">✕</button>
      </div>

      <!-- 本轮未完成提示：明确告知失败原因，提供 重试 / 继续 -->
      <div v-if="store.turnIssue" class="turn-issue-banner">
        <div class="turn-issue-msg">⚠️ {{ store.turnIssue.message }}</div>
        <div class="turn-issue-detail" v-if="store.turnIssue.detail">{{ store.turnIssue.detail }}</div>
        <div class="turn-issue-actions">
          <button class="turn-issue-btn retry" @click="store.retryLastTurn()">🔄 重试</button>
          <input
            v-model="continueNote"
            class="continue-note-input"
            placeholder="补充说明（可选）：比如「XX 那段先别动」"
            @keydown.enter.prevent="onContinueWithNote"
          />
          <button class="turn-issue-btn continue" @click="onContinueWithNote">▶️ 继续</button>
          <button class="error-dismiss" @click="store.clearTurnIssue()">✕</button>
        </div>
      </div>

      <!-- 本次「继续」命中续跑快照：告知回放了多少工具结果（常驻到下一轮开始） -->
      <div v-if="store.resumedInfo" class="resume-banner applied">
        <div class="resume-msg">已接续上一次被中断的执行</div>
        <div class="resume-detail">
          保留了 {{ store.resumedInfo.executed }} 个工具结果，不会重复执行<span
            v-if="store.resumedInfo.interrupted > 0"
          >；另有 {{ store.resumedInfo.interrupted }} 个工具被中断、未拿到结果</span>。
        </div>
      </div>

      <!-- 用户主动中断但进度已留存：中性提示（不是错误横幅），给一个「继续」入口 -->
      <div v-if="!store.turnIssue && store.resumeOffer" class="resume-banner">
        <div class="resume-msg">已停止，这一步的进度已保留</div>
        <div class="resume-detail">
          点「继续」会从断点接着做，已经跑过的工具不会重跑，任务清单也保留；
          想追加要求就在右边写一句（会跟着这次继续一起交给 AI）。
        </div>
        <div class="resume-actions">
          <input
            v-model="continueNote"
            class="continue-note-input"
            placeholder="补充说明（可选）：比如「type 字段改成必填」"
            @keydown.enter.prevent="onContinueWithNote"
          />
          <button class="turn-issue-btn continue" @click="onContinueWithNote">▶️ 继续</button>
          <button class="error-dismiss" @click="store.dismissResumeOffer()">✕</button>
        </div>
      </div>

      <!-- Processing indicator: always visible while AI is working -->
      <div v-if="store.isStreaming" class="processing-indicator">
        <span class="p-dot"></span>
        <span class="p-dot"></span>
        <span class="p-dot"></span>
        <span class="p-elapsed" v-if="store.estSpeed > 0">{{ store.estSpeed }} tokens/s</span>
        <span class="p-elapsed" v-else-if="elapsed > 5">已等待 {{ elapsed }} 秒</span>
      </div>
      <!-- 流结束后显示本轮精确速度统计 -->
      <div v-if="store.streamSpeed && !store.isStreaming" class="stream-stats">
        ⚡ {{ store.streamSpeed.tokensPerSec }} tokens/s · 共 {{ fmtTokens(store.streamSpeed.completionTokens) }} tokens · {{ store.streamSpeed.elapsed }}秒
      </div>
    </div>
    <!-- END messages-area -->

    <!-- Web Search Toggle + Input Area -->
    <div class="input-area">
      <!-- AI 提问卡片（ask_user）：AI 反问/给选择框时弹出，回答后继续 -->
      <div v-if="store.askUser" class="ask-card">
        <div class="ask-card-header">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>AI 需要确认一下</span>
        </div>
        <div class="ask-card-question">{{ store.askUser.question }}</div>
        <div v-if="hasAskOptions" class="ask-card-options">
          <button
            v-for="(opt, idx) in store.askUser.options"
            :key="idx"
            class="ask-option-btn"
            @click="onOptionClick(opt, idx)"
          >{{ opt }}</button>
        </div>
        <!-- 自定义输入栏固定显示：AI 给的选项都不符合时，用户总能自己写（不再需要 AI 提供"其他"选项） -->
        <div class="ask-card-input-row">
          <input
            ref="askInputRef"
            v-model="askInput"
            class="ask-card-input"
            :placeholder="askInputPlaceholder"
            @keydown.enter.prevent="answerAsk(askInput, -1)"
          />
          <button
            class="ask-card-submit"
            :disabled="!askInput.trim()"
            @click="answerAsk(askInput, -1)"
          >确认</button>
        </div>
        <button class="ask-card-cancel" @click="cancelAsk" title="取消这次提问">✕</button>
      </div>
      <div class="search-toggle-bar">
        <!-- 左侧：导入文件按钮 + 附件列表 -->
        <div class="attach-bar">
          <button
            class="attach-btn"
            @click="pickFiles"
            title="导入本地文件（图片将作为视觉输入，文本文件可由 AI 按需读取）"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
            <span>导入文件</span>
          </button>
          <div v-if="store.attachedFiles.length > 0" class="file-chips">
            <div v-for="f in store.attachedFiles" :key="f.path" class="file-chip" :title="f.path">
              <svg class="file-chip-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" />
                <polyline points="13 2 13 9 20 9" />
              </svg>
              <span class="file-chip-name">{{ f.name }}</span>
              <button class="file-chip-remove" @click="store.removeAttachedFile(f.path)" title="移除文件">✕</button>
            </div>
          </div>
        </div>
        <!-- 右侧：功能开关 -->
        <div class="toggle-group">
          <button
            class="search-toggle-btn"
            :class="{ active: store.autoExecute }"
            @click="store.autoExecute = !store.autoExecute"
            :title="store.autoExecute ? '自动执行已开启：AI直接运行命令' : '执行前询问已开启：AI执行命令前需你确认'"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            <span>自动执行</span>
            <span class="toggle-indicator" :class="{ on: store.autoExecute }"></span>
          </button>
          <button
            class="search-toggle-btn"
            :class="{ active: store.webSearchEnabled }"
            @click="store.webSearchEnabled = !store.webSearchEnabled"
            :title="store.webSearchEnabled ? '联网搜索已开启' : '点击开启联网搜索'"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
              <path d="M11 8v6M8 11h6" v-if="!store.webSearchEnabled" />
            </svg>
            <span>联网搜索</span>
            <span class="toggle-indicator" :class="{ on: store.webSearchEnabled }"></span>
          </button>
        </div>
      </div>
      <div v-if="store.statusMessage || store.contextUsage" class="input-meta">
        <span v-if="store.statusMessage" class="chat-status-hint">{{ store.statusMessage }}</span>
        <span v-if="store.contextUsage" class="context-usage">上下文 {{ fmtContextUsage(store.contextUsage) }}</span>
      </div>
      <div class="input-wrapper" @click.stop="focusInput">
        <textarea
          ref="inputRef"
          v-model="inputText"
          class="chat-input"
          placeholder="输入消息，按 Enter 发送，Shift+Enter 换行..."
          rows="1"
          @keydown="handleKeydown"
          @input="autoResize"
          :disabled="store.isStreaming"
        />
        <button
          class="send-btn"
          :class="{ 'stop-btn': store.isStreaming }"
          :disabled="!store.isStreaming && !canSend"
          @click="store.isStreaming ? stopStreaming() : doSend()"
          :title="store.isStreaming ? '停止生成' : '发送消息'"
        >
          <svg v-if="!store.isStreaming" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 前往顶部 / 回到底部 快捷按钮：滚动离开两端时浮现 -->
    <Transition name="scroll-btns">
      <div v-if="showScrollButtons" class="scroll-actions">
        <button class="scroll-btn" :disabled="!canScrollUp" @click="scrollToTop" title="前往顶部">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>
        <button class="scroll-btn" :disabled="!canScrollDown" @click="scrollToBottomManual" title="回到底部">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>
    </Transition>

    <!-- 轻提示 toast（如打开文件失败） -->
    <Transition name="toast">
      <div v-if="store.notice" class="notice-toast" :class="store.notice.kind">
        {{ store.notice.message }}
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { useAppStore } from '@/stores/app'
import MessageBubble from './MessageBubble.vue'
import SubAgentStatus from './SubAgentStatus.vue'

const store = useAppStore()
const inputText = ref('')
const askInput = ref('')     // AI 提问卡片的自定义输入
const askInputRef = ref(null)
// 自定义输入栏**固定显示**（不再依赖"先点『其他』才出现"）：AI 给的选项都不合适时，用户总能直接写。
// 有选项时换一句更贴切的提示语，并保留点选"其他"直接把焦点送进输入框的便利。
const hasAskOptions = computed(() => !!(store.askUser && store.askUser.options && store.askUser.options.length > 0))
const askInputPlaceholder = computed(() => (hasAskOptions.value
  ? '选项都不合适？直接在这里输入你的回答…'
  : '输入你的回答，按回车确认…'))
const inputRef = ref(null)
const messagesRef = ref(null)
const reasoningTextRef = ref(null) // 思考过程文本容器，内容更新时自动滚到底部
const elapsed = ref(0)         // 本轮已等待秒数（帮助判断"假死"还是仍在工作）
let elapsedTimer = null
let autoScroll = true
const SCROLL_EDGE = 80         // 距顶/底多少像素内视为"已在顶/底"
const canScrollUp = ref(false)
const canScrollDown = ref(false)
const showScrollButtons = computed(() => canScrollUp.value || canScrollDown.value)

const canSend = computed(() => {
  return inputText.value.trim() && !store.isStreaming
})

// 仍在执行中的工具调用数 —— 只要有未完成的，汇总行就不能说"✓ 完成"
// （此前该处文案是硬编码的，工具/子任务还在跑时也会显示"完成"）
const pendingToolCalls = computed(() => store.toolCalls.filter(tc => !tc.done).length)

// ============================================================
//  工具调用明细（可展开）—— 把 edit_file / write_file 的改动 diff 直接摊给用户看
//
//  背景：改动 diff 由主进程算好后随 chat:tool 的 result 一起到了渲染层，
//  但此前渲染层只用了"条数"，用户想知道"到底改了什么"只能去敲 git diff，
//  或者等模型自己愿意在回答里贴一段（并不可靠 —— 它贴不贴取决于当轮怎么组织汇报，
//  结构性重构那轮它选了表格，三行修复那轮它才贴了代码）。
//  这里把 result 里已有的 diff 展示出来，让"改了什么"始终可见、不依赖模型发挥。
// ============================================================
const toolCallsExpanded = ref(false)
const openDiffs = ref(new Set())   // 已展开明细的行下标

// >>> 可抽取纯逻辑 开始（见 tests/tool-result-view.test.js）
// 解析保护：result 可能是超大字符串（read_file 能返回整份文件），
// 对这种长度做 JSON.parse 纯属浪费，超过阈值直接跳过（本就不含 diff）。
const RESULT_PARSE_MAX = 2 * 1024 * 1024
function parseToolResult(result) {
  if (typeof result !== 'string' || !result || result.length > RESULT_PARSE_MAX) return null
  try {
    const v = JSON.parse(result)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null   // 有些工具返回纯文本，不是 JSON
  }
}

// args 里取文件路径。write_file 的 args 含**整份文件内容**，可能很大，
// 故这里设一个更严的上限：超长就不解析（路径拿不到，但不会为了路径白解析几 MB）。
const ARGS_PARSE_MAX = 512 * 1024
function filePathOf(tc) {
  const raw = tc && tc.args
  if (typeof raw !== 'string' || !raw || raw.length > ARGS_PARSE_MAX) return ''
  const args = parseToolResult(raw)
  return args && typeof args.path === 'string' ? args.path : ''
}

// ⚠️ 结果的形状是**两层**：tools/index.js 统一包成 { success, result: <工具自己的返回> }，
// 所以 diff / created / replacedCount 这些字段在 parsed.result 里，不在顶层。
// （漏了这一层会静默失效：路径能显示、"查看改动"按钮却不出现。）
function toolResultBody(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const inner = parsed.result
  return inner && typeof inner === 'object' ? inner : parsed
}

// 明细行右侧的一句话说明：文件类给路径（+ 新建/替换处数），失败给原因，其余给一行参数预览
function toolCallInfo(tc, parsed) {
  const body = toolResultBody(parsed)
  if (parsed && parsed.success === false && parsed.error) {
    return `失败：${String(parsed.error).replace(/\s+/g, ' ').slice(0, 120)}`
  }
  const p = filePathOf(tc)
  if (p) {
    const bits = []
    if (body && body.created) bits.push('新建')
    if (body && body.replacedCount > 1) bits.push(`替换 ${body.replacedCount} 处`)
    if (body && body.eolAdjusted) bits.push('按行尾差异兜底匹配')
    return bits.length ? `${p}（${bits.join('，')}）` : p
  }
  const raw = tc && tc.args
  if (typeof raw !== 'string' || !raw || raw.length > 2000) return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, 120)
}

// diff 行配色：@@ 头 / 新增 / 删除 / 上下文 / 截断提示
function diffLineClass(line) {
  if (line.startsWith('@@')) return 'diff-meta'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-del'
  if (line.startsWith('…')) return 'diff-note'
  return 'diff-ctx'
}
// <<< 可抽取纯逻辑 结束 —— 以上不得依赖 ref/computed/store/模板，
//     因为 tests/tool-result-view.test.js 会把这段原样取出来在纯 Node 下跑
//     （结果的嵌套形状这类契约错误只在真实负载下才暴露，必须能脱离浏览器测）

const toolCallViews = computed(() =>
  (store.toolCalls || []).map((tc, i) => {
    const parsed = parseToolResult(tc.result)
    const body = toolResultBody(parsed)
    const diff = body && typeof body.diff === 'string' ? body.diff : ''
    return {
      index: i,
      name: tc.name,
      done: !!tc.done,
      info: toolCallInfo(tc, parsed),
      diff,
      // 逐行拆开是为了按 +/-/上下文上色。长度已由主进程限制（≤80 行 / ≤12 个变更块）
      lines: diff ? diff.split('\n') : [],
    }
  })
)

// 折叠态给一个提示："有 N 处改动可以看"，否则用户不知道点开有东西
const diffCount = computed(() => toolCallViews.value.filter(v => v.diff).length)

function toggleDiff(i) {
  const next = new Set(openDiffs.value)
  if (next.has(i)) next.delete(i)
  else next.add(i)
  openDiffs.value = next
}

// 新的一轮 / 新会话开始时收起：toolCalls 被清空的瞬间复位视图状态，
// 否则下一轮的明细会沿用上一轮的展开态（下标已错位）。
watch(() => store.toolCalls.length, (n, old) => {
  if (n === 0 && old > 0) {
    toolCallsExpanded.value = false
    openDiffs.value = new Set()
  }
})

// 任务清单（update_todos）展示：默认展开，用户可手动收起（收起状态不持久化，纯视图偏好）
const todoCollapsed = ref(false)
const todoStats = computed(() => {
  const list = store.todos
  const doing = list.find(t => t.status === 'in_progress')
  return {
    done: list.filter(t => t.status === 'completed').length,
    doing: doing ? doing.text : '',
  }
})

// 上下文占用展示：`45.0K/1.0M (4.3%)`。基于主进程的本地估算值，非真实 tokenizer 结果。
function fmtContextUsage(u) {
  if (!u || !u.windowTokens) return ''
  const used = u.contextTokens || 0
  const win = u.windowTokens
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)))
  const pct = (used / win) * 100
  return `${fmt(used)}/${fmt(win)} (${pct.toFixed(1)}%)`
}

// Token 数格式化（1200 -> "1.2K"，800 -> "800"）
function fmtTokens(n) {
  if (n == null) return '0'
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : String(n)
}

function handleScroll() {
  const el = messagesRef.value
  if (!el) return
  const threshold = 100
  autoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
  canScrollUp.value = el.scrollTop > SCROLL_EDGE
  canScrollDown.value = el.scrollHeight - el.scrollTop - el.clientHeight > SCROLL_EDGE
}

// 无滚动事件时（内容变化/切换会话）主动刷新按钮可见性
function updateScrollFlags() {
  const el = messagesRef.value
  if (!el) return
  canScrollUp.value = el.scrollTop > SCROLL_EDGE
  canScrollDown.value = el.scrollHeight - el.scrollTop - el.clientHeight > SCROLL_EDGE
}

function scrollToTop() {
  const el = messagesRef.value
  if (!el) return
  el.scrollTo({ top: 0, behavior: 'smooth' })
  canScrollUp.value = false
  canScrollDown.value = true
}

// 手动回到底部：用户点了「回到底部」按钮，明确要贴底，恢复自动跟随
function scrollToBottomManual() {
  const el = messagesRef.value
  if (!el) return
  autoScroll = true
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  canScrollUp.value = true
  canScrollDown.value = false
}

function scrollToBottom() {
  const el = messagesRef.value
  if (el && autoScroll) {
    nextTick(() => {
      el.scrollTop = el.scrollHeight
    })
  }
}

// Auto scroll when new content arrives
watch(
  () => [store.messages.length, store.currentAssistantMessage],
  () => {
    scrollToBottom()
    nextTick(updateScrollFlags)
  },
  { deep: true }
)

// 本轮已等待时长 —— 只要计时器还在走、工具/思考内容还在刷新，说明 AI 仍在工作
watch(
  () => store.isStreaming,
  (v) => {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null }
    if (v) {
      elapsed.value = 0
      elapsedTimer = setInterval(() => { elapsed.value += 1 }, 1000)
    }
  }
)

// 思考过程内容更新时，自动滚动到底部，让用户始终看到最新内容
watch(
  () => store.reasoning,
  () => {
    nextTick(() => {
      const el = reasoningTextRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }
)

// Re-focus input after conversation switch (delete/switch/create)
watch(
  () => store.currentConvId,
  () => {
    // 等待 DOM 更新完成后聚焦输入框
    const tryFocus = () => {
      const el = inputRef.value
      if (!el) return
      el.focus({ preventScroll: true })
      const len = el.value.length
      el.setSelectionRange(len, len)
    }
    nextTick(() => {
      tryFocus()
      autoResize() // 切换会话后输入框通常为空，同步重置高度
      updateScrollFlags() // 切换会话后内容高度变化，刷新滚动按钮可见性
    })
  }
)

function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    doSend()
  }
}

async function doSend() {
  const text = inputText.value.trim()
  if (!text || store.isStreaming) return
  inputText.value = ''
  autoScroll = true
  await nextTick()
  autoResize() // 发送后把输入框高度重置回单行
  await store.sendMessage(text)
}

// 「继续」横幅里的可选补充说明（两条横幅共用一个 ref —— 它们由 store 保证互斥展示）。
// 带补充说明点「继续」仍然走 resume 通道：任务清单保留、命中快照时工具不重跑，
// 补充内容由主进程拼进续跑提示交给模型（详见 store.continueTurn 与 chat.js 的 extractResumeNote）。
const continueNote = ref('')
async function onContinueWithNote() {
  const note = continueNote.value
  continueNote.value = ''
  continueNoteBlur()
  await store.continueTurn(note)
}
// 输入框随横幅一起消失后，浏览器会把焦点掉到 body 上 —— 主动还回主输入框，
// 用户按回车就能继续打字（否则要点一下才生效）。
function continueNoteBlur() {
  nextTick(() => {
    try {
      const el = inputRef.value
      if (el) el.focus({ preventScroll: true })
    } catch (e) { /* 静默 */ }
  })
}

// 导入文件：图片会作为视觉输入发送，文本文件只记住路径供 AI 按需读取
// 点选 AI 提问卡片选项：命中"其他/其它/Other"时不当作回答，而是把焦点送进下方固定的输入栏
// （输入栏一直可见，这里只是省掉用户点一下的功夫）；其余选项直接回答
function onOptionClick(opt, idx) {
  if (/其他|其它|other|others/i.test(opt)) {
    askInput.value = ''
    nextTick(() => {
      const el = askInputRef.value
      if (el) el.focus()
    })
    return
  }
  answerAsk(opt, idx)
}

// 回答 AI 提问卡片（提交自定义输入 / 点选选项）
function answerAsk(answer, optionIndex) {
  const q = store.askUser
  if (!q) return
  const value = (answer || '').trim()
  if (optionIndex < 0 && !value) return
  store.answerAskUser({ id: q.id, answer: value || '', optionIndex })
  askInput.value = ''
}

// 取消 AI 提问：回传 cancelled，AI 会收到"用户取消"，基于已有信息推进
function cancelAsk() {
  const q = store.askUser
  if (!q) return
  store.answerAskUser({ id: q.id, cancelled: true })
  askInput.value = ''
}

// 新一轮提问时清空输入栏（输入栏常驻，不再有"自定义模式"需要复位）
watch(
  () => store.askUser,
  () => {
    askInput.value = ''
  }
)

async function pickFiles() {
  try {
    const result = await window.electronAPI.selectFiles()
    if (result && !result.canceled && result.paths && result.paths.length > 0) {
      store.attachFiles(result.paths)
    }
  } catch (e) {
    console.error('Failed to select files:', e)
  }
}

function quickSend(text) {
  inputText.value = text
  doSend()
}

// 打开外部 http(s) 链接（消息气泡里的 external 链接委托到这里）
async function openExternal(url) {
  if (!url) return
  try {
    await window.electronAPI.openExternal(url)
  } catch (e) {
    store.showNotice('打开链接失败：' + (e.message || ''), 'error')
  }
}

function stopStreaming() {
  // 只停当前查看会话的流，其他正在进行的会话不受影响
  store.stopCurrentStream()
}

function focusInput(e) {
  const el = inputRef.value
  if (!el) return
  // 点击目标就是输入框本体时：不干预，让浏览器默认按鼠标落点放置光标/选择
  // （否则下面的 setSelectionRange 会把光标强制拉到末尾，破坏点击定位）
  if (e && e.target && e.target === el) return
  // 点击的是输入框容器空白处/按钮：聚焦输入框，光标放到末尾
  el.focus({ preventScroll: true })
  const len = el.value.length
  el.setSelectionRange(len, len)
}

// 输入框自适应高度：随内容增长，达到 MAX_INPUT_HEIGHT 后固定高度并出现内部滚动条
const MAX_INPUT_HEIGHT = 200

function autoResize() {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto' // 先重置，scrollHeight 才能反映自然内容高度
  el.style.height = Math.min(el.scrollHeight, MAX_INPUT_HEIGHT) + 'px'
  el.style.overflowY = el.scrollHeight > MAX_INPUT_HEIGHT ? 'auto' : 'hidden'
}

// Auto-focus input on mount
onMounted(() => {
  focusInput()
  autoResize()
  updateScrollFlags()
})

// 组件卸载时清理计时器，避免内存泄漏
onUnmounted(() => {
  if (elapsedTimer) clearInterval(elapsedTimer)
})
</script>

<style scoped>
.chat-container {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* 前往顶部 / 回到底部 快捷按钮 */
.scroll-actions {
  position: absolute;
  right: 18px;
  bottom: 150px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.scroll-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  box-shadow: var(--shadow);
  transition: all 0.2s;
}

.scroll-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--bg-input);
}

.scroll-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.scroll-btns-enter-active,
.scroll-btns-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.scroll-btns-enter-from,
.scroll-btns-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

/* Messages Area */
.messages-area {
  flex: 1;
  overflow-y: auto;
  padding: 24px 20px 16px;
  scroll-behavior: smooth;
}

/* Empty State */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  animation: fadeIn 0.5s ease;
}

.empty-icon {
  color: var(--text-muted);
  opacity: 0.5;
  margin-bottom: 8px;
}

.empty-title {
  font-size: calc(24px * var(--font-scale));
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 1px;
}

.empty-desc {
  color: var(--text-secondary);
  font-size: calc(14px * var(--font-scale));
  margin-bottom: 16px;
}

.empty-hints {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: center;
  max-width: 480px;
}

.hint-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 20px;
  color: var(--text-secondary);
  font-size: calc(13px * var(--font-scale));
  cursor: pointer;
  transition: all 0.2s;
  user-select: none;
}

.hint-item:hover {
  background: var(--bg-input);
  border-color: var(--accent);
  color: var(--text-primary);
}

.hint-icon {
  font-size: calc(16px * var(--font-scale));
}

.message-wrapper {
  animation: fadeIn 0.3s ease;
}

/* Processing indicator — visible whenever AI is working */
.processing-indicator {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 8px 48px;
  animation: fadeIn 0.3s ease;
}

.p-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  animation: bounce 1.4s ease-in-out infinite both;
}

.p-dot:nth-child(1) { animation-delay: 0s; }
.p-dot:nth-child(2) { animation-delay: 0.16s; }
.p-dot:nth-child(3) { animation-delay: 0.32s; }

.p-elapsed {
  font-size: calc(12px * var(--font-scale));
  color: var(--text-muted);
  margin-left: 4px;
}

@keyframes bounce {
  0%, 80%, 100% {
    transform: scale(0.6);
    opacity: 0.3;
  }
  40% {
    transform: scale(1);
    opacity: 1;
  }
}

/* Web Search indicator */
.search-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 48px;
  color: var(--accent);
  font-size: calc(13px * var(--font-scale));
  animation: fadeIn 0.3s ease;
}

.search-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--accent);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

/* Model reasoning — 思考过程指示（区分"正在工作"和"卡死"） */
.reasoning-box {
  padding: 4px 48px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 通用"思考中"占位：首字到达前循环切换卖萌文案 */
.thinking-placeholder {
  padding: 8px 48px;
  display: flex;
  align-items: center;
  gap: 8px;
  animation: fadeIn 0.2s ease;
}

.thinking-emoji {
  font-size: calc(16px * var(--font-scale));
  animation: thinkBob 1.6s ease-in-out infinite;
}

.thinking-text {
  font-size: calc(13px * var(--font-scale));
  color: var(--text-muted);
  letter-spacing: 0.3px;
  animation: thinkFade 2.2s ease-in-out infinite;
}

.thinking-dots {
  display: inline-flex;
  gap: 3px;
  margin-left: 2px;
}

.thinking-dots i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--text-muted);
  opacity: 0.4;
  animation: thinkBlink 1.2s infinite ease-in-out;
}

.thinking-dots i:nth-child(2) {
  animation-delay: 0.2s;
}

.thinking-dots i:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes thinkBob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-3px); }
}

@keyframes thinkFade {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}

@keyframes thinkBlink {
  0%, 100% { opacity: 0.2; transform: scale(0.8); }
  50% { opacity: 0.9; transform: scale(1); }
}

.reasoning-label {
  font-size: calc(12px * var(--font-scale));
  color: var(--text-muted);
}

.reasoning-text {
  font-size: calc(12px * var(--font-scale));
  line-height: 1.5;
  color: var(--text-muted);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  max-height: 140px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.8;
}

/* Tool calls */
.tool-calls-area {
  padding: 4px 48px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tool-call-item {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 12px;
  animation: fadeIn 0.2s ease;
}

.tool-call-header {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: calc(12px * var(--font-scale));
}

.tool-call-name {
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--accent);
}

.tool-call-badge {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: calc(11px * var(--font-scale));
  color: var(--text-muted);
  background: var(--bg-input);
  padding: 1px 6px;
  border-radius: 8px;
  margin-left: 2px;
}

.tool-call-status {
  margin-left: auto;
  color: var(--success);
  font-size: calc(11px * var(--font-scale));
}

/* 未全部完成时不撒谎报"完成"：改用中性色，与绿色完成态区分 */
.tool-call-running {
  color: var(--text-secondary);
}

/* ---------- 工具调用明细（展开后）---------- */
.tool-call-toggle {
  cursor: pointer;
  user-select: none;
}

/* 折叠态提示"有改动可看"：没有它，用户不知道点开能看到 diff */
.tool-call-diff-badge {
  font-size: calc(11px * var(--font-scale));
  color: var(--accent);
  background: var(--bg-input);
  padding: 1px 6px;
  border-radius: 8px;
}

.tool-call-chevron {
  margin-left: 6px;
  color: var(--text-muted);
  font-size: calc(10px * var(--font-scale));
  transform: rotate(-90deg);
  transition: transform 0.15s ease;
}
.tool-call-chevron.open {
  transform: rotate(0deg);
}

.tool-call-detail {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--border);
}

.tool-call-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 4px;
  border-radius: var(--radius-sm);
  font-size: calc(12px * var(--font-scale));
  color: var(--text-secondary);
}
.tool-call-row-head.is-clickable {
  cursor: pointer;
}
.tool-call-row-head.is-clickable:hover {
  background: var(--bg-input);
}

.tool-call-row-name {
  flex: none;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--accent);
}

.tool-call-row-info {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
}

.tool-call-row-state,
.tool-call-row-link {
  flex: none;
  margin-left: auto;
}
.tool-call-row-link {
  color: var(--accent);
}

/* 改动 diff：等宽、可横向滚动；纵向限高，避免一次改几十处把聊天区撑爆 */
.tool-diff {
  margin: 2px 0 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  max-height: 320px;
  overflow: auto;
}

.tool-diff-line {
  padding: 0 10px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: calc(11.5px * var(--font-scale));
  line-height: 1.5;
  white-space: pre;
}
/* 代码 diff 的通用配色：删除红、新增绿（与编辑器一致） */
.tool-diff-line.diff-add {
  color: var(--success);
  background: rgba(34, 197, 94, 0.1);
}
.tool-diff-line.diff-del {
  color: var(--danger);
  background: rgba(239, 68, 68, 0.1);
}
.tool-diff-line.diff-ctx {
  color: var(--text-muted);
}
.tool-diff-line.diff-meta {
  color: var(--accent);
}
.tool-diff-line.diff-note {
  color: var(--warning);
}

/* 任务清单（update_todos）：与工具调用汇总行同宽同风格，放在它上面 */
.todo-area {
  padding: 4px 48px 8px;
}

.todo-panel {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 12px;
  animation: fadeIn 0.2s ease;
}

.todo-header {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: calc(12px * var(--font-scale));
  cursor: pointer;
  user-select: none;
}

.todo-title {
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--accent);
}

.todo-badge {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: calc(11px * var(--font-scale));
  color: var(--text-muted);
  background: var(--bg-input);
  padding: 1px 6px;
  border-radius: 8px;
}

.todo-progress {
  font-size: calc(11px * var(--font-scale));
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}

.todo-toggle {
  margin-left: auto;
  font-size: calc(11px * var(--font-scale));
  color: var(--text-muted);
  flex: 0 0 auto;
}

.todo-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.todo-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: calc(12px * var(--font-scale));
  line-height: 1.5;
  color: var(--text-secondary);
}

.todo-mark {
  flex: 0 0 auto;
  min-width: 10px;
  text-align: center;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--text-muted);
}

/* 长文本必须能换行，否则窄窗口下会把面板撑破（同侧栏卡片那次的教训） */
.todo-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.todo-item.is-completed .todo-mark {
  color: var(--success);
}

.todo-item.is-completed .todo-text {
  text-decoration: line-through;
  opacity: 0.6;
}

.todo-item.is-in_progress {
  color: var(--text-primary);
}

.todo-item.is-in_progress .todo-mark,
.todo-item.is-in_progress .todo-text {
  color: var(--accent);
}

/* Error */
.error-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: var(--radius-sm);
  color: var(--danger);
  font-size: calc(13px * var(--font-scale));
  margin: 8px 48px 0;
  animation: fadeIn 0.3s ease;
}

.error-dismiss {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--danger);
  cursor: pointer;
  font-size: calc(14px * var(--font-scale));
  padding: 2px 4px;
}

/* 工具上下文不可用提示：重载含工具的会话时告知用户上下文已丢失 */

/* Turn issue banner — 本轮未完成，明确提示原因并支持 重试/继续 */
.turn-issue-banner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 16px;
  background: rgba(249, 115, 22, 0.1);
  border: 1px solid rgba(249, 115, 22, 0.35);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: calc(13px * var(--font-scale));
  margin: 8px 48px 0;
  animation: fadeIn 0.3s ease;
}

.turn-issue-msg {
  font-weight: 600;
  color: var(--warning, #d97706);
}

.turn-issue-detail {
  font-size: calc(12px * var(--font-scale));
  color: var(--text-secondary);
  word-break: break-word;
}

.turn-issue-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 「继续」横幅里的可选补充说明输入框（2026-10-04）。
   与主输入框区分：更矮、更窄，且 flex:1 让它把剩余宽度吃掉、按钮仍靠右不换行。 */
.continue-note-input {
  flex: 1 1 auto;
  min-width: 120px;
  max-width: 420px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-family: inherit;
  font-size: calc(12px * var(--font-scale));
  transition: border-color 0.2s;
}

.continue-note-input::placeholder {
  color: var(--text-muted);
}

.continue-note-input:focus {
  outline: none;
  border-color: var(--accent);
}

.turn-issue-btn {
  padding: 5px 14px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: calc(12px * var(--font-scale));
  cursor: pointer;
  transition: all 0.2s;
}

.turn-issue-btn:hover {
  border-color: var(--accent);
  background: var(--bg-input);
}

.turn-issue-btn.continue {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}

.turn-issue-btn.continue:hover {
  background: var(--accent-hover);
}

/* 断点续跑提示条 —— 与「本轮未完成」横幅刻意区分开：
   前者是中性信息（进度已保留/已接续），后者才是需要用户注意的异常，故走主题强调色而非警告橙。 */
.resume-banner {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 16px;
  margin: 8px 48px 0;
  background: var(--accent-soft, rgba(127, 127, 127, 0.08));
  border: 1px solid var(--accent);
  border-left-width: 3px;
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: calc(13px * var(--font-scale));
  animation: fadeIn 0.3s ease;
}

.resume-banner.applied {
  border-style: dashed;
}

.resume-msg {
  font-weight: 600;
  color: var(--accent);
}

.resume-detail {
  font-size: calc(12px * var(--font-scale));
  color: var(--text-secondary);
  word-break: break-word;
}

.resume-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}

/* AI 提问卡片（ask_user） */
.ask-card {
  position: relative;
  margin-bottom: 8px;
  padding: 12px 16px;
  background: var(--bg-surface);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
  animation: fadeIn 0.2s ease;
}

.ask-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(12px * var(--font-scale));
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 6px;
}

.ask-card-question {
  font-size: calc(14px * var(--font-scale));
  color: var(--text-primary);
  line-height: 1.6;
  margin-bottom: 10px;
  word-break: break-word;
}

.ask-card-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  /* 选项与下方"常驻的自定义输入栏"拉开距离（两者现在会同时出现） */
  margin-bottom: 10px;
}

.ask-option-btn {
  padding: 7px 16px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 18px;
  color: var(--text-secondary);
  font-size: calc(13px * var(--font-scale));
  cursor: pointer;
  transition: all 0.2s;
  user-select: none;
}

.ask-option-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.ask-card-input-row {
  display: flex;
  gap: 8px;
}

.ask-card-input {
  flex: 1;
  padding: 8px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: calc(13px * var(--font-scale));
  outline: none;
  transition: border-color 0.2s;
}

.ask-card-input:focus {
  border-color: var(--accent);
}

.ask-card-submit {
  padding: 8px 18px;
  background: var(--accent);
  border: none;
  border-radius: var(--radius-sm);
  color: white;
  font-size: calc(13px * var(--font-scale));
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
  flex-shrink: 0;
}

.ask-card-submit:hover {
  background: var(--accent-hover);
}

/* 输入为空时不可提交（回车路径另有 answerAsk 内的空值守卫兜底） */
.ask-card-submit:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.ask-card-cancel {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: calc(12px * var(--font-scale));
  border-radius: 50%;
  transition: all 0.2s;
}

.ask-card-cancel:hover {
  background: rgba(239, 68, 68, 0.15);
  color: var(--danger);
}

/* Web Search Toggle Bar */
.search-toggle-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 4px 8px;
}

.toggle-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* Attach (导入文件) bar */
.attach-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.attach-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  background: var(--bg-input); /* 默认深色底，不再是灰色透明 */
  border: 1px solid var(--border);
  border-radius: 20px;
  color: var(--text-secondary);
  font-size: calc(12px * var(--font-scale));
  cursor: pointer;
  transition: all 0.2s;
  user-select: none;
  flex-shrink: 0;
}

.attach-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.file-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  overflow-x: auto;
  min-width: 0;
}

.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 6px 3px 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 14px;
  color: var(--text-secondary);
  font-size: calc(12px * var(--font-scale));
  white-space: nowrap;
  max-width: 200px;
  flex-shrink: 0;
  animation: fadeIn 0.2s ease;
}

.file-chip-icon {
  flex-shrink: 0;
  color: var(--accent);
}

.file-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}

.file-chip-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: 50%;
  cursor: pointer;
  font-size: calc(11px * var(--font-scale));
  padding: 0;
  line-height: 1;
  flex-shrink: 0;
  transition: all 0.2s;
}

.file-chip-remove:hover {
  background: var(--danger);
  color: white;
}

.search-toggle-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 20px;
  color: var(--text-muted);
  font-size: calc(12px * var(--font-scale));
  cursor: pointer;
  transition: all 0.2s;
  user-select: none;
}

.search-toggle-btn:hover {
  border-color: var(--text-muted);
  color: var(--text-secondary);
}

.search-toggle-btn.active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.toggle-indicator {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--border);
  transition: background 0.2s;
}

.toggle-indicator.on {
  background: var(--accent);
  box-shadow: 0 0 4px var(--accent);
}

/* Input Area */
.input-area {
  padding: 12px 20px 20px;
  flex-shrink: 0;
}

.input-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 0 8px;
  min-height: 18px;
}

.chat-status-hint {
  font-size: calc(12px * var(--font-scale));
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
  animation: chatStatusFade 0.25s ease;
}

.context-usage {
  font-size: calc(12px * var(--font-scale));
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  margin-left: auto;
}
.chat-status-hint::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: chatStatusPulse 1.2s ease-in-out infinite;
}
@keyframes chatStatusFade {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes chatStatusPulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}

.input-wrapper {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 8px 8px 8px 16px;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.input-wrapper:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-glow);
}

.chat-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-size: calc(14px * var(--font-scale));
  line-height: 1.5;
  resize: none;
  min-height: 24px; /* 单行高度，避免 JS 设置的高度把空输入框压得过扁 */
  max-height: 200px; /* 达到该高度后不再变高，内部出现滚动条 */
  overflow-y: auto;  /* 超过 max-height 时内部滚动查看之前内容 */
  font-family: inherit;
}

.chat-input::placeholder {
  color: var(--text-muted);
}

.chat-input:disabled {
  opacity: 0.6;
}

.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  background: var(--accent);
  color: white;
  border-radius: 50%;
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
}

.send-btn:hover:not(:disabled) {
  background: var(--accent-hover);
  transform: scale(1.05);
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 停止生成状态：红色高亮、可点击，与置灰的禁用态明显区分 */
.send-btn.stop-btn {
  background: var(--danger);
  opacity: 1;
  cursor: pointer;
}

.send-btn.stop-btn:hover:not(:disabled) {
  background: #dc2626;
  transform: scale(1.05);
}

/* 轻提示 toast（打开文件失败等） */
.notice-toast {
  position: fixed;
  bottom: 120px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 300;
  padding: 10px 18px;
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  color: var(--text-primary);
  font-size: calc(13px * var(--font-scale));
  box-shadow: var(--shadow);
  max-width: 70%;
  text-align: center;
}

.notice-toast.error {
  border-color: var(--danger);
  color: var(--danger);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(6px);
}

/* 流结束后速度统计行 */
.stream-stats {
  text-align: center;
  font-size: calc(11px * var(--font-scale, 1));
  color: var(--text-muted);
  padding: 4px 0 8px;
  animation: fadeIn 0.3s ease;
}
</style>
