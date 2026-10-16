<template>
  <div class="app-container" :style="{ '--font-scale': store.fontScale }">
    <!-- Title Bar -->
    <header class="app-header">
      <div class="header-left">
        <button class="sidebar-toggle" @click="store.sidebarOpen = !store.sidebarOpen; store.showSettings = false" title="切换侧边栏 / 返回聊天">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div class="app-logo" @click="store.showSettings = false" title="返回聊天">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
        </div>
        <h1 class="app-title" @click="store.showSettings = false" title="返回聊天">Local AI Open</h1>
        <span v-if="store.activeProfile" class="active-profile-name">{{ store.activeProfile.name }}</span>
      </div>
      <div class="header-right">
        <button
          class="header-btn"
          @click="openHelp"
          title="帮助"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </button>
        <!-- Role Selector（通用 / 产品 / 测试） -->
        <div class="role-picker" ref="rolePickerRef">
          <button
            class="header-btn role-btn"
            :class="{ active: showRolePicker }"
            @click="toggleRolePicker"
            :title="'当前角色：' + currentRole.label + '（产品=原型/PRD，测试=白盒审查+黑盒引导）'"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
            </svg>
            <span class="role-btn-label">{{ currentRole.label }}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <div v-if="showRolePicker" class="role-popup">
            <div class="role-popup-title">AI 角色</div>
            <button
              v-for="r in roles"
              :key="r.value"
              class="role-option"
              :class="{ active: store.settings.role === r.value, restricted: !store.canSwitchRole(r.value) }"
              :disabled="!store.canSwitchRole(r.value)"
              :title="store.canSwitchRole(r.value) ? '' : '您当前暂无该身份'"
              @click="switchRole(r.value)"
            >
              <span class="role-option-name">{{ r.label }}</span>
              <span class="role-option-desc">{{ r.desc }}</span>
              <span v-if="!store.canSwitchRole(r.value)" class="role-option-locked">暂无权限</span>
            </button>
          </div>
        </div>
        <!-- Theme Color Picker -->
        <div class="theme-picker" ref="themePickerRef">
          <button
            class="header-btn theme-btn"
            @click="showThemePicker = !showThemePicker"
            title="主题颜色"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="5" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
          </button>
          <div v-if="showThemePicker" class="theme-popup">
            <div class="theme-popup-title">主题方案</div>
            <div class="theme-presets">
              <button
                v-for="t in themes"
                :key="t.name"
                class="theme-card"
                :class="{ active: store.themeName === t.name }"
                @click="setTheme(t)"
              >
                <div class="theme-preview">
                  <span class="tp-bg" :style="{ background: t.vars['--bg-primary'] }"></span>
                  <span class="tp-bg2" :style="{ background: t.vars['--bg-secondary'] }"></span>
                  <span class="tp-accent" :style="{ background: t.vars['--accent'] }"></span>
                </div>
                <span class="theme-card-label">{{ t.label }}</span>
              </button>
            </div>
            <!-- 自定义主色：选一个主色，按规则自动生成整套浅色主题 -->
            <div class="theme-custom-section">
              <div class="theme-popup-title">自定义主色</div>
              <label class="theme-custom-label">
                <span class="theme-custom-name">选择主色</span>
                <input
                  type="color"
                  class="color-input-native"
                  :value="store.customTheme || '#3b82f6'"
                  @input="onCustomColor($event.target.value)"
                />
              </label>
            </div>
            <!-- 字号 -->
            <div class="theme-font-section">
              <div class="theme-popup-title">字号</div>
              <div class="font-scale-options">
                <button
                  v-for="f in fontScales"
                  :key="f.value"
                  class="font-scale-btn"
                  :class="{ active: store.fontScale === f.value }"
                  @click="setFontScale(f.value)"
                >
                  {{ f.label }}
                </button>
              </div>
            </div>
          </div>
        </div>
        <button
          class="header-btn"
          :class="{ active: store.showSettings }"
          @click="store.showSettings = !store.showSettings"
          title="设置"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </button>
        <!-- 网络状态点：绿=正常，黄/红闪烁=当前网络较差/很差（点击看详情与建议） -->
        <NetStatusDot />
      </div>
    </header>

    <!-- Main content -->
    <div class="app-body">
      <template v-if="!store.showSettings">
        <Sidebar />
        <div class="main-area">
          <ChatView />
        </div>
      </template>
      <SettingsPanel v-else />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useAppStore } from '@/stores/app'
