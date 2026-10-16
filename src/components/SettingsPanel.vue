<template>
  <div class="settings-panel">
    <div class="settings-content">
      <div class="settings-title-row">
        <h2 class="settings-title" @dblclick="openDevTools">设置</h2>
        <button class="settings-help" @click="openHelp">帮助</button>
      </div>
      <p class="settings-desc">配置 AI 模型和文件访问权限</p>

      <!-- API Settings -->
      <section class="settings-section">
        <h3 class="section-title">
          🔑 API 配置
        </h3>
        <div class="profile-tabs">
          <button v-for="p in profiles" :key="p.id" class="profile-tab" :class="{ active: p.id === selectedProfileId }" @click="selectProfile(p.id)">
            {{ p.name }}
          </button>
          <button class="profile-tab-add" @click="addProfile" title="新增模型页签">+</button>
        </div>
        <div class="profile-actions">
          <button v-if="selectedProfileId !== 'deepseek-default'" class="btn-secondary btn-sm btn-danger" @click="deleteProfile">删除页签</button>
          <span v-else class="field-hint">DeepSeek 基础配置不可删除</span>
        </div>
        <!-- 试用配置（点击「立即试用」自动生成）：参数只读，不可修改，只能整条删除 -->
        <div v-if="isTrial" class="trial-lock-tip">
          <span class="trial-lock-icon">🔒</span>
          <span>该配置由「立即试用」自动下发，参数不可修改。如需改用自有模型，请新建页签，或删除本页签后重新试用。</span>
        </div>
        <div class="field-group"><label class="field-label">页签名称</label><input v-model="form.name" class="field-input" :disabled="isTrial" /></div>
        <div class="field-group"><label class="field-label">API Base URL</label><input v-model="form.baseUrl" class="field-input" placeholder="https://api.deepseek.com/v1" :disabled="isTrial" /></div>
        <div class="field-group">
          <label class="field-label">API Key</label>
          <div class="key-status" v-if="selectedProfile && selectedProfile.hasApiKey">✓ 已配置，留空则保持不变</div>
          <div class="input-with-toggle"><input :type="showKey ? 'text' : 'password'" v-model="form.apiKey" class="field-input" placeholder="sk-..." :disabled="isTrial" /><button class="toggle-btn" :disabled="isTrial" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button></div>
        </div>
        <div class="field-group"><label class="field-label">模型名称</label><input v-model="form.model" class="field-input" placeholder="如 deepseek-flash / openai/gpt-5.6-luna" :disabled="isTrial" /></div>
        <div class="field-group"><label class="field-label">上下文窗口</label><div class="input-with-unit"><input v-model="contextWindowK" class="field-input field-input-with-unit" type="number" min="256" step="1" :disabled="isTrial" /><span class="field-unit">K</span></div></div>
        <div class="field-group">
          <label class="checkbox-row">
            <input type="checkbox" v-model="form.vision" @change="onVisionChange" />
            <span>该模型支持读图（多模态）</span>
          </label>
          <p class="field-hint">
            勾选后 AI 会多出一个「取网页图片」的能力：你丢一个网页地址给它，它能真的<strong>看到</strong>页面里的图片（横幅 / 图表 / 布局 / 截图类内容），而不只是读文字。纯文本模型<strong>不要勾</strong>——服务端会拒收图片，那一轮会直接报错。
          </p>
        </div>
        <div class="field-group"><button class="btn-test" :disabled="testing || trialLoading || isTrial || (!form.apiKey && !selectedProfile?.hasApiKey)" @click="testConnection">{{ isTrial ? '试用配置不可修改' : testing ? '测试中...' : '测试连接并保存' }}</button><div v-if="testResult" class="test-result" :class="testResult.success ? 'success' : 'error'"><span>{{ testResult.message }}</span></div></div>
      </section>

      <!-- System Configuration -->
      <section class="settings-section">
        <h3 class="section-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          系统配置
        </h3>

        <div class="field-group">
          <label class="field-label">Node.js 版本</label>
          <div class="version-row">
            <span class="version-badge node">{{ sysInfo.nodeVersion || '检测中...' }}</span>
            <button
              class="btn-secondary btn-sm"
              :disabled="dlState.node.active"
              @click="startDownload('node')"
            >
              <span v-if="dlState.node.active" class="download-progress">
                <span class="dl-spinner" />
                {{ dlState.node.progress }}%
              </span>
              <span v-else>打开 Node.js 下载页</span>
            </button>
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">Python 版本</label>
          <div class="version-row">
            <span class="version-badge python">{{ sysInfo.pythonVersion || '检测中...' }}</span>
            <button
              class="btn-secondary btn-sm"
              :disabled="dlState.python.active"
              @click="startDownload('python')"
            >
              <span v-if="dlState.python.active" class="download-progress">
                <span class="dl-spinner" />
                {{ dlState.python.progress }}%
              </span>
              <span v-else>打开 Python 下载页</span>
            </button>
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">Git 版本</label>
          <div class="version-row">
            <span class="version-badge git">{{ sysInfo.gitVersion || '未安装/检测中...' }}</span>
            <button
              class="btn-secondary btn-sm"
              :disabled="dlState.git.active"
              @click="startDownload('git')"
            >
              <span v-if="dlState.git.active" class="download-progress">
                <span class="dl-spinner" />
                {{ dlState.git.progress }}%
              </span>
              <span v-else>打开 Git 下载页</span>
            </button>
          </div>
        </div>

        <div v-if="dlMessage.text" class="dl-status" :class="dlMessage.type">
          {{ dlMessage.text }}
        </div>
      </section>

      <!-- File Access Settings -->
      <section class="settings-section">
        <h3 class="section-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
          文件访问权限
        </h3>

        <div class="field-group">
          <label class="field-label">已授权目录</label>
          <div class="dir-list">
            <div v-for="(dir, idx) in form.allowedDirs" :key="idx" class="dir-item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              </svg>
              <span class="dir-path">{{ dir }}</span>
              <button class="dir-remove" @click="removeDir(idx)">✕</button>
            </div>
            <div v-if="form.allowedDirs.length === 0" class="dir-empty">
              暂无授权目录，请添加工作目录
            </div>
          </div>
          <button class="btn-secondary" @click="addDirectory">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            添加目录
          </button>
        </div>
      </section>

      <!-- Skills & Memory Settings -->
      <section class="settings-section">
        <h3 class="section-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          Skill & Memory 存储
        </h3>

        <div class="field-group">
          <label class="field-label">Skills 目录</label>
          <div class="path-display">{{ form.skillsDir || '未设置' }}</div>
        </div>

        <div class="field-group">
          <label class="field-label">Memory 目录</label>
          <div class="path-display">{{ form.memoryDir || '未设置' }}</div>
        </div>
      </section>

      <!-- Excel 环境（skills/xlsx 依赖） -->
      <section class="settings-section">
        <h3 class="section-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="9" y1="21" x2="9" y2="9" />
          </svg>
          Excel 环境
        </h3>
        <div class="field-group">
          <label class="field-label">依赖状态（AI 处理 Excel 所需）</label>
          <div class="excel-env-grid">
            <span v-if="excelChecking" class="version-badge">检测中...</span>
            <template v-else>
              <span class="version-badge" :class="excelEnv.openpyxl ? 'ok' : 'miss'">openpyxl {{ excelEnv.openpyxl ? '✓' : '✗' }}</span>
              <span class="version-badge" :class="excelEnv.pandas ? 'ok' : 'miss'">pandas {{ excelEnv.pandas ? '✓' : '✗' }}</span>
              <span class="version-badge" :class="excelEnv.markitdown ? 'ok' : 'miss'">markitdown {{ excelEnv.markitdown ? '✓' : '✗' }}</span>
              <span class="version-badge" :class="excelEnv.pycel ? 'ok' : 'miss'">pycel {{ excelEnv.pycel ? '✓' : '✗' }}</span>
            </template>
          </div>
          <div class="version-row" style="margin-top: 10px">
            <button
              class="btn-secondary btn-sm"
              :disabled="dlState.xlsx.active || excelChecking"
              @click="startDownload('xlsx')"
            >
              <span v-if="dlState.xlsx.active" class="download-progress">
                <span class="dl-spinner" />
                {{ dlState.xlsx.progress }}%
              </span>
              <span v-else-if="excelChecking">检测中...</span>
              <span v-else>{{ excelEnvComplete ? '重新补全 Excel 环境' : '补全 Excel 环境' }}</span>
            </button>
          </div>
          <div class="erpk-hint">openpyxl/pandas 通常随 Python 预装；markitdown 用于快速预览表格；pycel 是 recalc.py 公式重算的主引擎（纯 Python）。缺失 pycel 会令带公式的 Excel 无法计算。</div>
        </div>
        <div v-if="dlMessage.text && dlMessage.type" class="dl-status" :class="dlMessage.type">
          {{ dlMessage.text }}
        </div>
      </section>

      <!-- LibreOffice（可选，Word/PPT 转 PDF 需要） -->
      <section class="settings-section">
        <h3 class="section-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="9" y1="21" x2="9" y2="9" />
          </svg>
          LibreOffice（可选）
        </h3>
        <div class="field-group">
          <label class="field-label">Word/PPT 转 PDF 所需，非必须</label>
          <div class="version-row">
            <span v-if="libreOfficeChecking" class="version-badge">检测中...</span>
            <span v-else class="version-badge" :class="libreOfficeInstalled ? 'ok' : 'miss'">LibreOffice {{ libreOfficeInstalled ? '✓ 已安装' : '✗ 未安装' }}</span>
            <button
              class="btn-secondary btn-sm"
              :disabled="dlState.libreOffice.active || libreOfficeChecking"
              @click="startDownload('libreOffice')"
            >
              <span v-if="dlState.libreOffice.active" class="download-progress">
                <span class="dl-spinner" />
                {{ dlState.libreOffice.progress }}%
              </span>
              <span v-else-if="libreOfficeChecking">检测中...</span>
              <span v-else>{{ libreOfficeInstalled ? '重新安装 LibreOffice' : '安装 LibreOffice' }}</span>
            </button>
          </div>
          <div class="erpk-hint">LibreOffice 为可选增强，仅 Word/PPT 转 PDF 需要。安装后不会抢占 Office 文件默认打开程序。体积较大（约 300MB），安装需耐心等待。</div>
        </div>
      </section>

      <!-- 应用更新（增量/全量可视化） -->
      <section class="settings-section">
        <h3 class="section-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
          </svg>
          应用更新
        </h3>
        <div class="field-group">
          <label class="field-label">当前版本</label>
          <div class="version-row">
            <span class="version-badge app">{{ appVersion || '检测中...' }}</span>
            <button class="btn-secondary btn-sm" :disabled="updateState.checking || updateState.downloading" @click="checkAppUpdate">
              <span v-if="updateState.checking" class="download-progress"><span class="dl-spinner" />检查中...</span>
              <span v-else>检查更新</span>
            </button>
          </div>
        </div>

        <!-- 状态行：发现新版本 / 已是最新 / 错误 -->
        <div v-if="updateState.status === 'available'" class="update-banner">
          发现新版本 <b>v{{ updateState.version }}</b>
          <span v-if="updateState.fullSize" class="update-sub">（整包 {{ formatBytes(updateState.fullSize) }}）</span>
        </div>
        <div v-else-if="updateState.status === 'not-available'" class="update-banner ok">
          已是最新版本
          <span v-if="updateState.errorMsg" class="update-sub">{{ updateState.errorMsg }}</span>
        </div>
        <div v-else-if="updateState.status === 'error'" class="update-banner err">{{ updateState.errorMsg }}</div>

        <!-- 下载中：进度条 + 实际下载量 / 整包大小 + 增量/全量徽标 -->
        <div v-if="updateState.downloading" class="field-group update-progress-block">
          <div class="update-progress-head">
            <span>正在下载 v{{ updateState.version }}</span>
            <span class="update-badge" :class="updateState.isIncremental ? 'incr' : 'full'">
              {{ updateState.isIncremental ? `增量更新 · 仅传输 ${Math.round(updateState.downloadRatio * 100)}%` : '全量更新' }}
            </span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: updateState.percent + '%', background: updateState.isIncremental ? '#1aad19' : '#1677ff' }"></div>
          </div>
          <div class="update-progress-foot">
            <span>已下载 {{ formatBytes(updateState.transferred) }} / 整包 {{ formatBytes(updateState.fullSize) }}</span>
            <span v-if="updateState.bytesPerSecond">{{ formatBytes(updateState.bytesPerSecond) }}/s</span>
          </div>
        </div>

        <!-- 下载完成 -->
        <div v-if="updateState.status === 'downloaded'" class="update-banner ok">
          新版本 v{{ updateState.version }} 已下载完成，重启应用即可安装
        </div>
      </section>

      <!-- Actions -->
      <div class="settings-actions">
        <button class="btn-primary" @click="saveSettings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
          保存设置
        </button>
        <button class="btn-secondary" @click="store.showSettings = false">
          返回聊天
        </button>
      </div>
    </div>

    <!-- 保存成功悬浮提示（固定顶部居中，不随滚动隐藏） -->
    <transition name="toast">
      <div v-if="saved" class="save-toast">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        保存成功
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { useAppStore } from '@/stores/app'

