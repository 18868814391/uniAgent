<template>
  <!-- 悬停判定挂在这个容器上（**不是**圆点按钮）：鼠标从圆点挪进气泡要跨过 12px 空隙，
       挂在按钮上会在离开按钮的一瞬间触发 mouseleave → 气泡在指尖前消失，里面的「重新检测」根本点不到。
       空隙由 .net-bubble::after 桥接（见样式），否则经过空隙时同样算作离开容器。 -->
  <div class="net-status" ref="wrapRef" @mouseenter="hoverOpen = true" @mouseleave="hoverOpen = false">
    <button
      type="button"
      class="status-dot"
      :class="[level, { blink: isBlinking }]"
      :aria-label="ariaLabel"
      :title="tooltip"
      @click.stop="onDotClick"
    ></button>

    <transition name="net-bubble">
      <div v-if="bubbleVisible" class="net-bubble" role="status" aria-live="polite">
        <div class="net-bubble-head">
          <span class="net-bubble-title">{{ title }}</span>
          <button type="button" class="net-bubble-close" aria-label="关闭提示" @click.stop="dismiss">×</button>
        </div>
        <p class="net-bubble-detail">{{ detail }}</p>
        <p v-if="advice" class="net-bubble-advice">{{ advice }}</p>
        <div class="net-bubble-foot">
          <span class="net-bubble-meta">{{ meta }}</span>
          <button type="button" class="net-bubble-action" :disabled="checking" @click.stop="recheck">
            {{ checking ? '检测中…' : '重新检测' }}
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
// ============================================================
//  右上角网络状态点
//
//  绿=正常、黄=较差、红=很差（黄/红会闪烁），另有「API 未配置」「检测中」两态。
//  数据来自主进程 net-health.js 的周期探测（结论经 store.netHealth 推送）。
//
//  气泡出现时机（**异常弹出来后只能由用户关掉**）：
//    · 黄/红 → 自动常驻显示，**一直挂着直到用户手动关**（点 × 或再点一次状态点）；
//      外面点一下不会关它 —— 否则你在别处点一下就消失，正好是这个提示最该在的时候。
//    · 绿/未配置/检测中 → 悬停或点状态点才看（悬停走开即收，这是"偷看"，不算异常弹出）。
//    · 同一档被手动关掉后不再自动弹，直到状态变化（避免反复打扰）；
//      网络恢复正常时清掉这个记忆，下次再坏还会弹。
//
//  ⚠️ 三个曾经让它"自己消失"的坑，都踩过：
//    ① 12 秒自动收起定时器 —— 已删（组件里现在不允许出现任何 setTimeout，
//       `tests/net-status-dot.test.js` 有代码级断言盯着）。
//    ② 主进程给失败证据设了 120s TTL —— 过期后探针回绿、气泡跟着收起。
//       现已改成**不设过期**，只有 dismiss() 才清（见 net-health.js 顶部注释）。
//    ③ 探针下个周期测回 good → level 变绿 → 气泡跟着收起（"异常解除"）。
//       用户要求：异常解除了也**不许**收起，气泡出现过就必须用户手动关。
//       修法是 alertLatched（钉住位）：黄/红一出现就钉住，之后 level 怎么变都不收起，
//       解除钉住的入口**只有 dismiss() 一个**。别再加第二条自动解除路径。
// ============================================================
import { ref, computed, watch } from 'vue'
import { useAppStore } from '@/stores/app'

const store = useAppStore()
const wrapRef = ref(null)
const hoverOpen = ref(false)
const manualOpen = ref(false)
// 异常（黄/红）一旦出现过就置位，之后 level 变绿也不收起 —— 直到用户 dismiss()。
// 「解除」入口只有 dismiss() 一个：别加任何按 level 变化自动复位的写法，
// 那等于把"异常解除就自动收起"又放回来了（用户明确不要）。
const alertLatched = ref(false)
const checking = ref(false)
// 记住用户手动关掉过哪一档；恢复正常态时重置，重新允许自动弹出
const dismissedLevel = ref('')

// >>> 可抽取纯逻辑 开始
// 气泡可见性规则。抽成纯函数是因为它才是这块 UI 唯一容易改错的地方
// （原来带一个 12s 自动收起定时器，用户嫌"网络还差着它自己就没了"），
// 而 .vue 在 Node 侧测不了 —— 约定见 tests/net-status-dot.test.js。
function isWarningLevel(level) {
  return level === 'degraded' || level === 'bad'
}