import { generateCustomTheme, hexToRgba } from '@/composables/themeGen'
import ChatView from '@/components/ChatView.vue'
import Sidebar from '@/components/Sidebar.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import NetStatusDot from '@/components/NetStatusDot.vue'

const store = useAppStore()
const showThemePicker = ref(false)
const themePickerRef = ref(null)
const showRolePicker = ref(false)
const rolePickerRef = ref(null)

// 可选角色：通用 / 产品 / 测试（产品与测试角色各自加载 harness 物料库：技能、系统提示词）
const roles = [
  { value: 'general', label: '通用角色', desc: '日常问答、文件、技能、ERP 查询' },
  { value: 'excel', label: 'Excel专家', desc: '数据分析/清洗/公式/图表/批量处理' },
  { value: 'legal', label: '法务专家', desc: '合同审查/条款抽取/风险标注/文书草拟（附免责声明）' },
  { value: 'product', label: '产品角色', desc: '原型设计 / PRD，对齐已有前端 UI，可反问澄清' },
  { value: 'qa', label: '测试角色', desc: '白盒测试为主（代码路径+用例→测试报告），黑盒为辅（用户引导浏览器操作）' },
  { value: 'dev', label: '开发角色', desc: '全量文件访问，开发调试' },
]

const currentRole = computed(() => {
  return roles.find(r => r.value === store.settings.role) || roles[0]
})

async function switchRole(value) {
  if (value === store.settings.role) {
    showRolePicker.value = false
    return
  }
  showRolePicker.value = false
  await store.switchRole(value)
}

// 打开角色面板
function toggleRolePicker() {
  showRolePicker.value = !showRolePicker.value
}