const store = useAppStore()
const showKey = ref(false)

// 开源版：企业版这里跳转到**企业内部帮助中心**（含内部界面截图与下载直链），已随 help/ 一起移除。
// 二次开发可改为打开你自己的文档站，或直接删掉这个按钮。
async function openHelp() {
  window.alert('开源版未内置在线帮助中心。请阅读仓库 README.md，或接入你自己的文档站点。')
}

// 打开 DevTools（双击"设置"标题触发）
async function openDevTools() {
  try {
    await window.electronAPI.openDevTools()
  } catch (e) {
    console.error('Failed to open DevTools:', e)
  }
}
const saved = ref(false)
const testing = ref(false)
const testResult = ref(null)
const profiles = computed(() => store.settings.modelProfiles || [])
const selectedProfileId = ref('deepseek-default')
let profileSelectionInitialized = false
const selectedProfile = computed(() => profiles.value.find((p) => p.id === selectedProfileId.value) || profiles.value[0])
// 开源版没有「立即试用」服务，页签不存在只读态（保留该计算属性，模板里仍在引用）
const isTrial = computed(() => false)

function loadProfileDraft() {
  const p = selectedProfile.value
  if (!p) return
  form.name = p.name || '模型'
  form.baseUrl = p.baseUrl || 'https://api.deepseek.com/v1'
  form.model = p.model || 'deepseek-flash'
  form.vision = p.vision === true
  form.apiKey = ''
  contextWindowK.value = Math.round((p.contextWindow || 1024 * 1024) / 1024)
}