// 入参全是原始值，组件里用 computed 包一层调用。
// 规则：手动打开 → 显示；**被钉住（异常出现过）→ 显示，且不再受 level 变化影响**；
// 这一档被用户关过 → 隐藏（悬停也不弹）；黄/红 → 常驻显示，**不设自动收起**；
// 其余（绿/未配置/检测中）→ 悬停才显示。
//
// alertLatched 是「异常弹出」的钉住位：黄/红一出现就置位，之后 level 变绿也不收起
// —— 用户要求「异常解除了也不许自动关，必须手动关」。置位在组件侧的 level 监听里，
// **解除只有 dismiss() 一个**（别再加第二条自动解除路径，否则又变成"自己消失"）。
function computeBubbleVisible(input) {
  const level = input.level
  if (input.manualOpen) return true
  if (input.alertLatched) return true
  if (input.dismissedLevel === level) return false
  if (isWarningLevel(level)) return true
  return input.hoverOpen
}
// <<< 可抽取纯逻辑 结束

const snap = computed(() => store.netHealth || {})
const level = computed(() => snap.value.state || 'unknown')
const host = computed(() => snap.value.host || '模型服务')
const isWarning = computed(() => isWarningLevel(level.value))
const isBlinking = computed(() => isWarning.value)

const bubbleVisible = computed(() =>
  computeBubbleVisible({
    level: level.value,
    dismissedLevel: dismissedLevel.value,
    manualOpen: manualOpen.value,
    hoverOpen: hoverOpen.value,
    alertLatched: alertLatched.value,
  })
)

// 聊天侧刚报上来的失败证据（主进程带过来的，只在有效窗口内有值）。
// 有它时优先按它说话 —— 用户看到的是「刚才那一次请求为什么断」，
// 而不是「探针测出来怎么样」。
const chatFailure = computed(() => snap.value.chatFailure || null)

const title = computed(() => {
  if (chatFailure.value) {
    return level.value === 'degraded' ? '网络可能不稳定' : '网络异常'
  }
  switch (level.value) {
    case 'good':
      return '网络正常'
    case 'degraded':
      return '当前网络较差'
    case 'bad':
      return '当前网络很差'
    case 'unconfigured':
      return 'API 未配置'
    default:
      return '正在检测网络…'
  }
})

const failureTime = computed(() => {
  const f = chatFailure.value
  return f && f.at ? new Date(f.at).toLocaleTimeString() : ''
})

const detail = computed(() => {
  if (chatFailure.value) {
    const head = `最近一次请求被网络中断（${failureTime.value}）：${chatFailure.value.message || '连接被中断'}。`
    // 探针绿、但请求就是断了 —— 这是最容易让人困惑的情况，得说清楚，否则用户会以为误报
    return snap.value.probeState === 'good'
      ? `${head}短连接探测倒是通的，说明是长连接被中途掐断 —— 网络不稳的典型表现。`
      : head
  }
  switch (level.value) {
    case 'good':
      return `到 ${host.value} 的连接质量正常。`
    case 'degraded':
      return `到 ${host.value} 的响应偏慢，或时快时慢抖动明显。模型输出可能中途卡住。`
    case 'bad':
      return `到 ${host.value} 的连接超时或严重卡顿，模型输出很可能中断后重连。`
    case 'unconfigured':
      return '尚未填写 API Key，无法连接模型。'
    default:
      return '正在检测当前网络到模型服务的连通情况…'
  }
})

const advice = computed(() => {
  if (level.value === 'degraded' || level.value === 'bad') {
    return '建议切换到其它网络(不要使用IT内部网络)，或关闭 VPN 后重新检测。'
  }
  return ''
})

const fmt = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '--')

const meta = computed(() => {
  const s = snap.value
  if (level.value === 'unconfigured' || level.value === 'unknown') {
    return s.checkedAt ? `检测于 ${new Date(s.checkedAt).toLocaleTimeString()}` : ''
  }
  const parts = [`中位 ${fmt(s.medianMs)}`, `最慢 ${fmt(s.maxMs)}`, `失败 ${s.failures || 0}/${s.attempts || 0}`]
  if (s.checkedAt) parts.push(new Date(s.checkedAt).toLocaleTimeString())
  return parts.join(' · ')
})

const tooltip = computed(() => {
  if (level.value === 'unconfigured') return 'API 未配置'
  if (level.value === 'unknown') return '网络状态检测中'
  return `${title.value}（点击查看详情）`
})

const ariaLabel = computed(() => `${title.value}，点击查看网络详情`)

function onDotClick() {
  // 手动切换：开着就关（并记住这一档，别再自动弹），关着就开
  if (bubbleVisible.value) {
    dismiss()
  } else {
    manualOpen.value = true
    if (isWarning.value) recheck()
  }
}

function dismiss() {
  manualOpen.value = false
  hoverOpen.value = false
  // 解除钉住 —— **这里是 alertLatched 唯一的复位点**。用户手动关掉 = 已确认这次异常，
  // 此后才允许气泡随状态收起。加任何"level 恢复就复位"的写法都会让气泡自己消失。
  alertLatched.value = false
  // 只有警告态需要「记住关过」；正常态关掉后仍允许悬停再看
  if (isWarning.value) dismissedLevel.value = level.value
  // 关掉气泡 = 用户已确认这次异常。同时清掉主进程里的失败证据，
  // 否则圆点会一直被它按在红/黄上（证据不过期，只认显式清除）。
  if (chatFailure.value) store.clearNetHealthFailure().catch(() => {})
}