// Full theme definitions with all CSS variables
const themes = [
  // ===== 深色系 =====
  {
    name: 'deep-blue', label: '深蓝',
    vars: {
      '--bg-primary': '#1a1a2e', '--bg-secondary': '#16213e', '--bg-tertiary': '#0f3460',
      '--bg-surface': '#1e2749', '--bg-input': '#252d4a',
      '--text-primary': '#e8e8e8', '--text-secondary': '#a0a0b8', '--text-muted': '#6b7280',
      '--accent': '#4f8cff', '--accent-hover': '#3a7bff',
      '--accent-glow': 'rgba(79, 140, 255, 0.3)', '--border': '#2a3350',
      '--user-bubble': '#2b3a6b', '--assistant-bubble': '#1e2749',
      '--danger': '#ef4444', '--success': '#22c55e', '--warning': '#f59e0b',
      '--shadow': '0 4px 24px rgba(0, 0, 0, 0.3)',
      '--radius': '12px', '--radius-sm': '8px', '--radius-xs': '4px',
    },
  },
  {
    name: 'slate', label: '石板灰',
    vars: {
      '--bg-primary': '#111827', '--bg-secondary': '#1f2937', '--bg-tertiary': '#374151',
      '--bg-surface': '#1f2937', '--bg-input': '#2d3748',
      '--text-primary': '#f1f5f9', '--text-secondary': '#94a3b8', '--text-muted': '#64748b',
      '--accent': '#14b8a6', '--accent-hover': '#0d9488',
      '--accent-glow': 'rgba(20, 184, 166, 0.3)', '--border': '#334155',
      '--user-bubble': '#1e293b', '--assistant-bubble': '#1f2937',
      '--danger': '#ef4444', '--success': '#22c55e', '--warning': '#f59e0b',
      '--shadow': '0 4px 24px rgba(0, 0, 0, 0.3)',
      '--radius': '12px', '--radius-sm': '8px', '--radius-xs': '4px',
    },
  },
  {
    name: 'ocean', label: '海洋',
    vars: {
      '--bg-primary': '#0f172a', '--bg-secondary': '#0f2a3a', '--bg-tertiary': '#164863',
      '--bg-surface': '#1a3348', '--bg-input': '#1e3a5a',
      '--text-primary': '#e0f2fe', '--text-secondary': '#7dd3fc', '--text-muted': '#4a8aa8',
      '--accent': '#38bdf8', '--accent-hover': '#0ea5e9',
      '--accent-glow': 'rgba(56, 189, 248, 0.3)', '--border': '#1e4d6a',
      '--user-bubble': '#0f3a5a', '--assistant-bubble': '#1a3348',
      '--danger': '#f87171', '--success': '#34d399', '--warning': '#fbbf24',
      '--shadow': '0 4px 24px rgba(0, 0, 0, 0.4)',
      '--radius': '12px', '--radius-sm': '8px', '--radius-xs': '4px',
    },
  },
  // ===== 亮色系 =====
  {
    name: 'dark-grape', label: '暗夜紫',
    vars: {
      '--bg-primary': '#1e1b2e', '--bg-secondary': '#262138', '--bg-tertiary': '#322a4a',
      '--bg-surface': '#28243d', '--bg-input': '#322a4a',
      '--text-primary': '#ece9f5', '--text-secondary': '#b3aacb', '--text-muted': '#7a7096',
      '--accent': '#a855f7', '--accent-hover': '#9333ea',
      '--accent-glow': 'rgba(168, 85, 247, 0.3)', '--border': '#3a3357',
      '--user-bubble': '#3a2f52', '--assistant-bubble': '#28243d',
      '--danger': '#ef4444', '--success': '#22c55e', '--warning': '#f59e0b',
      '--shadow': '0 4px 24px rgba(0, 0, 0, 0.35)',
      '--radius': '12px', '--radius-sm': '8px', '--radius-xs': '4px',
    },
  },
  {
    name: 'light-warm', label: '暖白',
    vars: {
      '--bg-primary': '#faf6f0', '--bg-secondary': '#fffcf7', '--bg-tertiary': '#f0e8de',
      '--bg-surface': '#fffcf7', '--bg-input': '#f0e8de',
      '--text-primary': '#1c1917', '--text-secondary': '#57534e', '--text-muted': '#a8a29e',
      '--accent': '#f97316', '--accent-hover': '#ea580c',
      '--accent-glow': 'rgba(249, 115, 22, 0.2)', '--border': '#e7e5e4',
      '--user-bubble': '#ffedd5', '--assistant-bubble': '#fffcf7',
      '--danger': '#ef4444', '--success': '#22c55e', '--warning': '#f59e0b',
      '--shadow': '0 4px 24px rgba(0, 0, 0, 0.08)',
      '--radius': '12px', '--radius-sm': '8px', '--radius-xs': '4px',
    },
  },
  {
    // 主色由青绿 #059669（emerald，偏青、饱和度高）改为更柔和的浅绿色 #66bb6a：
    // 降饱和（81%→约 45%）、去青味（色相 163°→约 122°），观感更软更浅；
    // hover 同步加深到 #4fa354，glow / border 随之协调。背景仍为浅绿系（#ecfdf5/#d1fae5）。
    name: 'light-green', label: '青绿',
    vars: {
      '--bg-primary': '#ecfdf5', '--bg-secondary': '#f0fdf4', '--bg-tertiary': '#d1fae5',
      '--bg-surface': '#f0fdf4', '--bg-input': '#d1fae5',
      '--text-primary': '#022c22', '--text-secondary': '#065f46', '--text-muted': '#6b7280',
      '--accent': '#66bb6a', '--accent-hover': '#4fa354',
      '--accent-glow': 'rgba(102, 187, 106, 0.2)', '--border': '#c8e6c9',
      '--user-bubble': '#d1fae5', '--assistant-bubble': '#f0fdf4',
      '--danger': '#ef4444', '--success': '#22c55e', '--warning': '#f59e0b',
      '--shadow': '0 4px 24px rgba(0, 0, 0, 0.08)',
      '--radius': '12px', '--radius-sm': '8px', '--radius-xs': '4px',
    },
  },
  {
    name: 'light-sky', label: '天空',
    vars: {
      '--bg-primary': '#f0faff', '--bg-secondary': '#f7fcff', '--bg-tertiary': '#dceefb',
      '--bg-surface': '#f7fcff', '--bg-input': '#dceefb',
      '--text-primary': '#0c2340', '--text-secondary': '#2c5282', '--text-muted': '#63b3ed',
      '--accent': '#3182ce', '--accent-hover': '#2b6cb0',
      '--accent-glow': 'rgba(49, 130, 206, 0.2)', '--border': '#bee3f8',
      '--user-bubble': '#dceefb', '--assistant-bubble': '#f7fcff',
      '--danger': '#ef4444', '--success': '#22c55e', '--warning': '#f59e0b',
      '--shadow': '0 4px 24px rgba(0, 0, 0, 0.07)',
      '--radius': '12px', '--radius-sm': '8px', '--radius-xs': '4px',
    },
  },
  {
    name: 'light-lavender', label: '薰衣草',
    vars: {
      '--bg-primary': '#f8f6ff', '--bg-secondary': '#fcfbff', '--bg-tertiary': '#ede9fe',
      '--bg-surface': '#fcfbff', '--bg-input': '#ede9fe',
      '--text-primary': '#2d1b69', '--text-secondary': '#6d28d9', '--text-muted': '#c4b5fd',
      '--accent': '#8b5cf6', '--accent-hover': '#7c3aed',
      '--accent-glow': 'rgba(139, 92, 246, 0.2)', '--border': '#ddd6fe',
      '--user-bubble': '#ede9fe', '--assistant-bubble': '#fcfbff',
      '--danger': '#ef4444', '--success': '#22c55e', '--warning': '#f59e0b',
      '--shadow': '0 4px 24px rgba(0, 0, 0, 0.07)',
      '--radius': '12px', '--radius-sm': '8px', '--radius-xs': '4px',
    },
  },
  {
    name: 'light-ice', label: '冰川',
    vars: {
      '--bg-primary': '#f1f7f9', '--bg-secondary': '#f8fbfc', '--bg-tertiary': '#def0f2',
      '--bg-surface': '#f8fbfc', '--bg-input': '#def0f2',
      '--text-primary': '#0a2a36', '--text-secondary': '#2c7a8a', '--text-muted': '#81c3d4',
      '--accent': '#0e7490', '--accent-hover': '#155e75',
      '--accent-glow': 'rgba(14, 116, 144, 0.2)', '--border': '#cffafe',
      '--user-bubble': '#def0f2', '--assistant-bubble': '#f8fbfc',
      '--danger': '#ef4444', '--success': '#22c55e', '--warning': '#f59e0b',
      '--shadow': '0 4px 24px rgba(0, 0, 0, 0.07)',
      '--radius': '12px', '--radius-sm': '8px', '--radius-xs': '4px',
    },
  },
  {
    // 樱花：取「粉白」观感 —— 底几乎为白，只掺一层极淡樱粉；主色用 #f06292（樱粉），
    // 比先前的 #ea4c89 更亮更淡（明度 60→67），仍是明确的粉，不偏红不偏玫。
    // 取舍：主色越淡，白字越难读 —— #f06292 对白字对比 3.06:1，低于 WCAG AA 4.5，
    // 故实底按钮上的文字仅粗体大字可辨；hover 加深到 #e05286（3.67:1）时清晰度回升。
    // 若更在意按钮文字清晰度，把 --accent 调回 #ea4c89（3.56:1）即可，粉味保留大半。
    name: 'light-sakura', label: '樱花',
    vars: {
      '--bg-primary': '#fffbfc', '--bg-secondary': '#fffdfd', '--bg-tertiary': '#fdeaf1',
      '--bg-surface': '#fffdfd', '--bg-input': '#fdeaf1',
      '--text-primary': '#3b0a1e', '--text-secondary': '#a41b51', '--text-muted': '#f48fb1',
      '--accent': '#f06292', '--accent-hover': '#e05286',
      '--accent-glow': 'rgba(240, 98, 146, 0.22)', '--border': '#fbcbd9',
      '--user-bubble': '#fce4ee', '--assistant-bubble': '#fffdfd',
      '--danger': '#ef4444', '--success': '#22c55e', '--warning': '#f59e0b',
      '--shadow': '0 4px 24px rgba(0, 0, 0, 0.07)',
      '--radius': '12px', '--radius-sm': '8px', '--radius-xs': '4px',
    },
  },
  {
    name: 'light-sunrise', label: '晨曦',
    vars: {
      // 会话背景下调为柔和暖米色（原 #fffbeb 太亮），各表面色调相互融合、降低刺眼感
      '--bg-primary': '#f8f1e2', '--bg-secondary': '#fcf7ec', '--bg-tertiary': '#f3e5c9',
      '--bg-surface': '#fcf7ec', '--bg-input': '#f3e5c9',
      '--text-primary': '#2d1b00', '--text-secondary': '#92400e', '--text-muted': '#bd9f63',
      '--accent': '#d97706', '--accent-hover': '#b45309',
      '--accent-glow': 'rgba(217, 119, 6, 0.18)', '--border': '#eadbc0',
      '--user-bubble': '#f3e5c9', '--assistant-bubble': '#fcf7ec',
      '--danger': '#ef4444', '--success': '#22c55e', '--warning': '#f59e0b',
      '--shadow': '0 4px 24px rgba(0, 0, 0, 0.07)',
      '--radius': '12px', '--radius-sm': '8px', '--radius-xs': '4px',
    },
  },
  {
    // 梅红：由「柔粉玫红 #da6d83」提亮为「珊瑚玫红 #e94f6d」。饱和度 60→78，观感明显更鲜亮，
    // 但明度仅 64→61，仍是中等明度实色，不产生刺眼感；对白字对比 3.23→3.62 反而更易读。
    // 色相 348° 在粉红一侧独一无二（原先的近邻「奋斗红 356°」已改为冷调铅灰），主题之间依然可区分。
    // 背景同步去掉灰调、以白为底掺入极淡玫粉，边框/气泡提纯，避免旧版偏「灰扑扑」的粉。
    name: 'light-plum', label: '梅红',
    vars: {
      '--bg-primary': '#fff5f7', '--bg-secondary': '#fffafb', '--bg-tertiary': '#fde9ee',
      '--bg-surface': '#fffafb', '--bg-input': '#fde9ee',
      '--text-primary': '#3a1d26', '--text-secondary': '#7e3f50', '--text-muted': '#c99aa6',
      '--accent': '#e94f6d', '--accent-hover': '#d63555',
      '--accent-glow': 'rgba(233, 79, 109, 0.2)', '--border': '#fadce3',
      '--user-bubble': '#fad8e0', '--assistant-bubble': '#fffafb',
      '--danger': '#ef4444', '--success': '#22c55e', '--warning': '#f59e0b',
      '--shadow': '0 4px 24px rgba(0, 0, 0, 0.07)',
      '--radius': '12px', '--radius-sm': '8px', '--radius-xs': '4px',
    },
  },
  {
    // 铅灰：中性冷调灰，原「奋斗红」（主色提取自 htlogo.jpg 的 #e60011 / #ad0002）已整体替换。
    // 主色 #5b6472 明度约 40、饱和度极低，与深色系「石板灰」(#111827 底 + 青绿强调) 刻意区分：
    // 本主题是**亮色底 + 铅灰强调**，且灰阶偏冷偏蓝；对白字对比 5.98:1，超过 WCAG AA 4.5:1，实底按钮文字清晰可读。
    // name 仍保留 'struggle-red'：它会持久化进 settings.json，改名会让老用户已选主题失配回退。
    name: 'struggle-red', label: '铅灰',
    vars: {
      '--bg-primary': '#f4f5f7', '--bg-secondary': '#fafbfc', '--bg-tertiary': '#e8eaee',
      '--bg-surface': '#fafbfc', '--bg-input': '#e8eaee',
      '--text-primary': '#1f242b', '--text-secondary': '#4a5461', '--text-muted': '#939cab',
      '--accent': '#5b6472', '--accent-hover': '#464f5c',
      '--accent-glow': 'rgba(91, 100, 114, 0.25)', '--border': '#dce0e6',
      '--user-bubble': '#e6e9ee', '--assistant-bubble': '#fafbfc',
      '--danger': '#ef4444', '--success': '#22c55e', '--warning': '#f59e0b',
      '--shadow': '0 4px 24px rgba(0, 0, 0, 0.07)',
      '--radius': '12px', '--radius-sm': '8px', '--radius-xs': '4px',
    },
  },
  // ===== 新增：深色系 =====
  {
    name: 'light', label: '明亮蓝',
    vars: {
      '--bg-primary': '#f0f4f8', '--bg-secondary': '#ffffff', '--bg-tertiary': '#e2e8f0',
      '--bg-surface': '#ffffff', '--bg-input': '#e2e8f0',
      '--text-primary': '#0f172a', '--text-secondary': '#475569', '--text-muted': '#94a3b8',
      '--accent': '#3b82f6', '--accent-hover': '#2563eb',
      '--accent-glow': 'rgba(59, 130, 246, 0.2)', '--border': '#cbd5e1',
      '--user-bubble': '#dbeafe', '--assistant-bubble': '#ffffff',
      '--danger': '#ef4444', '--success': '#22c55e', '--warning': '#f59e0b',
      '--shadow': '0 4px 24px rgba(0, 0, 0, 0.1)',
      '--radius': '12px', '--radius-sm': '8px', '--radius-xs': '4px',
    },
  },
  // ===== 新增：亮色系 =====
  {
    // 薄荷：由「灰调青 #0d9488」提纯为「清透碧 #00998c」。饱和度 84→100、去灰提纯，
    // 观感更亮更清透；明度 32→30 基本持平，对白字对比 3.54:1，实底按钮仍清晰可读。
    // 背景由原先偏绿黄的薄荷底改为冷调薄荷白，整体更清爽通透。
    name: 'light-mint', label: '薄荷',
    vars: {
      '--bg-primary': '#eefaf8', '--bg-secondary': '#f7fdfc', '--bg-tertiary': '#d8f2ee',
      '--bg-surface': '#f7fdfc', '--bg-input': '#d8f2ee',
      '--text-primary': '#04302b', '--text-secondary': '#0b6b62', '--text-muted': '#63a9a1',
      '--accent': '#00998c', '--accent-hover': '#00857a',
      '--accent-glow': 'rgba(0, 153, 140, 0.2)', '--border': '#c6ece6',
      '--user-bubble': '#d3f0eb', '--assistant-bubble': '#f7fdfc',
      '--danger': '#ef4444', '--success': '#22c55e', '--warning': '#f59e0b',
      '--shadow': '0 4px 24px rgba(0, 0, 0, 0.07)',
      '--radius': '12px', '--radius-sm': '8px', '--radius-xs': '4px',
    },
  },
  {
    name: 'light-indigo', label: '靛蓝',
    vars: {
      '--bg-primary': '#eef0fb', '--bg-secondary': '#f6f7fe', '--bg-tertiary': '#dfe3f7',
      '--bg-surface': '#f6f7fe', '--bg-input': '#dfe3f7',
      '--text-primary': '#1a1f3c', '--text-secondary': '#4338ca', '--text-muted': '#9aa2d4',
      '--accent': '#6366f1', '--accent-hover': '#4f46e5',
      '--accent-glow': 'rgba(99, 102, 241, 0.2)', '--border': '#d6dbf2',
      '--user-bubble': '#dfe3f7', '--assistant-bubble': '#f6f7fe',
      '--danger': '#ef4444', '--success': '#22c55e', '--warning': '#f59e0b',
      '--shadow': '0 4px 24px rgba(0, 0, 0, 0.07)',
      '--radius': '12px', '--radius-sm': '8px', '--radius-xs': '4px',
    },
  },
]

