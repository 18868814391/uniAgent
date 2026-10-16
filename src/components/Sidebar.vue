<template>
  <div class="sidebar" :class="{ collapsed: !store.sidebarOpen }">
    <!-- New Chat Button + 历史记录搜索 -->
    <div class="sidebar-header">
      <button class="new-chat-btn" @click="store.newConversation">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>新对话</span>
      </button>

      <!-- 历史记录搜索框：匹配标题 + 消息内容（主进程读消息文件），防抖 300ms -->
      <div class="search-box">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          v-model="searchQuery"
          class="search-input"
          type="text"
          placeholder="搜索历史记录..."
          spellcheck="false"
        />
        <button v-if="searchQuery" class="search-clear" @click="searchQuery = ''" title="清除搜索">
          ×
        </button>
      </div>
    </div>

    <!-- Conversation List（默认，未搜索时） -->
    <div v-if="!searchQuery.trim()" class="conv-list">
      <div
        v-for="conv in store.conversations"
        :key="conv.id"
        class="conv-item"
        :class="{ active: conv.id === store.currentConvId, generating: store.isConvStreaming(conv.id) }"
        @click="store.switchConversation(conv.id)"
      >
        <!-- 标记色点：点一下循环换色，转完一圈回到无色 = 取消标记。
             绝对定位贴在左内边距里（不占 flex 宽度），因此 260px 窄侧栏的标题不会被挤窄 -->
        <button
          class="conv-flag"
          :class="conv.flag ? 'flagged' : 'unflagged'"
          :style="conv.flag ? { background: conv.flag } : null"
          :title="conv.flag ? '已标记：点击换色，转完一圈即取消标记' : '点击标记此会话'"
          @click.stop="cycleFlag(conv)"
        ></button>
        <div class="conv-content">
          <div class="conv-title">{{ conv.title }}</div>
          <div class="conv-meta">
            {{ formatConvTime(conv.updatedAt) }} · {{ conv.messageCount }} 条消息
          </div>
        </div>
        <button
          class="conv-action conv-archive"
          :disabled="archivingId === conv.id"
          :title="archivingId === conv.id ? '归档中…' : '归档为 Markdown'"
          @click.stop="archiveConv(conv.id)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="4" width="20" height="5" rx="1" />
            <path d="M4 9v10a1 1 0 001 1h14a1 1 0 001-1V9" />
            <path d="M10 13h4" />
          </svg>
        </button>
        <button
          class="conv-action conv-delete"
          @click.stop="confirmDelete(conv.id)"
          title="删除对话"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
          </svg>
        </button>
      </div>

      <!-- Empty state -->
      <div v-if="store.conversations.length === 0" class="conv-empty">
        暂无对话记录
      </div>
    </div>

    <!-- Search Results（搜索中） -->
    <div v-else class="conv-list">
      <div v-if="isSearching" class="conv-empty">搜索中…</div>
      <template v-else-if="searchResults && searchResults.length > 0">
        <div
          v-for="r in searchResults"
          :key="r.id"
          class="conv-item"
          :class="{ active: r.id === store.currentConvId }"
          @click="selectSearchResult(r)"
        >
          <div class="conv-content">
            <div class="conv-title" v-html="highlight(r.title)" />
            <div class="conv-meta">
              {{ formatConvTime(r.updatedAt) }} · {{ r.messageCount }} 条消息
              <span class="conv-match-tag">{{ r.titleHit ? '标题匹配' : '内容匹配' }}</span>
            </div>
            <div v-if="r.snippet" class="conv-snippet" v-html="highlight(r.snippet)" />
          </div>
        </div>
      </template>
      <div v-else class="conv-empty">未找到相关记录</div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onUnmounted } from 'vue'
import { useAppStore } from '@/stores/app'

const store = useAppStore()

// ========== 会话标记色点 ==========
// 同一天开多个会话时，用户点色点循环换色做临时区分（标记只存在本机会话索引里）。
// 顺序：红 → 橙 → 绿 → 蓝 → 紫 → 粉 → 无色（取消标记）
const FLAG_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899']

async function cycleFlag(conv) {
  const cur = typeof conv.flag === 'string' ? conv.flag.toLowerCase() : ''
  const i = FLAG_COLORS.indexOf(cur)
  const next = i < 0 || i + 1 >= FLAG_COLORS.length ? (i < 0 ? FLAG_COLORS[0] : null) : FLAG_COLORS[i + 1]
  await store.setConversationFlag(conv.id, next)
}