async function selectProfile(id) {
  await saveProfile()
  selectedProfileId.value = id
  loadProfileDraft()
}

async function saveProfile() {
  if (!selectedProfile.value) return
  // 试用配置只读：切换页签 / 保存设置时的自动回写直接跳过，避免无意义的失败请求
  if (selectedProfile.value.trial === true) return
  await window.electronAPI.updateModelProfile(selectedProfile.value.id, {
    name: form.name, apiKey: form.apiKey, baseUrl: form.baseUrl, model: form.model, contextWindow: resolveContextWindow(), vision: form.vision,
  })
  await store.loadSettings()
  form.apiKey = ''
}

// 「支持读图」勾选即存（不必点"测试连接并保存"）——它只是个能力声明，不需要验证连通性。
// ⚠️ 只提交 vision 一个字段：saveProfile 会把表单里所有字段一起写盘，
// 用户在别的输入框里还没保存的半截内容会被顺带写进去（切页签时也走 saveProfile，所以那边无所谓）。
// 主进程对"只带 vision 的请求"有专门分支，试用配置（页签整体只读）也允许改这一个字段。
async function onVisionChange() {
  const p = selectedProfile.value
  if (!p) return
  const next = form.vision
  const res = await window.electronAPI.updateModelProfile(p.id, { vision: next })
  if (res && res.success === false) {
    form.vision = p.vision === true   // 回滚勾选，别让界面显示成功
    testResult.value = { success: false, message: res.error || '保存失败' }
    return
  }
  testResult.value = { success: true, message: next ? '已开启读图能力（下一轮对话生效）' : '已关闭读图能力' }
  await store.loadSettings()
}