function applyFullTheme(vars) {
  const root = document.documentElement
  for (const [key, val] of Object.entries(vars)) {
    root.style.setProperty(key, val)
  }
  // 由强调色自动派生浅色高亮底（选中/高亮背景），保证自定义色落到这些位置
  if (vars['--accent']) {
    root.style.setProperty('--accent-soft', hexToRgba(vars['--accent'], 0.08))
  }
}

// 用户选了自定义主色 → 按规则生成整套浅色主题，立即应用并持久化
function onCustomColor(hex) {
  const vars = generateCustomTheme(hex)
  if (!vars) return
  store.setCustomTheme(hex)
  applyFullTheme(vars)
}

function setTheme(theme) {
  // 选内置主题即停用自定义主色（用户只有一套自定义）
  if (store.customTheme) store.setCustomTheme(null)
  applyFullTheme(theme.vars)
  store.setThemeName(theme.name)
  showThemePicker.value = false
}

// 字号档位：写入根容器 --font-scale 变量，仅缩放文字（与主题色独立，可并存）
const fontScales = [
  { value: 0.9, label: '小' },
  { value: 1, label: '标准' },
  { value: 1.15, label: '稍大' },
  { value: 1.3, label: '大' },
]

function setFontScale(scale) {
  store.setFontScale(scale)
}

