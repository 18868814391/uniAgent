// ============================================================
//  Settings —— 配置 / 环境 / 目录解析 / 模型 profile / 系统提示词
//  拥有:应用常量、ERP 环境配置、目录解析、settings 持久化、
//  model profile 归一化、系统提示词构建、以及 settings/profiles/
//  system 域的 IPC 注册。共享可变状态一律走 state。
// ============================================================
const { app, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const state = require('./state')
const { execFilePromise, runElevated, downloadAndInstall, resolvePython } = require('./helpers')

// ============================================================
//  Constants
// ============================================================
const APP_NAME = 'Local AI'
const SETTINGS_FILE = 'settings.json'
const DEFAULT_SKILLS_DIR = path.join(os.homedir(), '.local-ai', 'skills')
const DEFAULT_MEMORY_DIR = path.join(os.homedir(), '.local-ai', 'memory')
const BUILTIN_SKILLS_DIR = path.join(__dirname, '..', 'skills')
// OpenAI 兼容默认网关（DeepSeek）。用户可在设置中改 baseUrl 连接任意 OpenAI 兼容服务
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
const DEEPSEEK_PROFILE_ID = 'deepseek-default'
// 默认模型 id：官方现行名称是 `deepseek-flash`（旧版写的 `deepseek-v4-flash` 已不是最新默认值）。
// 改动默认值时必须同步两处：本常量 + LEGACY_DEFAULT_MODELS 迁移表，否则存量 settings.json 会继续用旧 id。
const DEFAULT_MODEL_ID = 'deepseek-flash'
// 曾经的默认模型 id → 现用 id。仅用于把「存量设置里仍是旧默认值」的配置迁移到新 id，
// 只作用于内置 DeepSeek 配置（用户自建配置不动，避免打到自定义网关上可用的别名）。
const LEGACY_DEFAULT_MODELS = {
  'deepseek-v4-flash': DEFAULT_MODEL_ID,
}
const DEFAULT_DEEPSEEK_PROFILE = {
  id: DEEPSEEK_PROFILE_ID,
  name: 'DeepSeek',
  apiKey: '',
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL_ID,
  contextWindow: 1024 * 1024,
  builtin: true,
  trial: false,
  // 是否支持读图（多模态）。默认关：DeepSeek 系文本模型收到 image_url part 会直接 400，
  // 宁可不发，也不要让用户遇到"这轮突然报错"。
  vision: false,
}

// ============================================================
//  产品角色 harness —— 自包含物料库（角色提示词 / 技能 / 约定）
//  随应用打包，可整体复制到其它应用使用；路径统一用 {{TOKEN}} 占位，
//  由 resolvePlaceholders 替换为真实路径
// ============================================================
const HARNESS_ROOT = path.join(__dirname, '..', 'harness')
const HARNESS_SKILLS_DIR = path.join(HARNESS_ROOT, 'skills')      // 产品角色技能库（skills/pm-*）
const HARNESS_QA_SKILLS_DIR = path.join(HARNESS_ROOT, 'skills-qa') // 测试角色技能库（skills-qa/qa-*）
const HARNESS_EXCEL_SKILLS_DIR = path.join(HARNESS_ROOT, 'skills-excel') // Excel专家技能库（skills-excel/xl-*）
const HARNESS_LEGAL_SKILLS_DIR = path.join(HARNESS_ROOT, 'skills-legal') // 法务专家技能库（skills-legal/legal-*）
const HARNESS_DEV_SKILLS_DIR = path.join(HARNESS_ROOT, 'skills-dev') // 开发角色技能库（skills-dev/dev-*）
const HARNESS_CONVENTIONS_DIR = path.join(HARNESS_ROOT, 'conventions')
// 已启用 harness 的角色键（product=产品 / qa=测试 / excel=Excel专家 / legal=法务专家）；这些角色在 skill 目录挂载、
// 系统提示词注入、角色白名单校验上与通用角色一并处理；excel/legal 不受权限控制，所有人可用
const HARNESS_ROLES = ['product', 'qa', 'excel', 'dev', 'legal']
// 产品角色连续反问上限：超过后引导模型停止反问、基于已有信息收口
const MAX_CONSECUTIVE_ASKS = 5

// 上下文窗口相关常量为 context.js 提供（压缩/估算域）
// 注意：DEFAULT_CONTEXT_WINDOW 同样是 1M，所以某模型未登记时回退值不影响结果；
// 迁改模型 id 时这张表要同步，否则「已登记」的语义会失准（现在表内只有现行 id）。
const MIN_CONTEXT_WINDOW = 256 * 1024     // 上下文窗口最小允许值（256K），防误填过小导致压缩失效
const MODEL_CONTEXT_WINDOWS = {
  [DEFAULT_MODEL_ID]: 1024 * 1024,
  'deepseek-v4-pro': 1024 * 1024,
}
const DEFAULT_CONTEXT_WINDOW = 1024 * 1024

// ============================================================
//  平台与环境配置（ERP / MES-Boss / MES-WEB）
//  真实的平台差异（域名、登录形态、能力开关）全部收在 platforms.js，
//  本文件只做转发 + 默认值兜底，避免同一份 URL 在多处写死。
// ============================================================
// ============================================================
//  代码仓库目录（开源版）
//  「产品 / 测试」角色要读的代码根目录。企业版这里是「切身份自动拉取的内网仓库」，
//  开源版改为**由用户提供**：默认取第一个授权目录里的第一个 git 仓库；没有则回退第一个授权目录；
//  再没有则是空串（提示词里会说明「未配置」）。
//  ⚠️ 二次开发：想固定指向某个源码目录，改这里即可。
// ============================================================
function getCodeRepoDir() {
  const firstAllowed = (state.settings.allowedDirs || []).find((d) => typeof d === 'string' && d.trim())
  if (!firstAllowed) return ''
  const root = path.resolve(firstAllowed)
  try {
    for (const name of fs.readdirSync(root)) {
      const candidate = path.join(root, name)
      if (fs.existsSync(path.join(candidate, '.git'))) return candidate
    }
  } catch {
    /* 读不到就当没有 */
  }
  return root
}

// Git 可执行文件探测（开源版自带：企业版这段在 kbase.js 里，随知识库模块一并移除）
let cachedGitCmd = null
async function findGitExecutable() {
  if (cachedGitCmd) return cachedGitCmd
  for (const c of ['git', 'C:/Program Files/Git/cmd/git.exe', 'C:/tools/Git/cmd/git.exe']) {
    try {
      await execFilePromise(c, ['--version'])
      cachedGitCmd = c
      return c
    } catch {
      /* 继续试下一个 */
    }
  }
  return null
}
function gitProbeReset() {
  cachedGitCmd = null
}

// ============================================================
//  目录解析
// ============================================================

// 产品角色产物输出目录 —— 默认输出到设置页「文件访问权限」里的第一个已授权目录；
// 未配置授权目录时回退到 userData/product-output（白名单自动允许读写）。
function getProductOutputDir() {
  const firstAllowed = (state.settings.allowedDirs || []).find((d) => typeof d === 'string' && d.trim())
  if (firstAllowed) return path.resolve(firstAllowed)
  return path.join(app.getPath('userData'), 'product-output')
}

// 测试角色产物输出目录（测试报告/台账/黑盒记录）—— 与产品角色同规则
function getTestOutputDir() {
  const firstAllowed = (state.settings.allowedDirs || []).find((d) => typeof d === 'string' && d.trim())
  if (firstAllowed) return path.resolve(firstAllowed)
  return path.join(app.getPath('userData'), 'test-output')
}

// Excel专家产物输出目录 —— 与产品角色同规则
function getExcelOutputDir() {
  const firstAllowed = (state.settings.allowedDirs || []).find((d) => typeof d === 'string' && d.trim())
  if (firstAllowed) return path.resolve(firstAllowed)
  return path.join(app.getPath('userData'), 'excel-output')
}

// 法务专家产物输出目录 —— 与产品角色同规则
function getLegalOutputDir() {
  const firstAllowed = (state.settings.allowedDirs || []).find((d) => typeof d === 'string' && d.trim())
  if (firstAllowed) return path.resolve(firstAllowed)
  return path.join(app.getPath('userData'), 'legal-output')
}

// 内置浏览器（网页测试窗口）下载落盘目录：AI 点击官网「下载」按钮后文件统一保存到此处，
// 由 fs-safe 白名单放行，AI 后续可用 read_file / execute_command 读取解析。
function getBrowserDownloadsDir() {
  return path.join(app.getPath('userData'), 'browser-downloads')
}

// execute_command 超长输出的落盘目录（userData/tool-output）：
// 返回值里只保留头尾各 8KB，完整输出写到这里并把路径交回模型 ——
// 所以必须像 browser-downloads 一样被 fs-safe 白名单自动放行，
// 否则「用 grep_code 去 stdoutPath 捞报错」这句指引对非 dev 角色是空头支票（grep_code 会 Access denied）。
function getCommandOutputDir() {
  return path.join(app.getPath('userData'), 'tool-output')
}

// LibreOffice 安装目录探测（返回 program 目录或 null）。
// 与 skills/xlsx/scripts/office/soffice.py 的 find_soffice() 候选保持一致。
// 注意：安装 LibreOffice 后【不再写入系统 PATH】——那会让 LO 自带的 python.exe
// 抢到裸 `python`，导致 AI 的 Excel 脚本 import openpyxl 失败（helpers.js resolvePython
// 注释记录过该坑）。soffice 一律按绝对路径使用。
function findLibreOfficeDir() {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA, // per-user installs（winget --scope user 等）
  ]
  for (const root of roots) {
    if (!root) continue
    const programDir = path.join(root, 'LibreOffice', 'program')
    if (fs.existsSync(path.join(programDir, 'soffice.exe'))) return programDir
  }
  return null
}