async function addProfile() {
  const p = await window.electronAPI.createModelProfile('新模型')
  if (p && p.id) { await store.loadSettings(); selectedProfileId.value = p.id; loadProfileDraft() }
}

async function deleteProfile() {
  const name = selectedProfile.value?.name || '模型'
  // 试用配置不可改，只能删：提示里说明可重新试用，避免用户以为删了就没了
  const tip = selectedProfile.value?.trial === true
    ? `确定删除“${name}”配置吗？删除后可重新点击「立即试用」获取。`
    : `确定删除“${name}”配置吗？`
  const ok = await window.electronAPI.showConfirmDialog(tip)
  if (!ok) return
  const res = await window.electronAPI.deleteModelProfile(selectedProfileId.value)
  if (res?.success) { await store.loadSettings(); selectedProfileId.value = 'deepseek-default'; loadProfileDraft() }
  else testResult.value = { success: false, message: res?.error || '删除失败' }
}

async function activateProfile() {
  await saveProfile()
  const res = await window.electronAPI.setActiveModelProfile(selectedProfileId.value)
  if (res?.success) await store.loadSettings()
}


// System info
const sysInfo = ref({ nodeVersion: '', pythonVersion: '', gitVersion: '' })
const excelEnv = ref({ python: false, openpyxl: false, pandas: false, markitdown: false, pycel: false })
const libreOfficeInstalled = ref(false)
// 探测进行中标记：getSystemInfo 是 IPC 往返 + 实际进程探测，期间徽标应显示「检测中」并禁用补全按钮，
// 避免用户看到四个 ✗ 就误点「重新补全 Excel 环境」
const sysLoading = ref(true)
const excelEnvComplete = computed(() =>
  excelEnv.value.openpyxl && excelEnv.value.pandas && excelEnv.value.markitdown && excelEnv.value.pycel
)
// 探测中：徽标统一显示「检测中」，不展示 ✓/✗，也不允许点击补全
const excelChecking = computed(() => sysLoading.value)
const libreOfficeChecking = computed(() => sysLoading.value)
const dlState = reactive({
  node: { active: false, progress: 0 },
  python: { active: false, progress: 0 },
  git: { active: false, progress: 0 },
  xlsx: { active: false, progress: 0 },
  libreOffice: { active: false, progress: 0 },
})
const dlMessage = ref({ text: '', type: '' })
let dlCleanup = null

async function loadSystemInfo() {
  sysLoading.value = true
  try {
    const info = await window.electronAPI.getSystemInfo()
    sysInfo.value = info
    if (info.excelEnv) {
      // 后端 excelEnv 仍含 soffice（system:getInfo 统一探测），前端拆分为两个独立状态
      const { soffice, ...pyEnv } = info.excelEnv
      excelEnv.value = pyEnv
      libreOfficeInstalled.value = !!soffice
    }
  } catch (e) {
    console.error('Failed to get system info:', e)
  } finally {
    sysLoading.value = false
  }
}