// 开源版：企业版这里跳转到**企业内部帮助中心**（含内部界面截图与下载直链），已随 help/ 一起移除。
// 二次开发可改为打开你自己的文档站，或直接删掉这个按钮。
async function openHelp() {
  window.alert('开源版未内置在线帮助中心。请阅读仓库 README.md，或接入你自己的文档站点。')
}

// Find current theme object by name
// 兜底：保存的主题名不存在（如已被移除的主题）时，回退到默认「明亮蓝」而非深色系第一项
function getCurrentTheme() {
  return themes.find(t => t.name === store.themeName)
    || themes.find(t => t.name === 'light')
    || themes[0]
}

// Close pickers on outside click
function onClickOutside(e) {
  if (showThemePicker.value && themePickerRef.value && !themePickerRef.value.contains(e.target)) {
    showThemePicker.value = false
  }
  if (showRolePicker.value && rolePickerRef.value && !rolePickerRef.value.contains(e.target)) {
    showRolePicker.value = false
  }
}

onMounted(async () => {
  document.addEventListener('click', onClickOutside)
  // 每次启动检查登录状态与 1 天有效期，过期则需重新登录
  await store.checkLogin()
  await store.loadSettings()
  await store.loadConversations()

  // 网络健康：先取一次当前结论并订阅推送（右上角状态点用它显示绿/黄/红）
  store.refreshNetHealth().catch(() => {})

  // Apply saved theme：自定义主色优先，否则回退内置预设
  if (store.customTheme) {
    const customVars = generateCustomTheme(store.customTheme)
    if (customVars) applyFullTheme(customVars)
  } else {
    const savedTheme = getCurrentTheme()
    if (savedTheme) {
      applyFullTheme(savedTheme.vars)
    }
  }

  // 每次启动都新建会话，避免反复在同一个会话里聊很多天导致上下文爆炸；
  // 历史会话仍在侧边栏可查，按需点开即可。
  // 新建的会话是 0 消息的空「新对话」：运行期间它会一直留在侧栏（等同历史记录，
  // 切走/新建都不会被清掉，可随时点回继续输入）；但它不会落盘进历史记录——
  // 只有发出首条消息后才持久化，应用关闭/重启后 0 消息的空会话自然消失，不占历史。
  await store.newConversation()

  // 每次打开应用自动更新「试用模型」：当前用的是「免费试用」页签、或早期直接发密钥的 mimo-v2.5 时，
  // 重新匹配服务端下发的最新模型并切换过去；已无可用模型则提示联系 IT。
  // 非试用配置（用户自己的模型）一律跳过；网络异常静默，不影响已登录用户正常使用。
  try {
    await store.refreshTrialProfileOnStartup()
  } catch (e) {
    console.error('[trial] startup refresh failed:', e)
  }
})