// ============================================================
//  Ensure directories exist
// ============================================================
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
  return dirPath
}

// ============================================================
//  Settings persistence
// ============================================================
function getSettingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE)
}

// 存量设置迁移：把「仍是旧默认模型 id」的内置 DeepSeek 配置改写到现任默认 id。
// 只认内置配置（id === DEEPSEEK_PROFILE_ID）——用户自建配置可能指向别的 OpenAI 兼容网关，
// 那里的模型别名不一定跟着 DeepSeek 官方改名，擅自改写会把可用配置改坏。
function migrateLegacyDefaultModel(profile) {
  if (!profile || profile.id !== DEEPSEEK_PROFILE_ID) return profile
  const current = LEGACY_DEFAULT_MODELS[profile.model]
  if (current) profile.model = current
  return profile
}

function normalizeProfiles(rawProfiles, legacy = {}) {
  const source = Array.isArray(rawProfiles) ? rawProfiles : []
  const profiles = source.map((p, index) => ({
    id: typeof p.id === 'string' && p.id ? p.id : `profile-${index + 1}`,
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : `模型 ${index + 1}`,
    apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
    baseUrl: typeof p.baseUrl === 'string' && p.baseUrl.trim() ? p.baseUrl.trim() : DEFAULT_BASE_URL,
    model: typeof p.model === 'string' && p.model.trim() ? p.model.trim() : DEFAULT_MODEL_ID,
    contextWindow: typeof p.contextWindow === 'number' && p.contextWindow >= MIN_CONTEXT_WINDOW ? p.contextWindow : DEFAULT_CONTEXT_WINDOW,
    builtin: p.id === DEEPSEEK_PROFILE_ID,
    // trial：由设置页「立即试用」按钮自动下发的配置。只读，参数不可改，只能整条删除。
    // 仅显式 true 才算（用 === 严格判定，避免历史脏值被误判为试用配置而锁死）
    trial: p.trial === true,
    // vision：该配置的模型是否支持读图（多模态）。只有显式 true 才算开启 ——
    // 老 settings.json 没有这个字段，一律按"不支持"处理（保守：不发图就不会 400）。
    vision: p.vision === true,
  }))
  profiles.forEach(migrateLegacyDefaultModel)
  let deepseek = profiles.find((p) => p.id === DEEPSEEK_PROFILE_ID)
  if (!deepseek) {
    deepseek = migrateLegacyDefaultModel({
      ...DEFAULT_DEEPSEEK_PROFILE,
      apiKey: typeof legacy.apiKey === 'string' ? legacy.apiKey : '',
      baseUrl: typeof legacy.baseUrl === 'string' && legacy.baseUrl.trim() ? legacy.baseUrl.trim() : DEFAULT_BASE_URL,
      model: typeof legacy.model === 'string' && legacy.model.trim() ? legacy.model.trim() : DEFAULT_MODEL_ID,
      contextWindow: typeof legacy.contextWindow === 'number' && legacy.contextWindow >= MIN_CONTEXT_WINDOW ? legacy.contextWindow : DEFAULT_CONTEXT_WINDOW,
    })
    profiles.unshift(deepseek)
  } else {
    deepseek.builtin = true
  }
  const unique = []
  const ids = new Set()
  for (const profile of profiles) {
    if (ids.has(profile.id)) continue
    ids.add(profile.id)
    unique.push(profile)
  }
  return unique
}

function getActiveProfile(profileId) {
  const profiles = Array.isArray(state.settings.modelProfiles) ? state.settings.modelProfiles : []
  return profiles.find((p) => p.id === profileId) || profiles.find((p) => p.id === state.settings.activeProfileId) || profiles.find((p) => p.id === DEEPSEEK_PROFILE_ID) || profiles[0] || DEFAULT_DEEPSEEK_PROFILE
}

function loadSettings() {
  let raw = {}
  try {
    const p = getSettingsPath()
    if (fs.existsSync(p)) raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch (e) {
    console.error('Failed to load settings:', e)
  }
  state.settings = {
    themeName: typeof raw.themeName === 'string' ? raw.themeName : 'light',
    // 自定义主色（单套）：合法 6 位 hex 或 null
    customTheme: typeof raw.customTheme === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.customTheme) ? raw.customTheme : null,
    fontScale: typeof raw.fontScale === 'number' ? raw.fontScale : 1,
    skillsDir: typeof raw.skillsDir === 'string' ? raw.skillsDir : DEFAULT_SKILLS_DIR,
    memoryDir: typeof raw.memoryDir === 'string' ? raw.memoryDir : DEFAULT_MEMORY_DIR,
    allowedDirs: Array.isArray(raw.allowedDirs) ? raw.allowedDirs.filter(d => typeof d === 'string') : [],
    autoExecute: typeof raw.autoExecute === 'boolean' ? raw.autoExecute : true,
    // 长任务结束时的系统通知（屏幕右下角横幅）——**正常完成与异常结束都提醒**，只有
    // 「用户自己点中断」不提醒。用户切走去干别的事时，这是唯一能告诉他"跑完了 / 挂了"
    // 的渠道，因此**恒为开启、设置页已撤下开关**（2026-10-08）。老 settings.json 里遗留的
    // `notifyOnTaskEnd: false` 在此被自然丢弃，处理方式与 thinkingEnabled 相同。
    notifyOnTaskEnd: true,
    // 思考模式：恒为开启，无开关（老 settings.json 里遗留的 thinkingEnabled 字段在此被自然丢弃）
    role: HARNESS_ROLES.includes(raw.role) ? raw.role : 'general',
    modelProfiles: normalizeProfiles(raw.modelProfiles, raw),
    activeProfileId: typeof raw.activeProfileId === 'string' ? raw.activeProfileId : DEEPSEEK_PROFILE_ID,
  }
  if (!state.settings.skillsDir) state.settings.skillsDir = DEFAULT_SKILLS_DIR
  if (!state.settings.memoryDir) state.settings.memoryDir = DEFAULT_MEMORY_DIR
  if (state.settings.activeProfileId !== DEEPSEEK_PROFILE_ID && !state.settings.modelProfiles.some((p) => p.id === state.settings.activeProfileId)) {
    state.settings.activeProfileId = DEEPSEEK_PROFILE_ID
  }
  const active = getActiveProfile(state.settings.activeProfileId)
  // Legacy aliases remain in memory for compatibility with older helper paths.
  state.settings.apiKey = active.apiKey
  state.settings.baseUrl = active.baseUrl
  state.settings.model = active.model
  state.settings.contextWindow = active.contextWindow
  saveSettings()
  return state.settings
}

function saveSettings() {
  try {
    const p = getSettingsPath()
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(p, JSON.stringify(state.settings, null, 2), 'utf-8')
  } catch (e) {
    console.error('Failed to save settings:', e)
  }
}

// 返回当前配置的 OpenAI 兼容 API Base URL（state.settings.baseUrl 为空时回退 DeepSeek 默认）
function getApiBaseUrl() {
  return getActiveProfile().baseUrl || DEFAULT_BASE_URL
}

// ============================================================
//  Harness 占位符与系统提示词
// ============================================================

// ---- Python 命令解析（{{PYTHON_CMD}}）----
// 裸 `python` 经 Git Bash 走 PATH 可能命中 LibreOffice 自带 python（装 LO 后
// 缺 openpyxl/pandas）或 WindowsApps 的 stub。resolvePython()（helpers.js）用
// `py -3` 优先绕开这两者——把其结果缓存为「可直接嵌入 bash 的单串」，
// 供 {{PYTHON_CMD}} 占位符与系统提示词使用（AI 执行 Excel 脚本必须用它）。
let pythonCmdCache = 'python'
function pythonCmdForShell() {
  return pythonCmdCache
}
function toBashCmd(argv) {
  if (!argv || argv.length === 0) return 'python'
  if (argv[0] === 'py') return argv.join(' ')            // 'py -3' / 'py -3.10'
  if (argv[0] === 'python' || argv[0] === 'python3') return argv[0]
  return `"${String(argv[0]).replace(/\\/g, '/')}"`      // 绝对路径 → 正斜杠 + 引号，Git Bash 可直接执行
}
// 模块加载即异步解析（app 就绪前早已完成）；失败/未完成时保持默认 'python'。
resolvePython()
  .then((argv) => { pythonCmdCache = toBashCmd(argv) })
  .catch(() => {})