async function startDownload(type) {
  const state = dlState[type]
  state.active = true
  state.progress = 0
  dlMessage.value = { text: `正在准备下载...`, type: '' }

  dlCleanup = window.electronAPI.onDownloadProgress((data) => {
    if (data.type === type) {
      state.progress = data.percent || 0
      if (data.message) {
        dlMessage.value = { text: data.message, type: data.type === 'xlsx' ? (data.env && Object.values(data.env).every(Boolean) ? 'success' : 'error') : data.type === 'libreoffice' ? (data.env && data.env.soffice ? 'success' : 'error') : '' }
      }
      // xlsx 安装器在 100% 时回传 Python 包探测结果，刷新 Excel 徽标（不含 soffice，两栏独立）
      if (data.env && data.type === 'xlsx') excelEnv.value = data.env
      // LibreOffice 安装器回传 soffice 状态，独立刷新 LibreOffice 徽标
      if (data.env && data.type === 'libreoffice') libreOfficeInstalled.value = !!data.env.soffice
    }
  })

  try {
    if (type === 'node' || type === 'git' || type === 'python') {
      // 开源版：主进程只负责打开官方下载页，不做内置下载/静默安装
      if (type === 'node') await window.electronAPI.downloadNode()
      else if (type === 'git') await window.electronAPI.downloadGit()
      else await window.electronAPI.downloadPython()
      dlMessage.value = { text: '已打开官方下载页，请手动下载安装后重启应用生效。', type: '' }
      return
    } else if (type === 'xlsx') {
      await window.electronAPI.downloadXlsxEnv()
      // 真实结果（成功/部分缺失）由 handler 通过 downloadProgress 推送，不在此覆盖
      return
    } else if (type === 'libreOffice') {
      await window.electronAPI.downloadLibreOffice()
      // 真实结果由 handler 通过 downloadProgress 推送，不在此覆盖
      return
    } else {
      await window.electronAPI.downloadPython()
    }
    const label = type === 'node' ? 'Node.js' : type === 'git' ? 'Git' : type === 'xlsx' ? 'Excel 环境' : type === 'libreOffice' ? 'LibreOffice' : 'Python'
    dlMessage.value = { text: `${type === 'xlsx' ? 'Excel 环境补全完成！' : type === 'libreOffice' ? 'LibreOffice 安装完成！' : `${label} 安装完成！`}`, type: 'success' }
    await loadSystemInfo()
  } catch (e) {
    dlMessage.value = { text: `下载失败: ${e.message}`, type: 'error' }
    console.error(`Failed to download ${type}:`, e)
  } finally {
    state.active = false
    if (dlCleanup) { dlCleanup(); dlCleanup = null }
  }
}

// ===== 应用自更新（增量 / 全量可视化）=====
const appVersion = ref('')
const updateState = reactive({
  checking: false,
  downloading: false,
  status: '',            // '' | 'available' | 'not-available' | 'downloaded' | 'error'
  version: '',
  fullSize: 0,
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  isIncremental: false,
  downloadRatio: 0,
  errorMsg: '',
})
let updateCleanup = []
// 检查更新兜底定时器：若 12 秒内没有任何状态事件回来（事件丢失/网络挂死），
// 主动复位，避免 UI 永久停在「检查中...」
let updateGuardTimer = null
function clearUpdateGuard() {
  if (updateGuardTimer) {
    clearTimeout(updateGuardTimer)
    updateGuardTimer = null
  }
}