async function recheck() {
  if (checking.value) return
  checking.value = true
  try {
    const after = await store.refreshNetHealth(true)
    // 用户主动问了「现在好了吗」，而探针答「好了」→ 清掉旧证据，圆点回绿。
    // 注意只在**用户点了按钮**这条路径上做 —— 失败后那次自动补探绝不能清证据。
    if (chatFailure.value && after && after.probeState === 'good') {
      await store.clearNetHealthFailure()
    }
  } catch (e) {
    /* 探测失败不打扰用户：store 里已兜底 */
  } finally {
    checking.value = false
  }
}

// level 变化时做两件事：
//  ① 出现黄/红 → 置位 alertLatched，把气泡钉住（immediate 保证**挂载时就已经是黄/红**也会钉住，
//     否则它会一路显示到探针回绿，然后因为没钉住而随 level 变绿收起 —— 这就是要修的 bug）。
//  ② 恢复正常态 → 清掉「已关掉」的记忆，下次再掉到同一档还会自动弹。
// 注意 ② 绝不能顺手把 alertLatched 也清掉 —— 那等于"异常解除就自动收起"，
// 正是用户要求去掉的行为。alertLatched 的解除只归 dismiss()。
watch(
  level,
  (now) => {
    if (isWarningLevel(now)) {
      alertLatched.value = true
    } else {
      dismissedLevel.value = ''
    }
  },
  { immediate: true }
)
</script>

<style scoped>
.net-status {
  position: relative;
  display: flex;
  align-items: center;
  z-index: 300;
}

.status-dot {
  width: 10px;
  height: 10px;
  padding: 0;
  border: none;
  border-radius: 50%;
  margin-left: 6px;
  cursor: pointer;
  flex-shrink: 0;
  background: var(--text-muted);
  transition: background 0.3s, box-shadow 0.3s;
  /* 顶栏是拖拽区，交互元素必须排除，否则点不动 */
  -webkit-app-region: no-drag;
}

.status-dot:hover {
  transform: scale(1.15);
}

.status-dot:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.status-dot.good {
  background: var(--success);
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.5);
}

.status-dot.degraded {
  background: var(--warning);
  box-shadow: 0 0 8px rgba(245, 158, 11, 0.6);
}

.status-dot.bad {
  background: var(--danger);
  box-shadow: 0 0 8px rgba(239, 68, 68, 0.6);
}

.status-dot.unconfigured {
  background: var(--danger);
}

.status-dot.unknown {
  background: var(--text-muted);
}

.status-dot.blink {
  animation: net-dot-blink 1.1s ease-in-out infinite;
}

@keyframes net-dot-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.2;
  }
}

@media (prefers-reduced-motion: reduce) {
  .status-dot.blink {
    animation: none;
  }
}

/* ---------- 气泡 ---------- */
.net-bubble {
  position: absolute;
  top: calc(100% + 12px);
  right: 0;
  width: 300px;
  padding: 12px 14px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
  text-align: left;
  cursor: default;
  -webkit-app-region: no-drag;
}

.net-bubble::before {
  content: '';
  position: absolute;
  top: -5px;
  right: 12px;
  width: 8px;
  height: 8px;
  background: var(--bg-surface);
  border-left: 1px solid var(--border);
  border-top: 1px solid var(--border);
  transform: rotate(45deg);
}

/* 圆点与气泡之间那 12px 空隙（.net-bubble 的 top: calc(100% + 12px)）必须仍然算在容器内：
   它是透明的、看不见，但能把鼠标"接"住，否则移到一半就触发 .net-status 的 mouseleave、气泡当场消失。 */
.net-bubble::after {
  content: '';
  position: absolute;
  top: -14px;
  right: 0;
  width: 100%;
  height: 14px;
}

.net-bubble-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.net-bubble-title {
  font-size: calc(13px * var(--font-scale));
  font-weight: 600;
  color: var(--text-primary);
}

.net-bubble-close {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: calc(16px * var(--font-scale));
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
}

.net-bubble-close:hover {
  color: var(--text-primary);
}

.net-bubble-detail {
  margin: 0;
  font-size: calc(12px * var(--font-scale));
  color: var(--text-secondary);
  line-height: 1.5;
}

.net-bubble-advice {
  margin: 6px 0 0;
  font-size: calc(12px * var(--font-scale));
  color: var(--warning);
  line-height: 1.5;
}

.net-bubble-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.net-bubble-meta {
  font-size: calc(11px * var(--font-scale));
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.net-bubble-action {
  flex-shrink: 0;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: calc(11px * var(--font-scale));
  cursor: pointer;
  transition: all 0.2s;
}

.net-bubble-action:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.net-bubble-action:disabled {
  opacity: 0.6;
  cursor: default;
}

/* 气泡进出场 */
.net-bubble-enter-active,
.net-bubble-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.net-bubble-enter-from,
.net-bubble-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