// 替换 harness 物料中的 {{TOKEN}} 占位符为宿主真实路径。
// 技能 / 约定文件被 read_skill / read_file 读取时也要能解析，保证 AI 拿到的路径可直接用。
// ⚠️ 新增占位符必须同步：本函数 + oss/check.mjs 的白名单。
function resolvePlaceholders(text) {
  return String(text)
    .replaceAll('{{PYTHON_CMD}}', pythonCmdForShell())
    .replaceAll('{{PRODUCT_OUTPUT_DIR}}', getProductOutputDir())
    .replaceAll('{{TEST_OUTPUT_DIR}}', getTestOutputDir())
    .replaceAll('{{EXCEL_OUTPUT_DIR}}', getExcelOutputDir())
    .replaceAll('{{LEGAL_OUTPUT_DIR}}', getLegalOutputDir())
    // 产品 / 测试角色读的代码仓库根目录（开源版：由授权目录解析，未配置时为空串）
    .replaceAll('{{CODE_REPO_DIR}}', getCodeRepoDir())
    .replaceAll('{{HARNESS_ROOT}}', HARNESS_ROOT)
    .replaceAll('{{HARNESS_SKILLS_DIR}}', HARNESS_SKILLS_DIR)
    .replaceAll('{{HARNESS_QA_SKILLS_DIR}}', HARNESS_QA_SKILLS_DIR)
    .replaceAll('{{HARNESS_EXCEL_SKILLS_DIR}}', HARNESS_EXCEL_SKILLS_DIR)
    .replaceAll('{{HARNESS_DEV_SKILLS_DIR}}', HARNESS_DEV_SKILLS_DIR)
    .replaceAll('{{HARNESS_LEGAL_SKILLS_DIR}}', HARNESS_LEGAL_SKILLS_DIR)
    .replaceAll('{{BUILTIN_SKILLS_DIR}}', BUILTIN_SKILLS_DIR)
    .replaceAll('{{HARNESS_CONVENTIONS_DIR}}', HARNESS_CONVENTIONS_DIR)
    .replaceAll('{{SKILLS_DIR}}', state.settings.skillsDir || '')
    .replaceAll('{{MEMORY_DIR}}', state.settings.memoryDir || '')
}

// 读取产品 harness 中的角色系统提示词（roles/<role>/system-prompt.md）。
// 读失败返回 ''，buildSystemPrompt 降级为通用角色说明，不影响主流程。
function readHarnessRolePrompt(role) {
  try {
    const p = path.join(HARNESS_ROOT, 'roles', role, 'system-prompt.md')
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8')
  } catch (e) {
    console.error('[harness] read role prompt failed:', e)
  }
  return ''
}

// 技能清单段 + 项目级上下文段（2026-09-29 参照 opencode 补齐，见各模块头部注释）。
// 两处都在函数体内 require：settings.js 被 tools/skills.js 依赖，
// 顶层互相 require 会形成循环，函数内延迟加载可规避（Node 会命中缓存，开销可忽略）。
function buildSkillIndexSectionSafe() {
  try {
    return require('./tools/skills').buildSkillIndexSection() || ''
  } catch (e) {
    console.error('[skills] build index failed:', e)
    return ''
  }
}

function buildProjectContextSafe(userMessages) {
  try {
    return require('./agents-md').buildProjectContext(userMessages || []) || ''
  } catch (e) {
    console.error('[agents-md] build context failed:', e)
    return ''
  }
}