// ========== 历史记录搜索 ==========
const searchQuery = ref('')
const searchResults = ref(null) // null = 未搜索；数组 = 搜索到的记录
const isSearching = ref(false)
let searchTimer = null
let searchSeq = 0 // 请求序号，防止快速输入时旧请求覆盖新结果

watch(searchQuery, () => {
  clearTimeout(searchTimer)
  const q = searchQuery.value.trim()
  if (!q) {
    searchSeq++ // 使在途请求失效
    searchResults.value = null
    isSearching.value = false
    return
  }
  const seq = ++searchSeq
  isSearching.value = true
  searchTimer = setTimeout(async () => {
    try {
      const res = await window.electronAPI.searchConversations(q)
      if (seq === searchSeq) searchResults.value = res || []
    } catch (e) {
      console.error('[search] 搜索历史记录失败:', e)
      if (seq === searchSeq) searchResults.value = []
    } finally {
      if (seq === searchSeq) isSearching.value = false
    }
  }, 300)
})

onUnmounted(() => clearTimeout(searchTimer))

// 命中关键字高亮：先转义 HTML 再包 <mark>，避免消息内容里的标签被注入页面
function highlight(text) {
  if (!text) return ''
  const esc = String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const q = searchQuery.value.trim()
  if (!q) return esc
  const i = esc.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return esc
  return esc.slice(0, i) + '<mark>' + esc.slice(i, i + q.length) + '</mark>' + esc.slice(i + q.length)
}

// 点搜索结果：切到对应会话并清空搜索，回到正常列表
function selectSearchResult(r) {
  store.switchConversation(r.id)
  searchQuery.value = ''
}

function pad(n) {
  return String(n).padStart(2, '0')
}

// 历史记录时间显示：统一直接展示 年月日-时分（YYYY-MM-DD HH:mm）
function formatConvTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function confirmDelete(id) {
  const confirmed = await window.electronAPI.showConfirmDialog('确定删除此对话？')
  if (confirmed) {
    store.deleteConversation(id)
  }
}

// ========== 会话归档 ==========
// 归档中：主进程写完文件会弹原生对话框，等用户关掉才返回，期间按钮置灰防重复点击
const archivingId = ref(null)

async function archiveConv(id) {
  if (archivingId.value) return
  archivingId.value = id
  try {
    await store.archiveConversation(id)
  } finally {
    archivingId.value = null
  }
}
</script>

<style scoped>
.sidebar {
  --sidebar-w: 260px;
  width: var(--sidebar-w);
  min-width: var(--sidebar-w);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border);
  transition: width 0.2s, min-width 0.2s;
  overflow: hidden;
}

/* 折叠过渡只作用于外框宽度（260px ↔ 0），内部内容始终按 var(--sidebar-w) 满宽渲染，
   收起时整体左移一个自身宽度、由外框裁切。
   不能让内容跟着外框逐帧压缩：「新对话」按钮文字、会话卡片的「时间 · 条数」行
   会在动画途中因宽度不足换行（一闪而过的抖动）。
   内容右边缘 = 自身宽度 - 位移，与容器右边缘同步收放，过程中不会露出空隙。 */
.sidebar > .sidebar-header,
.sidebar > .conv-list {
  width: var(--sidebar-w);
  transition: transform 0.2s;
}

.sidebar.collapsed {
  width: 0;
  min-width: 0;
  border-right: none;
}

.sidebar.collapsed > .sidebar-header,
.sidebar.collapsed > .conv-list {
  transform: translateX(-100%);
}

/* Header / New Chat */
.sidebar-header {
  padding: 12px;
  flex-shrink: 0;
}

.new-chat-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 10px;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: var(--radius-sm);
  font-size: calc(14px * var(--font-scale));
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}

.new-chat-btn:hover {
  background: var(--accent-hover);
}

/* Search box */
.search-box {
  position: relative;
  margin-top: 8px;
}

.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  color: var(--text-muted);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 8px 30px 8px 30px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: calc(13px * var(--font-scale));
  outline: none;
  transition: border-color 0.2s;
}

.search-input:focus {
  border-color: var(--accent);
}

.search-input::placeholder {
  color: var(--text-muted);
}

.search-clear {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: calc(15px * var(--font-scale));
  line-height: 1;
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.search-clear:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

/* Conversation list */
.conv-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
}