onUnmounted(() => {
  document.removeEventListener('click', onClickOutside)
})
</script>

<style scoped>
.active-profile-name {
  display: inline-flex;
  align-items: center;
  max-width: 180px;
  margin-left: 8px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: calc(12px * var(--font-scale));
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-primary);
}

/* Header */
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
  user-select: none;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sidebar-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s;
  -webkit-app-region: no-drag;
}

.sidebar-toggle:hover {
  background: var(--bg-input);
  color: var(--text-primary);
}

.app-logo {
  color: var(--accent);
  display: flex;
  align-items: center;
  cursor: pointer;
}

.app-title {
  font-size: calc(16px * var(--font-scale));
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 0.5px;
  cursor: pointer;
}

.welcome-text {
  font-size: calc(13px * var(--font-scale));
  color: var(--text-secondary);
  margin-left: 10px;
  padding-left: 10px;
  border-left: 1px solid var(--border);
  white-space: nowrap;
  -webkit-app-region: no-drag;
}

.welcome-resource {
  color: var(--text-muted);
  font-size: calc(12px * var(--font-scale));
}

.logout-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s;
  margin-left: 2px;
  -webkit-app-region: no-drag;
}

.logout-btn:hover {
  background: var(--bg-input);
  color: var(--danger);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  -webkit-app-region: no-drag;
}