// 字节 → 人类可读（与 main.js 同口径）
function formatBytes(n) {
  if (!n || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

async function loadAppVersion() {
  try {
    appVersion.value = await window.electronAPI.getAppVersion()
  } catch (e) {
    appVersion.value = ''
  }
}

async function checkAppUpdate() {
  updateState.checking = true
  updateState.status = ''
  updateState.errorMsg = ''
  clearUpdateGuard()
  // 兜底：12 秒内若无任何状态事件回到前端，强制复位
  updateGuardTimer = setTimeout(() => {
    if (updateState.checking) {
      updateState.checking = false
      updateState.status = 'error'
      updateState.errorMsg = '检查更新超时，请稍后重试或检查网络连接。'
    }
    updateGuardTimer = null
  }, 12000)
  try {
    const res = await window.electronAPI.checkForUpdates()
    // 主进程直接返回结论（dev / 检查失败）：据此复位，不再等事件
    if (res && res.ok === false) {
      updateState.checking = false
      clearUpdateGuard()
      if (res.reason === 'dev') {
        // dev 模式：不需要红色报错，用「已是最新」样式的提示即可
        updateState.status = 'not-available'
        updateState.errorMsg = '开发模式不检查更新，请打包后再试。'
      } else {
        updateState.status = 'error'
        updateState.errorMsg = '检查更新失败：' + res.reason
      }
    }
  } catch (e) {
    updateState.checking = false
    updateState.status = 'error'
    updateState.errorMsg = '检查更新失败：' + (e.message || e)
    clearUpdateGuard()
  }
}

function bindUpdateListeners() {
  updateCleanup.push(
    window.electronAPI.onUpdateChecking(() => { updateState.checking = true }),
    window.electronAPI.onUpdateAvailable((d) => {
      updateState.checking = false
      clearUpdateGuard()
      updateState.status = 'available'
      updateState.version = (d && d.version) || ''
      updateState.fullSize = (d && d.fullSize) || 0
      updateState.downloading = false
      updateState.percent = 0
    }),
    window.electronAPI.onUpdateNotAvailable(() => {
      updateState.checking = false
      clearUpdateGuard()
      updateState.status = 'not-available'
      updateState.downloading = false
    }),
    window.electronAPI.onUpdateProgress((d) => {
      updateState.checking = false
      clearUpdateGuard()
      updateState.downloading = true
      updateState.percent = (d && d.percent) || 0
      updateState.transferred = (d && d.transferred) || 0
      updateState.total = (d && d.total) || 0
      updateState.fullSize = (d && d.fullSize) || 0
      updateState.bytesPerSecond = (d && d.bytesPerSecond) || 0
      updateState.isIncremental = !!(d && d.isIncremental)
      updateState.downloadRatio = (d && d.downloadRatio) || 0
    }),
    window.electronAPI.onUpdateDownloaded((d) => {
      updateState.downloading = false
      clearUpdateGuard()
      updateState.status = 'downloaded'
      updateState.version = (d && d.version) || updateState.version
    }),
    window.electronAPI.onUpdateError((d) => {
      updateState.checking = false
      clearUpdateGuard()
      updateState.downloading = false
      updateState.status = 'error'
      updateState.errorMsg = (d && d.message) || '更新出错'
    }),
  )
}

function cleanupUpdateListeners() {
  updateCleanup.forEach((fn) => fn && fn())
  updateCleanup = []
}

onMounted(() => {
  loadSystemInfo()
  loadAppVersion()
  bindUpdateListeners()
})

onUnmounted(() => {
  cleanupUpdateListeners()
})

const form = reactive({
  apiKey: '',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
  // 该模型是否支持读图（多模态）。勾了才会给 AI 下发「取网页图片」的工具，
  // 见 electron/chat.js 的 visionCapable 闸门与 settings.js 的 visionSection。
  vision: false,
  skillsDir: '',
  memoryDir: '',
  allowedDirs: [],
})

const MIN_CONTEXT_WINDOW_K = 256  // 上下文窗口最小允许值（256K），防误填
// 上下文窗口录入值（单位 K，如 1024 = 1M）；保存时换算成 tokens 传给主进程
const contextWindowK = ref(1024)

// 把 K 单位输入换算成 tokens：>= 256K 才保存，否则返回 undefined（保持原配置，避免误填被写入）
function resolveContextWindow() {
  const k = Number(contextWindowK.value)
  return k && k >= MIN_CONTEXT_WINDOW_K ? Math.round(k * 1024) : undefined
}

// 任务提醒系统通知（屏幕右下角横幅）已改为**恒定开启**（2026-10-08）：配置页撤下开关，
// 主进程 settings.js 的 notifyOnTaskEnd 强制 true，本组件不再维护该响应式状态。

// Sync form with store (skip apiKey — it's always '' from main, user must re-enter)
  watch(
  () => store.settings,
  (s) => {
    form.skillsDir = s.skillsDir || ''
    form.memoryDir = s.memoryDir || ''
    form.allowedDirs = s.allowedDirs ? [...s.allowedDirs] : []
    if (!profileSelectionInitialized) {
      selectedProfileId.value = s.activeProfileId || 'deepseek-default'
      profileSelectionInitialized = true
    }
    loadProfileDraft()
  },
  { immediate: true, deep: true }
)

async function addDirectory() {
  try {
    const result = await window.electronAPI.selectDirectory()
    if (!result.canceled && result.path) {
      if (!form.allowedDirs.includes(result.path)) {
        form.allowedDirs.push(result.path)
      }
    }
  } catch (e) {
    console.error('Failed to select directory:', e)
  }
}

function removeDir(idx) {
  form.allowedDirs.splice(idx, 1)
}

async function saveSettings() {
  // 快照授权目录 —— saveProfile() 内部会触发 loadSettings()，watcher 会用磁盘旧值覆盖 form.allowedDirs
  const dirsToSave = [...form.allowedDirs]
  await saveProfile()
  await store.saveSettings({ allowedDirs: dirsToSave })
  saved.value = true
  await store.loadSettings()
  setTimeout(() => { saved.value = false }, 2000)
}

async function handleTrial() {
  window.alert('开源版未内置「立即试用」服务：请在「API 配置」里填写你自己的 OpenAI 兼容 Base URL / API Key / 模型名。')
}

async function testConnection() {
  testing.value = true
  testResult.value = null
  try {
    const result = await window.electronAPI.testModelProfile(selectedProfileId.value, { apiKey: form.apiKey, baseUrl: form.baseUrl, model: form.model })
    if (result.success) {
      await saveProfile()
      const activeResult = await window.electronAPI.setActiveModelProfile(selectedProfileId.value)
      if (!activeResult?.success) throw new Error(activeResult?.error || '激活模型失败')
      await store.loadSettings()
      testResult.value = { success: true, message: `✅ 连接成功！模型: ${result.model}（配置已保存并设为当前模型）` }
    } else {
      testResult.value = { success: false, message: `❌ ${result.error}` }
    }
  } catch (e) {
    testResult.value = { success: false, message: `❌ ${e.message}` }
  } finally {
    testing.value = false
  }
}
</script>

<style scoped>
.profile-tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 6px;
  overflow-x: auto;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.profile-tab,
.profile-tab-add {
  flex: 0 0 auto;
  min-height: 34px;
  padding: 7px 14px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: calc(13px * var(--font-scale));
  cursor: pointer;
  transition: all .2s ease;
}

.profile-tab:hover,
.profile-tab-add:hover {
  color: var(--text-primary);
  border-color: var(--accent);
  background: var(--bg-hover, var(--bg-input));
}

.profile-tab.active {
  color: #fff;
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: 0 2px 8px rgba(0, 0, 0, .12);
}

.profile-tab-add {
  width: 36px;
  padding: 0;
  color: var(--accent);
  font-size: calc(21px * var(--font-scale));
  font-weight: 600;
  line-height: 1;
}

.profile-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 32px;
  margin-bottom: 14px;
}

/* 试用配置只读提示条 */
.trial-lock-tip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--success, #10b981);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: calc(12px * var(--font-scale));
  line-height: 1.6;
}