function buildSystemPrompt(allowedDirs = [], userMessages = [], profile = null) {
  console.log('[buildSystemPrompt] allowedDirs:', JSON.stringify(allowedDirs))
  // 看图能力（多模态）按**本次请求用的 profile** 判定；不传时退回当前激活配置
  // （测试与旧的调用点只传前两个参数）。
  const activeProfile = profile || getActiveProfile(state.settings.activeProfileId)
  const visionCapable = !!activeProfile && activeProfile.vision === true
  let skillsNote = ''
  if (fs.existsSync(BUILTIN_SKILLS_DIR)) {
    skillsNote = ` (包含内置技能库：${BUILTIN_SKILLS_DIR})`
  }
  let dirsList = `- Skills: ${state.settings.skillsDir}${skillsNote}\n- Memory: ${state.settings.memoryDir}`
  if (allowedDirs.length > 0) {
    dirsList += '\n' + allowedDirs.map(d => `- ${d}`).join('\n')
  }
  // 通用角色面向非技术业务人员：读代码回答时用业务语言、不暴露代码标识符。
  // product/qa 角色需要看到具体代码实现，因此不注入此约束。
  let generalAudienceNote = ''
  if (!HARNESS_ROLES.includes(state.settings.role) && state.settings.role !== 'dev') {
    generalAudienceNote = `
【面向业务人员的回答约束（重要）】
你的使用者主要是非技术的业务人员，看不懂大段英文代码标识符。当你读代码来回答用户问题时：
- 不要在回答中罗列底层代码标识符：字段名、接口名 / API 路径、方法名、类名、变量名、数据库表名等（通常是一串英文或驼峰命名）。
- 用通俗的中文业务语言描述：这个功能 / 数据是做什么的、从哪里来、怎么算的、有什么规则与口径。
- 仅当用户明确以技术人员身份要求查看具体代码实现或字段定义时，才适度给出代码标识符；默认一律按业务语言表述。`
  }
  // 通用角色也能直接处理 Excel（业务员常忘记切换到 Excel专家角色）：
  // 已在 skills.js 放开 xl-* 技能可见性，这里补一份轻量护栏（Excel专家角色已有完整规范，不重复注入）。
  const isGeneral = !HARNESS_ROLES.includes(state.settings.role)
  const xlLiteNote = isGeneral
    ? `
【表格文件通用护栏（不切换 Excel专家 角色也能安全处理，重要）】
用户直接丢给你 .xlsx / .xlsm / .xltx / .csv / .tsv 让你处理时：
- 先用 read_skill 拿现成做法与参数：xl-read 看结构（列/类型/空值/行数）、xl-clean / xl-transform / xl-format / xl-convert 走预置脚本、xl-formula 管公式、xl-chart 画图、xl-batch 批量；openpyxl/pandas/recalc 的权威规则见内置 xlsx 技能（read_skill('xlsx')），pycel 兼容与 gotcha 以它为准。
- 安全底线：修改已有文件前先备份（cp 原文件 原文件.bak）；不覆盖源文件，输出用 _cleaned / _converted / _merged / _chart 等新名字；删除整列整行、批量修改、合并多文件、覆盖已有文件前用 ask_user 让用户确认。
- 写入公式后必须校验：运行 recalc.py --check（默认不写盘、公式保留），报告 errors_found 先修复再交付；不要用 Python 硬编码计算结果冒充公式。
- 过程脚本与中间文件一律写到系统为本轮分配的**会话临时工作目录** {{EXCEL_WORK_DIR}}（**原样照抄这一整串绝对路径，不要自己拼、也不要只写到它的上一级 .xl-work 目录** —— 写在 .xl-work 根下的脚本不属于任何一轮、不会被自动清理；每轮自动创建；本轮对话结束无论正常/报错/中断都会自动删除，不用自己删，也不要在这里放任何要交付的内容）。要交付的 xlsx / csv / 图表等产物写到授权目录（未配置授权目录时用 userData/excel-output），汇报给用户的绝对路径只指向交付产物。不要用 write_file 把 .py 脚本写到用户目录、授权目录根部或交付目录。`
    : ''

  // ERP 段按角色分化：
  //  - 测试角色（qa）白盒核对只认**已自动拉取的开发分支仓库**（前端 feature_wz / 后端 develop）；
  //  - 产品角色（product）同样读**已自动拉取的正式分支仓库**（前端 PC master_X / H5 端 master_X / 后端 prod）——
  //    产品与测试同属部门内部，可直接看真实代码，不再绕知识库脱敏副本；
  //  - 知识库 源代码目录/源代码目录 是正式环境脱敏副本，对这两个身份只留给 glob_files / grep_code 定位页面路由。
  // 开发角色绕过授权目录白名单（见 tools/fs-safe.js 的 isPathAllowed），
  // 所以「文件访问限于以下目录」这句对它就是**假话** —— 不改的话模型看到白名单外的
  // 路径会畏手畏脚、甚至反过来问用户能不能改。这里按角色换成真实描述。
  const isDevRole = state.settings.role === 'dev'
  const accessDesc = isDevRole
    ? 'You have FULL read/write access to this computer in this session (the dev role bypasses the allowed-directory whitelist). The paths listed below are just the usual working folders, NOT a restriction.'
    : "You have the ability to read and write files on the user's computer in allowed directories."
  const accessListTitle = isDevRole
    ? '常用工作目录（不是限制，你可以在本机任意路径读写）：'
    : 'Your file access is limited to these directories:'

  // ------------------------------------------------------------
  //  dev 角色**不带** ERP / 浏览器类工具（工具集已在 chat.js 的 DEV_TOOL_NAMES 收窄到 19 个），
  //  所以下面两段"教你用 browser_* / read_file / grep_code / read_file"的说明
  //  对它是**指向不存在的工具** —— 整段不注入，否则模型会反复尝试调用不存在的工具、白烧往返。
  //  dev 定位代码的路径写在 harness/roles/dev/system-prompt.md（本机仓库 + grep_code / glob_files）。
  //  起因见 changes.md「dev 角色工具集收窄 + 一轮内工具并发执行」（2026-09-30）。
  //  ⚠️ 这两段的正文里**不能出现反引号**（它们本身就是模板字符串）。
  // ------------------------------------------------------------
  const webTestSection = isDevRole
    ? ''
    : `【网页测试 — 测试网页、网页自动化、打开网站时使用 browser_* 原生工具】
- 打开/跳转网页 → browser_open(url)
- 查看可交互元素 → browser_snapshot(max)  # 返回按钮/输入框等紧凑清单，每项带 "ref"（不再返回 CSS 选择器，最省 token）；另给 total（全部候选数，判断是否被截断）与 duplicates（重名统计）。**先看一次拿到 ref 就够，别每步都调**
- **批量执行一串步骤 → browser_flow(steps)**  # 首选节奏。一次传 [{action, target, value}] 顺序执行并可带断言，失败即停、回传失败那步的上下文与当前快照。20 步只花 1 次往返（逐步点击要 40+ 次）。action：click / type / press / wait / goto / sleep / assertText / assertValue / assertVisible / assertUrl / assertEval
- 读取页面文字/数据 → browser_get_page()   # 返回 URL/标题/文本/链接，仅在需要读正文/结果时用
- 点击元素 → browser_click(selector)  # selector 用 browser_snapshot 给的 ref（如 "ref=23"），或 CSS，或 text=文本。**同名文本必须用 ref，或写 "text=编辑 >> nth=57"（0 起）——裸 text= 永远只命中第一个**
- 输入文本 → browser_type(selector, text)
- 按键 → browser_press(key)           # 如 Enter、Escape、Control+S
- 等待元素/条件 → browser_wait_for(selector 或 condition)
- 执行页面 JS → browser_eval(js, arg) # 复杂读取、自定义等待
- 读取页面控制台 → browser_console_logs()
- 固化/回放流程 → browser_flow(saveAs:'流程名') 把跑通的流程存成 YAML；之后 browser_flow(flow:'流程名') 可**零模型**回放（回归期直接重跑）
- 关闭测试窗口 → browser_close()
${visionCapable ? '- **看页面里的图 → browser_read_images(max)**  # 把当前页面里的图片以**图像形式**发给你，你能直接看到（横幅/图表/布局/截图类内容）。先 browser_open 再调；一次默认 3 张、最多 4 张，每张约 1.4k token 且后续每轮都会重发 —— 不要反复调，也不要为了"确认页面加载了"而调。\n' : ''}
注意：${visionCapable
      ? 'browser_screenshot 只把截图落成**文件路径**，你自己看不到那张图 —— 要自己看图请用 browser_read_images；screenshot 仅在用户明确要求截图留档时用，最多一次。'
      : 'browser_screenshot 默认被禁用（你无法看图，截图对你推理无用）。仅当用户明确要求截图/留档时才可用，且最多截一次，绝不每步截图。'}**黑盒测试的正确节奏：browser_snapshot 看一次 → 用 browser_flow 把已经确定的步骤批量执行 → 只有失败时才看回传的 failedAt + snapshot 排查**，不要"每步快照 + 每步点击"地来回，那是往返次数与上下文膨胀的主要来源。

用户要求测试网页、网页自动化、打开/访问某网站、验证网页功能时，优先使用这些原生工具，不要默认去写 Python Playwright 脚本（除非需要 headless 批量流程）。

`
  // ------------------------------------------------------------
  //  看图能力（多模态）—— 2026-10-05 新增
  //  历史情况：提示词里「图片 / 视觉 / 多模态」零命中，模型不知道自己能看图 ——
  //  用户贴了图片直链它也可能回答"我无法查看图片"，更不会主动去取网页里的图。
  //  只在配置勾了「支持读图」时注入（勾选入口在设置页模型配置页签，字段 modelProfiles[].vision）。
  //  ⚠️ 修改这段时注意：这里与 chat.js 的 browser_read_images 下发闸门必须同源
  //     （都读 profile.vision）—— 提示词说"你能看图"但工具没下发，模型会反复尝试调用不存在的工具。
  // ------------------------------------------------------------
  // dev 角色的取图路径与其它角色**不同**：它没有任何 browser_*（DEV_TOOL_NAMES），
  // 所以不能让它读到"用 browser_read_images 取图"——那是它没有的工具。
  // 但 dev 依然要能看图：它有 read_image（本机图片）+ execute_command（可把网页图 curl 到本地）。
  const visionHowTo = isDevRole
    ? `- 图在哪就去哪取（本角色没有浏览器类工具，别惦记 browser_*）：
  - **本机图片文件**（用户给的路径、从 wiki/文档下载或抽出来的图、自己导出的截图）→ read_image(path)，图片会附在你的下一条消息里。
  - **网页里的图** → 先用 execute_command 把它下载到本地（如 curl -o），再 read_image 看它；页面正文用 curl / read_file 读原始 HTML。
  - **用户直接贴的 https 图片直链**、或用附件发的本地图片 → 已经在消息里了，直接看图作答。`
    : `- 图在哪就去哪取：
  - **本机图片文件**（用户给的路径、从 wiki/文档下载或抽出来的图、自己导出的截图）→ read_image(path)，图片会附在你的下一条消息里。
  - **用户直接贴的 https 图片直链**（.png / .jpg / .jpeg / .webp）、或用附件发的本地图片 → 已经在消息里了，直接看图作答。
  - **网页里的图**（用户给了网址、或让你"看看这个页面"）→ 先 browser_open(url) → 再 browser_read_images 取图 → 需要正文再用 browser_get_page()。`
  const visionSection = visionCapable
    ? `【看图能力（当前模型支持读图，重要）】
- 你**能看见图片**：不要说自己"看不到图片"，也不要把图片地址当成文字去猜内容。
${visionHowTo}
- **绝对不要用 read_file 读图片文件**（它会把二进制当文本吐一堆乱码，你会误以为"读不出来"）；也不要为了看一张图去折腾 OCR / PowerShell —— 你有直接看图的通道，那是在绕远路。
- 图片是**当轮**的：它不会永久留在对话历史里（压缩 / 续跑后都会消失）。后续轮次如果还需要看，重新调一次对应工具。
- 一张图 / 一个页面不要反复取（每张图约 1.4k token 且每轮重发）；用户明确说"要看图"时务必真的去看，不要只读文字就下结论。

`
    // 关闭读图时**也要说清**：这里注入的不是"能力说明"而是一条**行为纪律** ——
    // 不说的话模型会走 OCR / 像素推断那条路（2026-10-05 真实事故：用户给了一张 UI 截图，
    // 模型跑了 10 次 execute_command 调 Windows.Media.Ocr 抠字，整轮都耗在绕路上），
    // 而用户看到的是"它说自己看不到图"，完全不知道该怎么把能力打开。
    : `【图片：当前配置不支持读图（重要，不要绕路）】
- 你现在**收不到任何图片**：当前模型配置没有开启「支持读图（多模态）」，视觉类工具也没有下发给你。
- 遇到要看图的请求（用户给了图片路径、截图、或让你看某个页面里的图）→ **如实说明 + 给出可执行的下一步 + 停下来等用户**：
  告诉用户「当前配置未开启读图能力（也可能是当前用的不是多模态模型），请到 **设置 → 模型配置** 页签勾选『该模型支持读图（多模态）』并确认用的是能收图片的模型，然后重试」。
- **不要用 OCR（Windows.Media.Ocr / tesseract）、像素坐标推断、或凭文件名猜测来假装自己读了图片** ——
  那是拿十几次工具往返换一个不可靠结论，还会让用户误以为你真的看见了。
- read_file 读图片文件会被直接拒绝（乱码没有意义），它返回的提示里也写明了该用哪个工具。

`

  return `You are Local AI, a helpful AI assistant running as a desktop application.

${accessDesc}
When the user asks you to work with files, use the available tools.

Key capabilities:
- Read/write/edit files in allowed directories
- List directory contents
- Search code with regex (grep_code) and find files by pattern (glob_files)
- Manage skills (reusable knowledge/capabilities stored as .md files)
- Manage memories (persistent facts stored as .md files)

【代码编辑 — 编辑/修改代码和文件时使用 edit_file 工具】
- 精确编辑 → edit_file(path, old_string, new_string)  # str_replace 方式精确替换
- 先用 read_file **一次读完整个文件**（默认就返回全文）→ 找到要修改的部分 → 用 edit_file 精确替换
- old_string 必须是文件中的精确原文（含缩进和空格），确保唯一匹配
- 只改几行时绝不重写整个文件，优先用 edit_file；大段重写才用 write_file
- **读文件要一次读完、不要分块**：read_file 默认就返回整个文件。不要用 offset/limit 把文件切成几十段读
  —— 那样读一个 400 行的文件要花几十次工具调用，往返次数和上下文都会被浪费掉。只有文件确实巨大
  且你只需要其中一段时才用 offset/limit。
- **不要反复读同一个文件**：同样的文件、同样的参数读第二次不会得到新信息。读够了就开始改，
  不要"再确认一下"。
- **一次要看多个文件时，在同一条消息里并行发起多个 read_file**（一次往返读多个），不要一个一个来。
- **多个文件互不依赖时，在同一条消息里并行发起多个 edit_file**（一次往返改多个）；同一个文件的多处改动也尽量一轮发完。
  批量读 + 批量改是把往返次数压下来的关键 —— 改码慢的头号原因不是模型慢，而是"读一个改一个"的串行节奏。

【任务清单 — 多步任务先列计划（update_todos 工具，全角色可用）】
- **什么时候用**：任务需要 3 步以上（读多个文件 / 改多处 / 查多个来源 / 整理多份材料 / 做完要自检）时，
  在**动手之前**先调 update_todos 把步骤列成 3~8 条，然后按清单推进；一句话就能做完的琐碎任务不要用。
- **它怎么工作**：清单由系统**在每一轮请求末尾原样回显给你**（所以你不用背诵计划，也不会跑着跑着忘了做到哪），
  同时用户在界面上也能看到这份清单 —— 它是"做到哪了"的唯一依据，保持它准确。
- **调用节奏**：开工一次 + 每**真正完成**一项（含验证）一次。清单没变就不要重复调用；每轮都调会被当作重复调用拦下。
- **⚠️ 不要在做完后清空清单**：全部完成后直接给出最终回答就行，清单**保留**下去 —— 它是你和用户共同的进度记录，
  用户会对着它核对结果。（用户发下一条新消息时系统会**自动清空**它，不需要你处理。）
  只有用户明确要求清空、或整个计划作废（方向变了）时才传空数组 []。
- 完整规则（状态取值、整表覆盖、只允许一项进行中等）见 update_todos 的工具说明，此处不重复。

【代码搜索 — 在授权目录中搜索代码和文件】
- 搜索代码内容 → grep_code(pattern, path, include)  # 正则或关键词搜索，返回 file:line:snippet
- 查找文件 → glob_files(pattern, path)  # 通配符如 "src/**/*.vue"、"*.test.ts"

${accessListTitle}
${dirsList}
${loginNote}

【文件定位 — 先用工具确认真实路径，严禁凭描述拼路径】
用户提到的文件名常常带有中文、全角括号【】、空格和版本号，例如「【上半年运费分析】2026运费明细含子公司 v2.xlsx」。read_file 是精确匹配，差一个字符就报 File not found。因此处理用户提到的文件时：
- **先确认再使用**：用 list_directory 列出授权目录，或 glob_files(pattern, path) 按 "*关键词*.xlsx" 模糊搜索，拿到磁盘上的真实文件名后，原样复制成绝对路径再 read_file。
- **禁止推测/改写**：不要把【】改成 []、不要省略空格、不要改写版本号（v2 / V2 / 副本）、不要凭语义自己造文件名；也不要把「【上半年运费分析】」这类前缀当成用户给的描述标签而从文件名里删掉——它很可能就是文件名的一部分。
- **失败了看提示**：read_file / edit_file 报 File not found 时，错误信息里会附带"磁盘上名字相近的文件"的完整绝对路径，直接照抄重试即可，不要反复重试同一个错误路径。
- 目录名同理：list_directory 目录不存在时会返回名字相近的候选目录。

【预装技能 — 遇到以下关键词请先使用 read_skill 加载对应技能，不要自己写脚本】
- xlsx, excel, csv, 表格, 电子表格,  spreadsheet → read_skill('xlsx')  # 用 openpyxl/pandas 处理 Excel
  - 处理**含公式**的 Excel 前，先确认 pycel 可用：${pythonCmdForShell()} -c "import pycel"；不可用时先 pip install pycel，否则公式无法校验（recalc.py 依赖 pycel），写出的公式会读回 None / #NAME?。
  - 执行 Python 脚本 / recalc.py / 环境检查一律用命令前缀：${pythonCmdForShell()}（应用已解析为不会撞上 LibreOffice 自带 python 或 WindowsApps stub 的解释器，不要改用裸 python）。
- docx, doc, word, 文档, 报告 → read_skill('docx')  # 用 docx-js/pandoc 处理 Word
- pptx, ppt, powerpoint, 幻灯片, 演示, deck → read_skill('pptx')  # 用 pptxgenjs 处理幻灯片
- pdf → read_skill('pdf')  # 用 pypdf 处理 PDF
使用方式：用户提到了上面任何关键词 → 立即调用 read_skill 读取对应技能的 SKILL.md → 按照技能中的指引编写脚本执行。${xlLiteNote}
${buildSkillIndexSectionSafe()}
${buildProjectContextSafe(userMessages)}

${visionSection}${webTestSection}${generalAudienceNote}
【Python 脚本资源释放（重要 — 防止磁盘/内存占满）】
当你通过 execute_command 执行 Python 脚本（特别是处理大 Excel/CSV 文件）时，必须在脚本末尾主动释放资源：
- 用完的 Workbook / DataFrame 对象及时 del 或赋值 None，调用 gc.collect() 强制回收
- 打开的文件句柄必须 close()，推荐用 with 上下文管理器自动关闭
- 如果脚本加载了大文件（>100MB），处理完后立即删除临时文件（os.remove()）
- 不要在脚本中使用 input()、time.sleep() 等会阻塞进程的语句
- 脚本执行完成后，如果返回结果中包含文件路径，确保该文件不是临时的中间产物
- 示例模板：
  \`\`\`python
  import gc
  wb = openpyxl.load_workbook('huge.xlsx')
  try:
      # ... 处理逻辑 ...
      result = '处理完成'
  finally:
      wb.close()
      del wb
      gc.collect()
  print(result)
  \`\`\`

【澄清提问 — ask_user 工具，任何角色都可用】
用户需求的目标、范围、关键信息不清楚，或需要在多个方案/方向间让用户拍板时，可调用 ask_user 向用户提一个简短问题或给一组选择项（≤6 个）。应用会在聊天区弹出选择卡片，**卡片下方始终带一个自定义输入栏**（用户可忽略选项自己写），所以不必为了"留个自由发挥的入口"而额外加"其他"选项——把可能命中的答案尽量列全即可。用户点选/输入后把回答作为工具结果返回给你，继续推进。注意：问题要短、有推进价值；能推断的先给出你的判断让用户确认，不要把所有问题都推回给用户；同一信息已问过不要重复问；单个对话轮次内连续反问不要超过 3 次，用户回答后基于已有信息推进，仍未确认的项标记为"待确认"。

Always explain what you're doing before executing file operations.` +
    buildRolePromptSection()
}