.header-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s;
}

.header-btn:hover {
  background: var(--bg-input);
  color: var(--text-primary);
}

.header-btn.active {
  background: var(--accent);
  color: white;
}

/* Role Selector（通用 / 产品 / 测试） */
.role-picker {
  position: relative;
}

.role-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  width: auto;
  padding: 0 8px;
  font-size: calc(12px * var(--font-scale));
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--bg-input);
  transition: all 0.2s;
}

.role-btn:hover {
  border-color: var(--accent);
  color: var(--text-primary);
}

.role-btn.active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.role-btn-label {
  max-width: 72px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.role-popup {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  min-width: 240px;
  box-shadow: var(--shadow);
  z-index: 100;
  animation: fadeIn 0.15s ease;
}

.role-popup-title {
  font-size: calc(12px * var(--font-scale));
  color: var(--text-muted);
  margin-bottom: 8px;
  font-weight: 500;
}

.role-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 9px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s;
  text-align: left;
  margin-bottom: 6px;
}

.role-option:last-child {
  margin-bottom: 0;
}

.role-option:hover {
  border-color: var(--accent);
}

.role-option.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* 受限角色（当前用户无权限切换）：灰显并加"暂无权限"徽标 */
.role-option.restricted {
  opacity: 0.55;
  cursor: not-allowed;
}