.trial-lock-icon {
  flex: 0 0 auto;
  line-height: 1.4;
}

.settings-panel {
  height: 100%;
  width: 100%;
  flex: 1;
  overflow-y: auto;
  display: flex;
  justify-content: center;
}

.settings-content {
  width: 100%;
  max-width: 800px;
  padding: 32px 40px 48px;
  animation: slideUp 0.3s ease;
}

.settings-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.settings-title {
  font-size: calc(22px * var(--font-scale));
  font-weight: 700;
  margin-bottom: 4px;
}

.settings-help {
  background: none;
  border: none;
  padding: 2px 8px;
  font-size: calc(12px * var(--font-scale));
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-xs);
  transition: color 0.2s, background 0.2s;
}

.settings-help:hover {
  color: var(--accent);
  background: var(--bg-input);
}

.settings-desc {
  color: var(--text-secondary);
  font-size: calc(13px * var(--font-scale));
  margin-bottom: 28px;
}

.settings-section {
  margin-bottom: 28px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(15px * var(--font-scale));
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.field-group {
  margin-bottom: 16px;
}

.field-label {
  display: block;
  font-size: calc(13px * var(--font-scale));
  color: var(--text-secondary);
  margin-bottom: 6px;
  font-weight: 500;
}

.key-status {
  font-size: calc(12px * var(--font-scale));
  color: var(--success);
  margin-bottom: 6px;
}

.field-hint {
  font-size: calc(12px * var(--font-scale));
  color: var(--text-muted);
  margin-top: 6px;
}

/* 单复选框行（任务通知开关）：与 field-label 同字号，整行可点 */
.checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: calc(13px * var(--font-scale));
  cursor: pointer;
  transition: border-color .2s ease, color .2s ease;
}

.checkbox-row:hover {
  border-color: var(--accent);
  color: var(--text-primary);
}

.checkbox-row input[type='checkbox'] {
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}

.field-input {
  width: 100%;
  padding: 10px 14px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: calc(14px * var(--font-scale));
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  outline: none;
  transition: border-color 0.2s;
}

.field-input:focus {
  border-color: var(--accent);
}

.field-select {
  font-family: inherit;
  cursor: pointer;
}

/* 只读态（试用配置）：视觉上明确区分，避免用户以为还能编辑 */
.field-input:disabled {
  opacity: 0.65;
  cursor: not-allowed;
  color: var(--text-muted);
}

.toggle-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.input-with-toggle {
  display: flex;
  align-items: center;
  gap: 0;
}

.input-with-toggle .field-input {
  flex: 1 1 auto;
  min-width: 0;
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  border-right: none;
}

.toggle-btn {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  padding: 10px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-left: none;
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: var(--text-secondary);
  cursor: pointer;
  transition: color 0.2s;
}

.toggle-btn:hover {
  color: var(--text-primary);
}

/* Input with unit suffix（如上下文窗口的 K） */
.input-with-unit {
  display: flex;
  align-items: center;
}

.input-with-unit .field-input-with-unit {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  border-right: none;
}

.field-unit {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-left: none;
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: var(--text-muted);
  font-size: calc(13px * var(--font-scale));
}

/* Dir list */
.dir-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}

.dir-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: calc(13px * var(--font-scale));
  color: var(--text-secondary);
}

.dir-path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dir-remove {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: calc(12px * var(--font-scale));
  padding: 2px 4px;
  border-radius: 4px;
}

.dir-remove:hover {
  color: var(--danger);
  background: rgba(239, 68, 68, 0.1);
}

.dir-empty {
  padding: 12px;
  color: var(--text-muted);
  font-size: calc(13px * var(--font-scale));
  text-align: center;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
}

.path-display {
  padding: 10px 14px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: calc(13px * var(--font-scale));
  font-family: 'SF Mono', 'Fira Code', monospace;
}

/* Buttons */
.btn-primary, .btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 20px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: calc(14px * var(--font-scale));
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary {
  background: var(--accent);
  color: white;
}