// 角色系统提示词段落：产品/测试角色时读取对应 harness 物料库注入，通用角色返回空串（保持原行为）
const ROLE_LABELS = { product: '产品角色', qa: '测试角色', excel: 'Excel专家', dev: '开发角色', legal: '法务专家' }
function buildRolePromptSection() {
  if (!HARNESS_ROLES.includes(state.settings.role)) return ''
  const label = ROLE_LABELS[state.settings.role] || state.settings.role
  const raw = readHarnessRolePrompt(state.settings.role)
  let section = `\n\n【当前角色：${label}】\n`
  if (!raw) {
    return section + `（${label}提示词文件缺失，本次按通用角色能力工作）`
  }
  return section + resolvePlaceholders(raw)
}

// ============================================================
//  子代理（spawn_sub_agent）专用上下文 —— 2026-09-21 新增
//  背景：子代理是独立 LLM 循环，**不继承**主 Agent 的完整角色提示词（那会让它每轮 prefill 暴涨）。
//  但完全不给约定也不行：实测把它丢进授权目录找「某接口的实现」时，它全程 repo-wide 乱搜，
//  10 分钟内一轮都没收敛，最后撞超时被 abort、整段成果丢弃。
//  所以这里只注入它最缺的两样东西：① 仓库在哪 ② 检索纪律。
// ============================================================
const SUB_AGENT_DISCIPLINE = [
  '【检索纪律 — 直接决定你会不会撞超时，必守】',
  '1. grep_code / glob_files 必须传 path，指向具体仓库下的具体模块目录；不要停在仓库根，更不要留空',
  '   —— 不传 path 会扫描整个授权目录（几万个文件），单次要十几秒且结果会被时间预算截断。',
  '2. 尽量传 include：后端 "*.java" / "*.xml"，前端 "*.vue" / "*.ts"。',
  '3. 能猜出文件名片段时，先用 glob_files 定位文件（如 pattern="**/*Collect*.java" + path=<仓库根>），',
  '   再 read_file 精读 —— 比全库 grep 快一个数量级。',
  '4. 按接口路径 / Controller 类名 / 方法名 / 表名 / 字段名这类代码原文检索，少用中文业务词。',
  '5. 返回里出现 scan.incomplete 或提示「时间预算 / 条目上限导致结果不完整」时，不要原样重试',
  '   —— 缩小 path 或换更精确的关键词。',
  '6. 你有有限的墙钟预算，且时间到会被强制中止、只能回传半成品。同一个关键词不要反复扫；',
  '   连续 2 次检索都没命中就换策略（先 list_directory 看清目录结构，或换更精确的代码原文关键词）。',
  '7. 不要在子任务里做「通读整个仓库」这种事，先定位再精读，尽快给出结论。',
].join('\n')

