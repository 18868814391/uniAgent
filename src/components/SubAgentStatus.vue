<template>
  <div v-if="subAgents.length > 0" class="subagent-area">
    <div class="subagent-summary">
      <svg v-if="runningCount > 0" class="subagent-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 12a9 9 0 11-6.219-8.56" />
      </svg>
      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      <span v-if="runningCount > 0">🔀 {{ runningCount }} 个子任务执行中…</span>
      <span v-else-if="errorCount > 0">⚠️ {{ subAgents.length }} 个子任务完成（{{ errorCount }} 个出错）</span>
      <span v-else>✓ {{ subAgents.length }} 个子任务已完成</span>
    </div>
    <div v-for="sa in subAgents" :key="sa.subAgentId" class="subagent-item">
      <div class="subagent-row">
        <svg v-if="isFailed(sa)" class="subagent-err" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        <svg v-else-if="isDone(sa)" class="subagent-ok" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <svg v-else class="subagent-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12a9 9 0 11-6.219-8.56" />
        </svg>
        <span class="subagent-label">{{ sa.description || truncateTask(sa.task) }}</span>
        <span v-if="sa.duration" class="subagent-duration">{{ sa.duration }}s</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  subAgents: { type: Array, default: () => [] },
})

// 状态词表（与主进程 sub-agent.js 对齐）：
//   running   → 已派发、执行中
//   completed → 正常结束
//   error / aborted → 失败或中断
// 判定原则：**显式列出终态**，其余一律当"执行中"。
// 反过来写（只有看到 running 才算运行）会把任何未知/新增状态都谎报成"已完成"——
// 历史上主进程派发时发的是 'started'，就是这么把界面显示成"2 个子任务已完成"的。
const isDone = (s) => s.status === 'completed'
const isFailed = (s) => s.status === 'error' || s.status === 'aborted'

const runningCount = computed(() => props.subAgents.filter(s => !isDone(s) && !isFailed(s)).length)
const errorCount = computed(() => props.subAgents.filter(isFailed).length)

function truncateTask(task) {
  return task && task.length > 40 ? task.slice(0, 40) + '…' : task
}
</script>

<style scoped>
.subagent-area {
  margin: 0 12px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  overflow: hidden;
}

.subagent-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: calc(12px * var(--font-scale));
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}

.subagent-item {
  padding: 4px 10px;
}

.subagent-item:last-child {
  padding-bottom: 6px;
}

.subagent-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(12px * var(--font-scale));
  color: var(--text-muted);
}

.subagent-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subagent-duration {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.subagent-ok {
  color: var(--success, #22c55e);
  flex-shrink: 0;
}

.subagent-err {
  color: var(--danger, #ef4444);
  flex-shrink: 0;
}

.subagent-spin {
  flex-shrink: 0;
  animation: subagent-rotate 1s linear infinite;
}

@keyframes subagent-rotate {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