.btn-primary:hover {
  background: var(--accent-hover);
}

.btn-secondary {
  background: var(--bg-input);
  color: var(--text-primary);
  border: 1px solid var(--border);
}

.btn-secondary:hover {
  background: var(--bg-surface);
}

.btn-danger {
  border-color: var(--danger);
  color: var(--danger);
  background: transparent;
}

.btn-danger:hover {
  background: var(--danger);
  color: #fff;
}

/* Test connection button */
.btn-test {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: 1px solid var(--accent);
  background: transparent;
  color: var(--accent);
  border-radius: var(--radius-sm);
  font-size: calc(13px * var(--font-scale));
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-test:hover:not(:disabled) {
  background: var(--accent-soft);
}

.btn-test:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Trial button */
.btn-trial {
  margin-left: 12px;
  padding: 4px 14px;
  border: 1px solid var(--success, #10b981);
  background: var(--success, #10b981);
  color: #fff;
  border-radius: var(--radius-sm);
  font-size: calc(12px * var(--font-scale));
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  vertical-align: middle;
  line-height: 1.4;
}

.btn-trial:hover:not(:disabled) {
  background: #059669;
  border-color: #059669;
}

.btn-trial:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.test-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--accent);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.test-result {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  margin-top: 8px;
  border-radius: var(--radius-sm);
  font-size: calc(13px * var(--font-scale));
  animation: fadeIn 0.3s ease;
}

.test-result.success {
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.3);
  color: var(--success);
}

.test-result.error {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: var(--danger);
  word-break: break-all;
}

.settings-actions {
  display: flex;
  gap: 8px;
  margin-top: 24px;
}

/* Save toast —— 固定顶部居中悬浮，避免被滚动容器裁掉 */
.save-toast {
  position: fixed;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2000;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  background: var(--bg-surface);
  border: 1px solid rgba(34, 197, 94, 0.35);
  border-radius: 999px;
  color: var(--success);
  font-size: calc(13px * var(--font-scale));
  font-weight: 500;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  pointer-events: none;
  white-space: nowrap;
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, -10px);
}

.toast-enter-to {
  opacity: 1;
  transform: translateX(-50%);
}

/* Version badges & download */
.version-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.version-badge {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: calc(13px * var(--font-scale));
  font-weight: 500;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  color: var(--text-primary);
}

.version-badge.node {
  border-color: #339933;
  color: #339933;
}

.version-badge.python {
  border-color: #3776AB;
  color: #3776AB;
}

.version-badge.git {
  border-color: #F05032;
  color: #F05032;
}

.version-badge.erpk {
  border-color: var(--accent);
  color: var(--accent);
}

.version-badge.ok {
  border-color: #339933;
  color: #339933;
}

.version-badge.miss {
  border-color: #cc3333;
  color: #cc3333;
}

.excel-env-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.erpk-hint {
  font-size: calc(12px * var(--font-scale));
  color: var(--text-muted);
  margin-top: 6px;
  line-height: 1.5;
}

.btn-sm {
  padding: 6px 14px !important;
  font-size: calc(13px * var(--font-scale)) !important;
}

.download-progress {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dl-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.dl-status {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: calc(13px * var(--font-scale));
  margin-top: 8px;
  animation: fadeIn 0.3s ease;
}

.dl-status.success {
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.3);
  color: var(--success);
}

.dl-status.error {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: var(--danger);
}

/* ===== 应用更新（增量/全量可视化）===== */
.version-badge.app {
  border-color: var(--accent);
  color: var(--accent);
}

.update-banner {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: calc(13px * var(--font-scale));
  margin-top: 10px;
  background: rgba(22, 119, 255, 0.08);
  border: 1px solid rgba(22, 119, 255, 0.25);
  color: var(--text-primary);
  animation: fadeIn 0.3s ease;
}
.update-banner.ok {
  background: rgba(34, 197, 94, 0.1);
  border-color: rgba(34, 197, 94, 0.3);
  color: var(--success);
}
.update-banner.err {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
  color: var(--danger);
}
.update-sub {
  color: var(--text-muted);
  margin-left: 4px;
}

.update-progress-block {
  margin-top: 10px;
}
.update-progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: calc(13px * var(--font-scale));
  margin-bottom: 8px;
}
.update-badge {
  padding: 2px 10px;
  border-radius: 10px;
  font-size: calc(12px * var(--font-scale));
  font-weight: 600;
}
.update-badge.incr {
  background: rgba(26, 173, 25, 0.12);
  border: 1px solid rgba(26, 173, 25, 0.35);
  color: #1aad19;
}
.update-badge.full {
  background: rgba(22, 119, 255, 0.1);
  border: 1px solid rgba(22, 119, 255, 0.3);
  color: #1677ff;
}
.progress-bar {
  width: 100%;
  height: 8px;
  border-radius: 4px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s ease;
}
.update-progress-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: calc(12px * var(--font-scale));
  color: var(--text-muted);
  margin-top: 6px;
}
</style>