function buildSubAgentContext() {
  const role = state.settings.role
  const label = ROLE_LABELS[role] || role
  const repoDir = getCodeRepoDir()
  const lines = [`- 当前角色：${label}`]
  if (repoDir) {
    lines.push(`- 本角色代码仓库根目录：${repoDir}`)
    lines.push('  （代码仓库都在该目录下；先 list_directory 看清有哪些仓库，再进具体仓库检索）')
  }
  lines.push(SUB_AGENT_DISCIPLINE)
  return lines.join('\n')
}

// ============================================================
//  settings / profiles / system 域 IPC
// ============================================================
function sanitizeSettings() {
  const active = getActiveProfile()
  return {
    hasApiKey: !!active.apiKey,
    apiKey: '',
    model: active.model,
    baseUrl: active.baseUrl,
    contextWindow: active.contextWindow,
    modelProfiles: state.settings.modelProfiles.map((p) => ({ ...p, apiKey: '', hasApiKey: !!p.apiKey })),
    activeProfileId: state.settings.activeProfileId,
    themeName: state.settings.themeName || 'light',
    customTheme: /^#[0-9a-fA-F]{6}$/.test(state.settings.customTheme || '') ? state.settings.customTheme : null,
    fontScale: typeof state.settings.fontScale === 'number' ? state.settings.fontScale : 1,
    skillsDir: state.settings.skillsDir || '',
    memoryDir: state.settings.memoryDir || '',
    allowedDirs: Array.isArray(state.settings.allowedDirs) ? [...state.settings.allowedDirs] : [],
    autoExecute: !!state.settings.autoExecute,
    notifyOnTaskEnd: state.settings.notifyOnTaskEnd !== false,
    role: HARNESS_ROLES.includes(state.settings.role) ? state.settings.role : 'general',
  }
}

