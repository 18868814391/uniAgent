<template>
  <div class="md-window">
    <!-- 顶部工具栏 -->
    <header class="md-header">
      <div class="md-title-wrap">
        <span class="md-title">📄 {{ name }}</span>
        <span class="md-path" :title="path">{{ path }}</span>
      </div>
      <div class="md-actions">
        <button class="md-btn" @click="openWithSystem" title="用系统默认程序打开此文件">外部打开</button>
        <button class="md-btn" @click="load" title="重新读取文件内容">刷新</button>
      </div>
    </header>

    <!-- 内容区 -->
    <div class="md-body">
      <div v-if="loading" class="md-state">加载中…</div>
      <div v-else-if="error" class="md-state md-error">加载失败：{{ error }}</div>
      <div
        v-else
        ref="contentRef"
        class="markdown-body md-content"
        v-html="rendered"
        @click="onContentClick"
      />
    </div>

    <!-- 轻提示 toast（打开其他文件失败时） -->
    <Transition name="toast">
      <div v-if="store.notice" class="md-notice">{{ store.notice.message }}</div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUpdated } from 'vue'
import { marked } from 'marked'
import { useAppStore } from '@/stores/app'
import { decorateMarkdownFileLinks, resolveFileLinkClick } from '@/composables/useFileLinks'

const store = useAppStore()

// 主进程 md-preview:open 以 index.html?view=md&path=<编码后的路径> 加载本窗口
const params = new URLSearchParams(window.location.search)
const path = params.get('path') || ''
const name = path.split(/[\\/]/).pop() || path

const content = ref('')
const loading = ref(!!path)
const error = ref('')
const contentRef = ref(null)

marked.setOptions({ breaks: true, gfm: true })

const rendered = computed(() => {
  if (!content.value) return ''
  try {
    return marked.parse(content.value)
  } catch {
    return content.value
  }
})

async function load() {
  if (!path) {
    error.value = '缺少文件路径参数'
    loading.value = false
    return
  }
  loading.value = true
  error.value = ''
  try {
    // file:read 返回 { success, content }
    const res = await window.electronAPI.readFile(path)
    if (res && res.success) {
      content.value = res.content
    } else {
      error.value = (res && res.error) || '读取文件失败'
    }
  } catch (e) {
    error.value = e.message || String(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  document.title = name ? `📄 ${name} — Local AI Open` : 'Local AI Open'
  decorateMarkdownFileLinks(contentRef.value)
  load()
})
onUpdated(() => {
  decorateMarkdownFileLinks(contentRef.value)
})

function onContentClick(e) {
  const res = resolveFileLinkClick(e)
  if (!res) return
  e.preventDefault()
  if (res.kind === 'file') {
    // md 链接 → 再开一个预览窗口；其他文件 → 系统默认程序打开（store 统一处理）
    store.openFile(res.value)
  } else {
    window.electronAPI.openExternal(res.value).catch(() => {})
  }
}

async function openWithSystem() {
  if (!path) return
  try {
    const res = await window.electronAPI.openPath(path)
    if (res && !res.success) store.showNotice(res.error || '无法打开文件', 'error')
  } catch (e) {
    store.showNotice(e.message || '无法打开文件', 'error')
  }
}
</script>

<style scoped>
.md-window {
  /* md 预览窗口固定浅色（白底深字），不随应用主题变色：
     在这里覆盖 CSS 变量，全局 .markdown-body 样式会跟随这些值渲染 */
  --bg-primary: #ffffff;
  --bg-secondary: #f1f5f9;
  --bg-tertiary: #e2e8f0;
  --bg-surface: #ffffff;
  --bg-input: #f1f5f9;
  --text-primary: #1f2937;
  --text-secondary: #4b5563;
  --text-muted: #94a3b8;
  --accent: #2563eb;
  --accent-hover: #1d4ed8;
  --border: #e5e7eb;

  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-primary);
}

.md-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.md-title-wrap {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}

.md-title {
  font-size: calc(14px * var(--font-scale));
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  flex-shrink: 0;
}

.md-path {
  font-size: calc(12px * var(--font-scale));
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
}

.md-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.md-btn {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: calc(12px * var(--font-scale));
  cursor: pointer;
  transition: all 0.2s;
}

.md-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.md-body {
  flex: 1;
  overflow-y: auto;
  padding: 28px 36px 56px;
  background: var(--bg-primary);
}

.md-content {
  max-width: 960px;
  margin: 0 auto;
  font-size: calc(15px * var(--font-scale));
}

.md-state {
  padding: 80px 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: calc(14px * var(--font-scale));
}

.md-error {
  color: var(--danger);
}

.md-notice {
  position: fixed;
  bottom: 40px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 300;
  padding: 10px 18px;
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  color: var(--danger);
  font-size: calc(13px * var(--font-scale));
  box-shadow: var(--shadow);
  max-width: 70%;
  text-align: center;
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
</style>
