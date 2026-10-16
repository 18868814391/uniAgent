<template>
  <div class="message-bubble" :class="[message.role, { streaming: isStreaming }]">
    <!-- Avatar -->
    <div class="avatar" :class="message.role">
      <svg v-if="message.role === 'user'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
      <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2a10 10 0 000 20 10 10 0 000-20z" />
        <path d="M12 6v6l4 2" />
      </svg>
    </div>

    <!-- Content -->
    <div class="bubble-content">
      <div class="role-label">{{ message.role === 'user' ? '你' : 'AI' }}</div>
      <div
        ref="mdBodyRef"
        class="markdown-body"
        v-html="renderedHtml"
        @click="onContentClick"
      />
      <!-- 中断保留的半截回答：标记不完整 -->
      <div v-if="message.partial" class="partial-tag">⏸ 已中断 · 回答不完整</div>
      <!-- Token 用量标签（缓存命中 = 服务端自动前缀缓存命中的输入 token，命中部分按 ~0.1x 计费） -->
      <div v-if="message.usage && message.usage.total_tokens > 0" class="usage-tag">
        📊 输入 {{ fmtTokens(message.usage.prompt_tokens) }}<span
          v-if="message.usage.cached_tokens > 0"
          class="cache-tag"
        >（缓存 {{ fmtTokens(message.usage.cached_tokens) }} · {{ cacheHitRate(message.usage) }}%）</span> · 输出 {{ fmtTokens(message.usage.completion_tokens) }}
      </div>
      <!-- Streaming cursor -->
      <span v-if="isStreaming" class="streaming-cursor">▊</span>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { decorateMarkdownFileLinks, resolveFileLinkClick } from '@/composables/useFileLinks'

const props = defineProps({
  message: {
    type: Object,
    required: true,
  },
  isStreaming: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['open-file', 'open-external'])

// 格式化 token 数：>=1000 显示为 1.2K，否则显示原始数字
function fmtTokens(n) {
  if (n == null) return '0'
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : String(n)
}

// 缓存命中率（服务端自动前缀缓存命中的输入 token 占比，越高越省）。
// usage 是"本轮所有 LLM 往返累加"的口径，分子分母同口径，比率仍然有意义。
function cacheHitRate(usage) {
  const prompt = usage && usage.prompt_tokens
  const cached = usage && usage.cached_tokens
  if (!prompt || !cached) return 0
  return Math.round((cached / prompt) * 100)
}

const mdBodyRef = ref(null)
const renderedHtml = ref('')

// Configure marked for safety
marked.setOptions({
  breaks: true,
  gfm: true,
})

// 流式期间节流阈值（毫秒）。
// 重渲染整段 markdown（marked + DOMPurify）+ 全量 DOM 遍历装饰链接，单次成本随内容长度线性增长；
// 若每个 chunk 都整段重跑，总开销随回答长度平方增长，是长回答打字卡顿的主因。
// 这里把"重渲染频率"与"token 到达频率"解耦：流式期间最多每 N 毫秒跑一次重渲染，
// 非流式（历史/已完成消息）与流式结束的最后一帧则立即完整渲染。
const RENDER_THROTTLE_MS = 150

let throttleTimer = null
let lastRenderedLen = 0

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// 把消息内容渲染成安全 HTML 并装饰可点击文件链接。
// v-html 在下一 tick 才 patch DOM，因此必须 await nextTick 后再装饰，否则装饰的是旧 DOM。
async function renderMarkdown() {
  const content = props.message?.content || ''
  lastRenderedLen = content.length
  try {
    // 净化后再渲染：AI 内容可能来自 read_file / search_web 等不可信来源，
    // 必须拦截 <script>、on* 事件、<iframe>、javascript: 等 XSS 向量。
    // DOMPurify 默认保留标题/列表/表格/代码块/链接/<svg> 等安全标签，正常 Markdown 显示不受影响。
    renderedHtml.value = DOMPurify.sanitize(marked.parse(content))
  } catch {
    renderedHtml.value = escapeHtml(content)
  }
  await nextTick()
  decorateMarkdownFileLinks(mdBodyRef.value)
}

// 流式节流（leading + trailing）：
//  - leading：本帧立即渲染一次，保证首个 chunk 立刻可见；
//  - throttleTimer 期间到达的中间 chunk 全部忽略（不再整段重跑）；
//  - trailing：定时器到点后，若内容又变长，补一次 catch-up 渲染。
function scheduleRender() {
  if (throttleTimer) return
  renderMarkdown()
  throttleTimer = setTimeout(() => {
    throttleTimer = null
    if ((props.message?.content || '').length !== lastRenderedLen) {
      renderMarkdown()
    }
  }, RENDER_THROTTLE_MS)
}

function stopThrottle() {
  if (throttleTimer) {
    clearTimeout(throttleTimer)
    throttleTimer = null
  }
}

// 内容变化：流式 → 节流重渲染；非流式（历史/已完成消息）→ 立即渲染一次
watch(
  () => props.message?.content,
  () => {
    if (props.isStreaming) scheduleRender()
    else renderMarkdown()
  }
)

// 流式结束：清空节流定时器，立即做一次完整渲染，避免末尾片段因节流而丢失
watch(
  () => props.isStreaming,
  (streaming) => {
    if (!streaming) {
      stopThrottle()
      renderMarkdown()
    }
  }
)

// 首次挂载渲染（完成消息只渲染一次；流式消息也先渲染已有内容）
onMounted(() => {
  renderMarkdown()
})

onBeforeUnmount(() => {
  stopThrottle()
})

// 容器级事件委托：转发给 ChatView → store.openFile / openExternal
function onContentClick(e) {
  const res = resolveFileLinkClick(e)
  if (!res) return
  e.preventDefault()
  emit(res.kind === 'file' ? 'open-file' : 'open-external', res.value)
}
</script>

<style scoped>
.message-bubble {
  display: flex;
  gap: 12px;
  padding: 12px 0;
  max-width: 800px;
  margin: 0 auto;
}

.message-bubble.user {
  flex-direction: row-reverse;
}

/* Avatar */
.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 4px;
}

.avatar.user {
  background: var(--accent);
  color: white;
}

.avatar.assistant {
  background: var(--bg-tertiary);
  color: var(--accent);
}

/* Content */
.bubble-content {
  max-width: 85%;
}

.role-label {
  font-size: calc(12px * var(--font-scale));
  color: var(--text-muted);
  margin-bottom: 4px;
  font-weight: 500;
}

.role-label .user + & {
  text-align: right;
}

/* Streaming cursor */
.streaming-cursor {
  display: inline-block;
  animation: pulse 1s infinite;
  color: var(--accent);
  margin-left: 2px;
}

/* 中断保留的半截回答标记 */
.partial-tag {
  margin-top: 10px;
  font-size: calc(12px * var(--font-scale));
  color: var(--text-muted);
  opacity: 0.85;
  display: inline-block;
  border: 1px dashed var(--border);
  border-radius: 4px;
  padding: 2px 8px;
}

/* Token 用量标签 */
.usage-tag {
  margin-top: 8px;
  font-size: calc(11px * var(--font-scale));
  color: var(--text-muted);
  opacity: 0.7;
}

/* 缓存命中部分：略提一点存在感，但仍弱于正文 */
.cache-tag {
  color: var(--accent);
}
</style>
