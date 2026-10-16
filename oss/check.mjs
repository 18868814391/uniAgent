// ============================================================
//  oss/check —— 开源版自检（结构性检查，可安全公开）
//
//  用法：node oss/check.mjs
//
//  说明：企业版的「企业标识泄露扫描」（内网域名 / 内网 IP / 内部模块名）
//  需要写出那些**敏感字面量**才能扫描，因此它留在企业版仓库的 oss-sync/validate.mjs，
//  不随开源版发布。本脚本只做两类可公开的检查：
//   1) 结构性：确认企业专属模块确实不存在（登录 / 平台 / 知识库 / 角色仓库同步 / ERP 工具）
//   2) 占位符：{{XXX}} 必须都在白名单内（漏改的占位符会在运行时原样显示给用户）
//  如需更强的泄露扫描，请自备词表 —— 见 oss/README.md「二次开发接入点」。
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

// 1) 企业专属模块/物料：不应存在
const MUST_NOT_EXIST = [
  'electron/login.js',
  'electron/platforms.js',
  'electron/erp-kb.js',
  'electron/legal-kb.js',
  'electron/role-repos.js',
  'electron/userCheck.js',
  'electron/tools/erp.js',
  'src/components/LoginOverlay.vue',
  'src/components/RoleRepoSync.vue',
  'skills/erp-query',
  'changes.md',
  // 企业内部资料：help/ 含真实员工姓名名单与内网下载直链
  'help',
]
for (const rel of MUST_NOT_EXIST) {
  if (fs.existsSync(path.join(root, rel))) problems.push(`应已移除的企业模块仍存在：${rel}`)
}

// 2) 占位符白名单（与 electron/settings.js 的 resolvePlaceholders 保持一致）
const ALLOWED_PLACEHOLDERS = new Set([
  'CODE_REPO_DIR', 'PRODUCT_OUTPUT_DIR', 'TEST_OUTPUT_DIR', 'EXCEL_OUTPUT_DIR',
  'LEGAL_OUTPUT_DIR', 'EXCEL_WORK_DIR', 'HARNESS_ROOT', 'HARNESS_SKILLS_DIR',
  'HARNESS_QA_SKILLS_DIR', 'HARNESS_EXCEL_SKILLS_DIR', 'HARNESS_LEGAL_SKILLS_DIR',
  'HARNESS_DEV_SKILLS_DIR', 'HARNESS_CONVENTIONS_DIR', 'BUILTIN_SKILLS_DIR',
  'SKILLS_DIR', 'MEMORY_DIR', 'PYTHON_CMD',
  // 非宿主占位符：文档示例 / 第三方脚本模板
  'TOKEN', 'WORD_NS',
])

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.vue', '.ts', '.md', '.yml', '.yaml', '.html', '.css', '.txt'])
const skipDirs = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'release', 'oss'])

const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(abs)
      continue
    }
    if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue
    const rel = path.relative(root, abs).split(path.sep).join('/')
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) {
        if (!ALLOWED_PLACEHOLDERS.has(m[1])) {
          problems.push(`${rel}:${i + 1} 未知占位符 {{${m[1]}}} —— 需在 electron/settings.js 的 resolvePlaceholders 里注册`)
        }
      }
      // 已移除模块的残留引用（require 会直接让进程崩掉）
      const bad = /\brequire\(['"][^'"]*\/(login|platforms|erp-kb|legal-kb|role-repos|userCheck|erp)['"]\)/.exec(line)
      if (bad) problems.push(`${rel}:${i + 1} 仍引用已移除模块：${bad[0]}`)
    })
  }
}
walk(root)

// 3) 应用身份隔离：必须与企业版不同，否则两者不能同时安装、会共用配置目录
const IDENTITY_REQUIRED = [
  ['electron/main.js', /app\.setName\('Local AI Open'\)/, '缺少 app.setName（会与企业版共用 userData）'],
  ['electron/main.js', /app\.setPath\('userData',/, '缺少显式 setPath(userData)'],
  ['electron/main.js', /setAppUserModelId\('com\.localai\.open'\)/, 'AUMID 未隔离'],
  ['electron-builder.yml', /^appId: com\.localai\.open$/m, 'appId 未隔离'],
  ['electron-builder.yml', /^productName: Local AI Open$/m, 'productName 未隔离'],
]
for (const [rel, re, msg] of IDENTITY_REQUIRED) {
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs)) { problems.push(`身份断言：缺少文件 ${rel}`); continue }
  const text = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
  if (!re.test(text)) problems.push(`身份断言：${rel} ${msg}`)
}
for (const rel of ['electron/main.js', 'electron-builder.yml']) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8')
  if (/com\.localai\.desktop/.test(text)) problems.push(`身份断言：${rel} 仍是企业版标识 com.localai.desktop`)
}

if (problems.length) {
  console.error(`✗ 自检失败，${problems.length} 处：`)
  for (const p of problems.slice(0, 40)) console.error('  - ' + p)
  process.exit(1)
}
console.log('✓ 自检通过：企业专属模块已移除、无未知占位符、无残留 require')