function registerIpc() {
  // --- Model profiles ---
  ipcMain.handle('profiles:list', () => ({
    activeProfileId: state.settings.activeProfileId,
    profiles: state.settings.modelProfiles.map((p) => ({ ...p, apiKey: '', hasApiKey: !!p.apiKey })),
  }))
  ipcMain.handle('profiles:create', (_event, name) => {
    const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const profile = { id, name: typeof name === 'string' && name.trim() ? name.trim() : '新模型', apiKey: '', baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL_ID, contextWindow: DEFAULT_CONTEXT_WINDOW, builtin: false, trial: false, vision: false }
    state.settings.modelProfiles.push(profile)
    saveSettings()
    return { ...profile, apiKey: '', hasApiKey: false }
  })
  // 「立即试用」专用写入通道：唯一允许写 trial 配置的入口。
  // 复用已有试用页签（没有则新建），写入服务端下发的参数并补上 trial 标记。
  // 参数一律取自服务端下发结果，不接受用户手工编辑的其它字段。
  ipcMain.handle('profiles:setupTrial', (_event, data = {}) => {
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '免费试用'
    let profile = state.settings.modelProfiles.find((p) => p.trial === true)
    // 兼容存量：旧版本「立即试用」生成的页签没有 trial 标记，这里按名称识别并补标，避免重复建页签
    if (!profile) profile = state.settings.modelProfiles.find((p) => p.name === '免费试用')
    if (!profile) {
      profile = { id: `profile-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, apiKey: '', baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL_ID, contextWindow: DEFAULT_CONTEXT_WINDOW, builtin: false, trial: true, vision: false }
      state.settings.modelProfiles.push(profile)
    }
    profile.trial = true
    profile.name = name
    if (typeof data.apiKey === 'string' && data.apiKey) profile.apiKey = data.apiKey
    if (typeof data.baseUrl === 'string' && data.baseUrl.trim()) profile.baseUrl = data.baseUrl.trim()
    if (typeof data.model === 'string' && data.model.trim()) profile.model = data.model.trim()
    if (typeof data.contextWindow === 'number' && data.contextWindow >= MIN_CONTEXT_WINDOW) profile.contextWindow = data.contextWindow
    // 服务端可以顺带声明这个模型能不能收图片（多模态）；没下发就保持原值/默认关
    if (typeof data.vision === 'boolean') profile.vision = data.vision
    saveSettings()
    return { success: true, profileId: profile.id, profile: { ...profile, apiKey: '', hasApiKey: !!profile.apiKey } }
  })
  ipcMain.handle('profiles:update', (_event, id, patch = {}) => {
    const profile = state.settings.modelProfiles.find((p) => p.id === id)
    if (!profile) return { success: false, error: '模型配置不存在' }
    // ⚠️ 例外：「是否支持读图」(vision) 是**本机侧的能力声明**（告诉应用"这个模型能收图片"），
    //    不属于服务端下发的模型参数（apiKey / baseUrl / model / contextWindow），所以**试用配置也允许改**。
    //    否则用户拿到的试用模型恰好是多模态时，页签整体只读 → 读图功能永远开不起来。
    //    只接受"只带 vision 一个字段"的请求走这条例外，别让它变成绕过只读的后门。
    const onlyVisionPatch = typeof patch.vision === 'boolean' && Object.keys(patch).every((k) => k === 'vision')
    if (onlyVisionPatch) {
      profile.vision = patch.vision
      saveSettings()
      return { success: true, profile: { ...profile, apiKey: '', hasApiKey: !!profile.apiKey } }
    }
    // 试用配置由系统下发：参数只读，禁止任何改写（切换页签/保存设置时的自动回写也会走这里，静默失败即可）
    if (profile.trial === true) return { success: false, error: '试用配置由系统下发，不可修改，只能删除' }
    if (typeof patch.name === 'string' && patch.name.trim()) profile.name = patch.name.trim()
    if (typeof patch.apiKey === 'string' && patch.apiKey) profile.apiKey = patch.apiKey
    if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) profile.baseUrl = patch.baseUrl.trim()
    if (typeof patch.model === 'string' && patch.model.trim()) profile.model = patch.model.trim()
    if (typeof patch.contextWindow === 'number' && patch.contextWindow >= MIN_CONTEXT_WINDOW) profile.contextWindow = patch.contextWindow
    if (typeof patch.vision === 'boolean') profile.vision = patch.vision
    saveSettings()
    return { success: true, profile: { ...profile, apiKey: '', hasApiKey: !!profile.apiKey } }
  })
  ipcMain.handle('profiles:delete', (_event, id) => {
    if (id === DEEPSEEK_PROFILE_ID) return { success: false, error: 'DeepSeek 基础配置不可删除' }
    if (state.settings.modelProfiles.length <= 1) return { success: false, error: '至少保留一套模型配置' }
    state.settings.modelProfiles = state.settings.modelProfiles.filter((p) => p.id !== id)
    if (state.settings.activeProfileId === id) state.settings.activeProfileId = DEEPSEEK_PROFILE_ID
    saveSettings()
    return { success: true, activeProfileId: state.settings.activeProfileId }
  })
  ipcMain.handle('profiles:setActive', (_event, id) => {
    if (!state.settings.modelProfiles.some((p) => p.id === id)) return { success: false, error: '模型配置不存在' }
    state.settings.activeProfileId = id
    const profile = getActiveProfile(id)
    state.settings.apiKey = profile.apiKey
    state.settings.baseUrl = profile.baseUrl
    state.settings.model = profile.model
    state.settings.contextWindow = profile.contextWindow
    saveSettings()
    return { success: true, activeProfileId: id }
  })
  ipcMain.handle('profiles:test', async (_event, id, patch = {}) => {
    const profile = getActiveProfile(id)
    const key = patch.apiKey || profile.apiKey
    const baseUrl = (patch.baseUrl || profile.baseUrl || DEFAULT_BASE_URL).trim()
    const model = (patch.model || profile.model || DEFAULT_MODEL_ID).trim()
    if (!key) return { success: false, error: 'API Key 未配置' }
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000)
      const response = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'x-opencode-session': crypto.randomUUID() }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }), signal: controller.signal })
      clearTimeout(timeout)
      if (!response.ok) return { success: false, error: `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}` }
      return { success: true, model }
    } catch (e) {
      return { success: false, error: e.name === 'AbortError' ? '连接超时' : e.message }
    }
  })

  ipcMain.handle('settings:get', () => {
    return sanitizeSettings()
  })

  ipcMain.handle('settings:getFull', () => {
    const active = getActiveProfile()
    return {
      apiKey: active.apiKey || '',
      model: active.model,
      baseUrl: active.baseUrl,
      contextWindow: active.contextWindow,
      activeProfileId: state.settings.activeProfileId,
      themeName: state.settings.themeName || 'light',
    customTheme: /^#[0-9a-fA-F]{6}$/.test(state.settings.customTheme || '') ? state.settings.customTheme : null,
    fontScale: typeof state.settings.fontScale === 'number' ? state.settings.fontScale : 1,
      skillsDir: state.settings.skillsDir || '',
      memoryDir: state.settings.memoryDir || '',
      allowedDirs: Array.isArray(state.settings.allowedDirs) ? [...state.settings.allowedDirs] : [],
      autoExecute: !!state.settings.autoExecute,
      notifyOnTaskEnd: state.settings.notifyOnTaskEnd !== false,
      role: HARNESS_ROLES.includes(state.settings.role) ? state.settings.role : 'general',
    }
  })

  ipcMain.handle('settings:set', (_event, newSettings) => {
    const { apiKey, ...rest } = newSettings
    const active = getActiveProfile()
    if (apiKey) active.apiKey = apiKey
    if (rest.model) active.model = rest.model
    if (typeof rest.baseUrl === 'string') active.baseUrl = rest.baseUrl.trim() || DEFAULT_BASE_URL
    if (typeof rest.contextWindow === 'number' && rest.contextWindow >= MIN_CONTEXT_WINDOW) active.contextWindow = rest.contextWindow
    state.settings.apiKey = active.apiKey
    state.settings.model = active.model
    state.settings.baseUrl = active.baseUrl
    state.settings.contextWindow = active.contextWindow
    if (rest.themeName) state.settings.themeName = rest.themeName
    if (rest.customTheme === null || (typeof rest.customTheme === 'string' && /^#[0-9a-fA-F]{6}$/.test(rest.customTheme))) {
      state.settings.customTheme = rest.customTheme
    }
    if (typeof rest.fontScale === 'number' && [0.9, 1, 1.15, 1.3].includes(rest.fontScale)) state.settings.fontScale = rest.fontScale
    if (rest.allowedDirs) state.settings.allowedDirs = [...rest.allowedDirs]
    if (rest.skillsDir) state.settings.skillsDir = rest.skillsDir
    if (rest.memoryDir) state.settings.memoryDir = rest.memoryDir
    if (rest.autoExecute !== undefined) state.settings.autoExecute = !!rest.autoExecute
    // notifyOnTaskEnd 恒定 true：开关已从设置页撤下，这里**刻意不接**该字段
    // （旧前端 / 残留调用传来的 false 一律静默忽略），确保任务提醒不会被谁关掉。
    state.settings.notifyOnTaskEnd = true
    if (rest.role === 'general' || HARNESS_ROLES.includes(rest.role)) state.settings.role = rest.role
    saveSettings()
    console.log('[settings] saved, allowedDirs:', JSON.stringify(state.settings.allowedDirs))
    return sanitizeSettings()
  })

  // --- Test OpenAI Compatible Connection ---
  // 三个参数都用表单实时值（key / baseUrl / model），避免"改了配置但用的是旧值测试"的困惑
  ipcMain.handle('settings:testConnection', async (_event, testKey, testBaseUrl, testModel) => {
    const key = testKey || state.settings.apiKey
    const baseUrl = (testBaseUrl && testBaseUrl.trim()) || getApiBaseUrl()
    const model = (testModel && testModel.trim()) || state.settings.model || DEFAULT_MODEL_ID
    if (!key) {
      return {
        success: false,
        error: 'API Key 未配置',
        debug: { hasStoredKey: !!state.settings.apiKey, storedKeyLength: (state.settings.apiKey || '').length, storedKeyPrefix: (state.settings.apiKey || '').slice(0, 8) },
      }
    }
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000)
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'x-opencode-session': crypto.randomUUID(),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 5,
        }),
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (response.ok) {
        const data = await response.json()
        return { success: true, model: data.model, usage: data.usage }
      } else {
        const errText = await response.text().catch(() => '')
        return { success: false, error: `HTTP ${response.status}: ${errText}` }
      }
    } catch (err) {
      return { success: false, error: err.message || '连接失败' }
    }
  })

  // --- System Info & Downloads ---
  ipcMain.handle('system:getInfo', async () => {
    let nodeVersion = ''
    let pythonVersion = ''
    let gitVersion = ''

    for (const cmd of ['node', 'node.exe']) {
      try {
        const { stdout } = await execFilePromise(cmd, ['--version'])
        const v = stdout.trim()
        if (v) { nodeVersion = v; break }
      } catch {}
    }
    // Fallback: Electron's bundled Node.js (if system node not on PATH)
    if (!nodeVersion && process.version) {
      nodeVersion = `${process.version} (Electron 内置)`
    }

    // 解析可靠 Python（优先 py -3，规避 LibreOffice/WindowsApps 抢占 PATH）
    const pyExe = await resolvePython() // ['py','-3'] 或 ['C:\...\python.exe']
    try {
      const { stdout } = await execFilePromise(pyExe[0], pyExe.slice(1).concat(['--version']))
      pythonVersion = stdout.trim()
    } catch {}

    // Git: 复用统一探测（PATH + 常见安装位置）
    const gitCmd = await findGitExecutable()
    if (gitCmd) {
      try {
        const { stdout } = await execFilePromise(gitCmd, ['--version'])
        gitVersion = stdout.trim()
      } catch {}
    }

    // Excel 环境探测：skills/xlsx 依赖 Python + openpyxl/pandas(随 Python 预装) + markitdown + pycel(recalc.py --check/--bake 引擎) + soffice(LibreOffice,可选,--cache 需要)
    const excelEnv = { python: false, openpyxl: false, pandas: false, markitdown: false, pycel: false, soffice: false }
    if (pythonVersion) {
      excelEnv.python = true
      for (const pkg of ['openpyxl', 'pandas', 'markitdown', 'pycel']) {
        try {
          await execFilePromise(pyExe[0], pyExe.slice(1).concat(['-c', `import ${pkg}`]))
          excelEnv[pkg] = true
        } catch {}
      }
    }
    let sofficeFound = findLibreOfficeDir() !== null
    if (!sofficeFound) {
      // 兼容历史：老版本把 LO 加过 PATH，或用户自己配置过 soffice 命令
      try {
        await execFilePromise('where', ['soffice'])
        sofficeFound = true
      } catch {}
    }
    excelEnv.soffice = sofficeFound

    return { nodeVersion, pythonVersion, gitVersion, excelEnv }
  })

  ipcMain.handle('system:downloadNode', async (event) => {
    const version = '20.20.2'
    const url = 'https://example.com/downloads/2026/7/31/0924106a6bf93ac2ec4.msi'
    const dest = path.join(os.tmpdir(), `node-v${version}-x64.msi`)
    await downloadAndInstall(event, url, dest, 'node', `正在下载 Node.js ${version}...`)
    // Run installer with elevation (UAC prompt)
    event.sender.send('system:downloadProgress', { type: 'node', percent: 100, message: '正在安装 Node.js（请在弹出的 UAC 对话框中点击"是"）...' })
    await runElevated('msiexec.exe', ['/i', dest, '/quiet', '/norestart'])
    try { fs.unlinkSync(dest) } catch {}
    event.sender.send('system:downloadProgress', { type: 'node', percent: 100, message: 'Node.js 安装完成！' })
  })

  ipcMain.handle('system:downloadPython', async (event) => {
    const version = '3.14.5'
    const url = 'https://example.com/downloads/2026/7/31/0931326a6bfaf490017.msi'
    const dest = path.join(os.tmpdir(), `python-${version}-amd64.msi`)
    await downloadAndInstall(event, url, dest, 'python', `正在下载 Python ${version}...`)
    // Run installer with elevation (UAC prompt)
    event.sender.send('system:downloadProgress', { type: 'python', percent: 100, message: '正在安装 Python（请在弹出的 UAC 对话框中点击"是"）...' })
    await runElevated('msiexec.exe', ['/i', dest, '/quiet', '/norestart', 'InstallAllUsers=1', 'PrependPath=1'])
    try { fs.unlinkSync(dest) } catch {}
    event.sender.send('system:downloadProgress', { type: 'python', percent: 100, message: 'Python 安装完成！' })
  })

  ipcMain.handle('system:downloadGit', async (event) => {
    const version = '2.35.1.2'
    const url = 'https://example.com/downloads/2026/8/1/2214046a6dff2cb326c.exe'
    const dest = path.join(os.tmpdir(), `Git-${version}-64-bit.exe`)
    await downloadAndInstall(event, url, dest, 'git', `正在下载 Git ${version}...`)
    // Git for Windows 使用 Inno Setup，静默安装参数：/VERYSILENT /NORESTART
    event.sender.send('system:downloadProgress', { type: 'git', percent: 100, message: '正在安装 Git（请在弹出的 UAC 对话框中点击"是"）...' })
    await runElevated(dest, ['/VERYSILENT', '/NORESTART', '/SP-'])
    // 清掉 git 探测缓存，让后续知识库更新能识别到新装的 Git
    gitProbeReset()
    try { fs.unlinkSync(dest) } catch {}
    event.sender.send('system:downloadProgress', { type: 'git', percent: 100, message: 'Git 安装完成！请重启应用使其生效。' })
  })

  // Excel 环境补全：安装 Python pip 依赖（openpyxl/pandas/markitdown/pycel）
  // LibreOffice 由独立的 downloadLibreOffice handler 负责，两栏互不干扰。
  // 设计要点：
  //  - 用绝对 python 路径安装，避免 UAC 提权后 PATH 解析到别的 python 导致装错地方；
  //  - 装完真实重探测四项状态，绝不把失败静默成"完成"；
  //  - 最终通过 downloadProgress 回传 env 给前端，徽标即时翻绿，无需重启。
  ipcMain.handle('system:downloadXlsxEnv', async (event) => {
    const push = (percent, message, env) =>
      event.sender.send('system:downloadProgress', env ? { type: 'xlsx', percent, message, env } : { type: 'xlsx', percent, message })

    // 记录最后一次 pip 安装失败的原因（拿 stderr），失败时回传给前端便于排查
    let lastPipErr = ''

    // 解析可靠 Python（优先 py -3；返回 ['py','-3'] 或 ['C:\...\python.exe']）
    // 装 openpyxl/pandas/markitdown 均落到同一解释器，避免 LibreOffice/WindowsApps 抢占 PATH 导致装错地方
    const pyExe = await resolvePython()
    const pyRun = (args) => execFilePromise(pyExe[0], pyExe.slice(1).concat(args))

    // 探测四项 Python 包实际状态；stderr 收集到 lastPipErr 供失败时排错
    // 注意：soffice(LibreOffice) 不在此探测，由独立的 downloadLibreOffice handler 负责，
    // 避免"补全 Excel 环境"按钮触发 LibreOffice 检测，两栏互不干扰。
    const detect = async () => {
      const env = { openpyxl: false, pandas: false, markitdown: false, pycel: false }
      try {
        const { stderr } = await pyRun(['-c', 'import openpyxl'])
        env.openpyxl = true
      } catch (e) { lastPipErr = (e && e.stderr) || e.message || lastPipErr }
      try { await pyRun(['-c', 'import pandas']); env.pandas = true } catch (e) { lastPipErr = (e && e.stderr) || e.message || lastPipErr }
      try { await pyRun(['-c', 'import markitdown']); env.markitdown = true } catch (e) { lastPipErr = (e && e.stderr) || e.message || lastPipErr }
      try { await pyRun(['-c', 'import pycel']); env.pycel = true } catch (e) { lastPipErr = (e && e.stderr) || e.message || lastPipErr }
      return env
    }

    // 1) Python 依赖（openpyxl / pandas / markitdown）—— 任意缺失都补全
    // 注意：openpyxl/pandas 并不"必然随 Python 预装"（用户级/精简安装常缺），
    // 故统一探测并安装，不能只装 markitdown。
    // 镜像：Tuna 偶发 403，依次回退 Aliyun、官方源；升 pip 避免老 pip 对 magika 疯狂回溯。
    const PIP_INDEXES = [
      'https://pypi.tuna.tsinghua.edu.cn/simple',
      'https://mirrors.aliyun.com/pypi/simple',
      'https://pypi.org/simple',
    ]

    // 用解析到的 python + 任一镜像安装；非提权优先（用户级 Python 直接装当前解释器），失败回退 UAC 提权
    const pipInstall = async (spec, { elevated = false, extra = [] } = {}) => {
      const runner = elevated ? runElevated : execFilePromise
      const baseArgs = pyExe.slice(1).concat(['-m', 'pip', 'install', spec, ...extra])
      let lastErr
      for (const idx of PIP_INDEXES) {
        try {
          await runner(pyExe[0], baseArgs.concat(['-i', idx]))
          return true
        } catch (e) { lastErr = e }
      }
      throw lastErr
    }

    const PY_DEPS = ['openpyxl', 'pandas', 'markitdown', 'pycel']
    push(5, '正在检查 Python 依赖（openpyxl / pandas / markitdown / pycel）...')
    // 显式探测缺失列表（openpyxl / pandas / markitdown 任一缺失都需补全）
    const missingDeps = []
    for (const pkg of PY_DEPS) {
      try { await pyRun(['-c', `import ${pkg}`]); } catch { missingDeps.push(pkg) }
    }
    if (missingDeps.length > 0) {
      push(10, `正在升级 pip 并安装缺失依赖：${missingDeps.join('、')}（多镜像回退）...`)
      try {
        await pipInstall('--upgrade pip')
      } catch (e) { lastPipErr = (e && e.stderr) || e.message || lastPipErr }
      // 逐包安装：先非提权（用户级 Python 直接装），失败再 UAC 提权，仍失败回退 --user
      for (const pkg of missingDeps) {
        let ok = false
        for (const mode of [{ elevated: false }, { elevated: true }, { elevated: true, extra: ['--user'] }]) {
          try { await pipInstall(pkg, mode); ok = true; break } catch (e) { lastPipErr = (e && e.stderr) || e.message || lastPipErr }
        }
        if (!ok) push(35, `⚠ ${pkg} 安装未成功，稍后将重试。`)
      }
      // 安装后真实重探测，确认是否补齐
      const recheck = await detect()
      const stillMissing = PY_DEPS.filter((p) => !recheck[p])
      if (stillMissing.length > 0) {
        push(45, `以下依赖仍未就绪：${stillMissing.join('、')}，将再尝试一次提权安装...`)
        for (const pkg of stillMissing) {
          for (const mode of [{ elevated: true }, { elevated: true, extra: ['--user'] }]) {
            try { await pipInstall(pkg, mode); break } catch (e) { lastPipErr = (e && e.stderr) || e.message || lastPipErr }
          }
        }
      }
    } else {
      push(45, 'Python 依赖（openpyxl / pandas / markitdown）均已安装，跳过。')
    }

    // 2) 真实重探测，回传实际状态（不假报"完成"）
    const finalEnv = await detect()
    const missing = Object.entries(finalEnv).filter(([, v]) => !v).map(([k]) => k)
    const hints = []
    if (missing.length > 0) hints.push(`请检查本机 Python 与网络（或手动 pip install ${missing.join(' ')}）`)
    let msg = missing.length === 0
      ? 'Excel 环境补全完成！可立即使用。'
      : `部分未安装成功：${missing.join('、')} 缺失（${hints.join('；')}）。`
    // 附有 pip 真实报错时一并透出，便于定位（如网络/外网限制/代理）
    if (missing.length > 0 && lastPipErr) {
      const tail = String(lastPipErr).trim().split('\n').slice(-3).join(' | ')
      msg += ` 最近 pip 报错：${tail.slice(0, 200)}`
    }
    push(100, msg, finalEnv)
  })

  // LibreOffice 独立安装 handler
  ipcMain.handle('system:downloadLibreOffice', async (event) => {
    const push = (percent, message, env) =>
      event.sender.send('system:downloadProgress', env ? { type: 'libreoffice', percent, message, env } : { type: 'libreoffice', percent, message })

    // 检测 LibreOffice 是否已安装（绝对路径探测，不再依赖/写入 PATH）
    let loDir = findLibreOfficeDir()
    if (loDir) {
      push(100, 'LibreOffice 已安装，跳过。', { soffice: true })
      return
    }

    // 安装 LibreOffice
    push(10, '正在通过 winget 安装 LibreOffice（体积较大，请耐心等待并在 UAC 弹窗点击"是"）...')
    try {
      // --override 透传 MSI 属性 REGISTER_NO_MSO_TYPES=1：安装后不注册任何 Microsoft Office 文件类型，
      // 避免静默安装抢走 .docx/.xlsx/.pptx 等默认打开程序。
      // 注意：安装后【不写入系统 PATH】——LO 自带的 python.exe 会污染裸 `python`，
      // recalc.py 已改为按绝对路径找 soffice.exe（office/soffice.py find_soffice）。
      await runElevated('winget', [
        'install', '--id', 'TheDocumentFoundation.LibreOffice',
        '--silent', '--accept-package-agreements', '--accept-source-agreements', '--scope', 'machine',
        '--override', 'REGISTER_NO_MSO_TYPES=1',
      ])
    } catch {}
    loDir = findLibreOfficeDir()

    // 返回最终状态
    const finalSoffice = loDir !== null
    const msg = finalSoffice ? 'LibreOffice 安装完成！' : 'LibreOffice 安装未成功，请检查网络或手动安装。'
    push(100, msg, { soffice: finalSoffice })
  })
}

module.exports = {
  APP_NAME,
  DEFAULT_BASE_URL,
  DEEPSEEK_PROFILE_ID,
  DEFAULT_DEEPSEEK_PROFILE,
  DEFAULT_SKILLS_DIR,
  DEFAULT_MEMORY_DIR,
  BUILTIN_SKILLS_DIR,
  HARNESS_ROOT,
  HARNESS_SKILLS_DIR,
  HARNESS_QA_SKILLS_DIR,
  HARNESS_EXCEL_SKILLS_DIR,
  HARNESS_LEGAL_SKILLS_DIR,
  HARNESS_DEV_SKILLS_DIR,
  HARNESS_CONVENTIONS_DIR,
  HARNESS_ROLES,
  MAX_CONSECUTIVE_ASKS,
  DEFAULT_MODEL_ID,
  MIN_CONTEXT_WINDOW,
  MODEL_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  ensureDir,
  getCodeRepoDir,
  getProductOutputDir,
  getTestOutputDir,
  getExcelOutputDir,
  getLegalOutputDir,
  getBrowserDownloadsDir,
  getCommandOutputDir,
  findGitExecutable,
  getSettingsPath,
  normalizeProfiles,
  getActiveProfile,
  loadSettings,
  saveSettings,
  getApiBaseUrl,
  resolvePlaceholders,
  buildSystemPrompt,
  buildSubAgentContext,
  registerIpc,
}