.role-option.restricted:hover {
  border-color: var(--border);
}

.role-option-locked {
  align-self: flex-start;
  margin-top: 1px;
  padding: 1px 6px;
  font-size: calc(10px * var(--font-scale));
  color: var(--danger);
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 999px;
  background: rgba(239, 68, 68, 0.08);
}

.role-option-name {
  font-size: calc(13px * var(--font-scale));
  font-weight: 600;
  color: var(--text-primary);
}

.role-option.active .role-option-name {
  color: var(--accent);
}

.role-option-desc {
  font-size: calc(11px * var(--font-scale));
  color: var(--text-muted);
}

/* Theme Color Picker */
.theme-picker {
  position: relative;
}

.theme-btn {
  color: var(--accent);
}

.theme-popup {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  min-width: 248px;
  box-shadow: var(--shadow);
  z-index: 100;
  animation: fadeIn 0.15s ease;
}

.theme-popup-title {
  font-size: calc(12px * var(--font-scale));
  color: var(--text-muted);
  margin-bottom: 8px;
  font-weight: 500;
}

.theme-presets {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  margin-bottom: 10px;
}

.theme-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 4px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s;
}

.theme-card:hover {
  border-color: var(--accent);
}

.theme-card.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.theme-preview {
  display: flex;
  gap: 3px;
  align-items: center;
}

.tp-bg {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.tp-bg2 {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.tp-accent {
  width: 16px;
  height: 16px;
  border-radius: 3px;
}

.theme-card-label {
  font-size: calc(11px * var(--font-scale));
  color: var(--text-secondary);
}

/* 字号档位 */
.theme-font-section {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.font-scale-options {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.font-scale-btn {
  padding: 7px 4px;
  font-size: calc(12px * var(--font-scale));
  color: var(--text-secondary);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s;
}

.font-scale-btn:hover {
  border-color: var(--accent);
  color: var(--text-primary);
}

.font-scale-btn.active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.theme-custom-section {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.theme-custom-name {
  font-size: calc(12px * var(--font-scale));
  color: var(--text-secondary);
}

.theme-custom-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: calc(12px * var(--font-scale));
  color: var(--text-secondary);
  cursor: pointer;
  padding: 6px 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: border-color 0.2s;
}

.theme-custom-label:hover {
  border-color: var(--accent);
}

.color-input-native {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  cursor: pointer;
  background: none;
}

.color-input-native::-webkit-color-swatch-wrapper {
  padding: 2px;
}

.color-input-native::-webkit-color-swatch {
  border: none;
  border-radius: 50%;
}

/* Body */
.app-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.main-area {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