.conv-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.15s;
  margin-bottom: 2px;
  position: relative; /* 标记色点的定位参照（点放在左内边距里，不占布局） */
}

.conv-item:hover {
  background: var(--bg-input);
}

.conv-item.active {
  background: var(--bg-surface);
  border-left: 3px solid var(--accent);
}

.conv-content {
  flex: 1;
  overflow: hidden;
}

.conv-title {
  font-size: calc(13px * var(--font-scale));
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}

.conv-meta {
  font-size: calc(11px * var(--font-scale));
  color: var(--text-muted);
  margin-top: 2px;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 生成中：卡片背景呼吸变色（原来在 meta 行显示「● 生成中」文字，
   但 260px 窄侧栏里多一行文字会被挤到换行、破坏卡片布局，改为整卡呼吸提示）。
   取色用 --accent-glow（= 主题强调色的半透明版，16 套内置主题与自定义主色都会派生它），
   因此呼吸色自动跟随主题色/自定义主色，无需额外变量。 */
.conv-item.generating {
  animation: convGeneratingBreathe 1.6s ease-in-out infinite;
}

/* 选中态卡片有自己的底色（--bg-surface），呼吸时从底色起步，避免选中卡片在呼吸谷底"掉色" */
.conv-item.active.generating {
  animation-name: convGeneratingBreatheOnActive;
}

@keyframes convGeneratingBreathe {
  0%, 100% { background-color: transparent; }
  50% { background-color: var(--accent-glow); }
}

@keyframes convGeneratingBreatheOnActive {
  0%, 100% { background-color: var(--bg-surface); }
  50% { background-color: var(--accent-glow); }
}

.conv-match-tag {
  font-size: calc(10px * var(--font-scale));
  color: var(--accent);
  border: 1px solid currentColor;
  border-radius: 3px;
  padding: 0 4px;
  opacity: 0.9;
}

.conv-snippet {
  font-size: calc(11px * var(--font-scale));
  color: var(--text-muted);
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 会话项右侧操作按钮：归档 / 删除 */
.conv-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.conv-archive:hover:not(:disabled) {
  color: var(--accent);
  background: var(--bg-tertiary);
}

.conv-action:disabled {
  opacity: 0.45;
  cursor: default;
}

.conv-delete:hover {
  color: var(--danger);
  background: rgba(239, 68, 68, 0.1);
}

.conv-empty {
  text-align: center;
  color: var(--text-muted);
  font-size: calc(13px * var(--font-scale));
  padding: 24px 12px;
}

/* 会话标记色点：绝对定位在左内边距（12px）里，**不参与 flex 布局** ——
   260px 窄侧栏里标题每让出 12px 就多一行截断，所以色点不能挤到标题。
   未标记：淡虚线圈，鼠标移到卡片上才变亮；已标记：实心色点（颜色由内联 style 给）。 */
.conv-flag {
  position: absolute;
  left: 1px;
  top: 50%;
  transform: translateY(-50%);
  width: 10px;
  height: 10px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
  transition: transform 0.15s, opacity 0.15s, color 0.15s;
}

/* 选中卡片有 3px 左边框，色点跟着右移，保持与标题的间距不变 */
.conv-item.active .conv-flag {
  left: 4px;
}

.conv-flag.unflagged {
  border: 1px dashed currentColor;
  color: var(--text-muted);
  opacity: 0.3;
}

/* 鼠标移到卡片上：圈圈改用主题强调色且完全不透明。
   原来是 --text-muted + 0.85 不透明度，浅色主题下几乎与背景同色，很容易被忽视。 */
.conv-item:hover .conv-flag.unflagged {
  color: var(--accent);
  opacity: 1;
}

/* 直接悬在圈上：虚线转实线，配合通用的 scale(1.3) 明确「可点击」。
   选择器带 .conv-item 前缀是为了压过上面那条卡片级 hover（同族里更具体者胜）。 */
.conv-item .conv-flag.unflagged:hover {
  border-style: solid;
}

.conv-flag:hover {
  transform: translateY(-50%) scale(1.3);
}

/* 搜索命中高亮（v-html 注入的内容需要用 :deep 才能命中 scoped 样式） */
.conv-title :deep(mark),
.conv-snippet :deep(mark) {
  background: var(--accent);
  color: #fff;
  border-radius: 2px;
  padding: 0 1px;
}
</style>
