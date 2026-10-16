// ============================================================
//  tools/skills —— 技能读取（多目录合并 + harness 角色技能库）
//  内置技能库、用户技能目录、角色技能库依次合并去重。
//  注意:与既有行为保持一致,列表/读取仍以 DEFAULT_SKILLS_DIR 为主
//  （写入 write_skill 走 state.settings.skillsDir）。
//
//  2026-09-29 参照 opencode（packages/core/src/skill/guidance.ts + tool/skill.ts）补两件事：
//   ① buildSkillIndexSection()：把可用技能的 name + description 注入系统提示词，
//      让模型知道「有哪些技能、什么时候该调」——此前只靠提示词里硬编码的几个技能名。
//   ② readSkillByName() 返回 baseDir + 目录文件清单：技能正文里的相对路径
//      （如 scripts/xxx.py、reference/yyy.md）才有参照，否则模型不知道相对哪儿。
// ============================================================
const path = require('path')
const fs = require('fs')
const state = require('../state')
const {
  DEFAULT_SKILLS_DIR,
  BUILTIN_SKILLS_DIR,
  ensureDir,
  resolvePlaceholders,
} = require('../settings')

// 角色技能库路径（开源版在本地自算，避免与 settings.js 形成循环依赖）
const HARNESS_SKILLS_DIR = path.join(__dirname, '..', '..', 'harness', 'skills')
const HARNESS_QA_SKILLS_DIR = path.join(__dirname, '..', '..', 'harness', 'skills-qa')
const HARNESS_EXCEL_SKILLS_DIR = path.join(__dirname, '..', '..', 'harness', 'skills-excel')
const HARNESS_LEGAL_SKILLS_DIR = path.join(__dirname, '..', '..', 'harness', 'skills-legal')
const HARNESS_DEV_SKILLS_DIR = path.join(__dirname, '..', '..', 'harness', 'skills-dev')

// 技能附带文件清单的条数上限（对齐 opencode 的 FILE_LIMIT）
const SKILL_FILE_LIMIT = 10
// 可用于注入提示词的最大技能数：技能库很大时只取前 N 个，避免提示词被撑爆
const MAX_INDEX_SKILLS = 60
// 注入时单条描述的字符上限。内置技能的描述多是长英文句（有的 200+ 字符），
// 全量注入会把提示词撑到 8K 字符；截断后仍足够判断「该不该用这个技能」。
const MAX_INDEX_DESC = 100

/**
 * 按当前角色算出技能目录列表（顺序 = 优先级）：
 * 用户目录 → 内置库 → 角色技能库。集中一处，避免列表/读取/注入三处各写一遍。
 */
function getSkillDirs() {
  const dirs = [DEFAULT_SKILLS_DIR]
  // Also check the built-in skills directory (bundled with the app)
  if (fs.existsSync(BUILTIN_SKILLS_DIR)) {
    dirs.push(BUILTIN_SKILLS_DIR)
  }
  // 开源版：无角色概念 —— 所有场景技能库对默认助手**全部可见**，
  // 由系统提示词的「场景调度」段引导它按用户意图 read_skill 加载对应技能。
  for (const d of [HARNESS_SKILLS_DIR, HARNESS_QA_SKILLS_DIR, HARNESS_EXCEL_SKILLS_DIR, HARNESS_LEGAL_SKILLS_DIR, HARNESS_DEV_SKILLS_DIR]) {
    if (fs.existsSync(d)) dirs.push(d)
  }
  return dirs
}

/**
 * 枚举每个技能目录下的技能条目。
 * 两种形态都支持：扁平 `<name>.md` 与目录式 `<name>/SKILL.md`。
 * 返回 { name, baseDir, skillFile }，baseDir = 技能正文所在目录（相对路径的参照点）。
 */
function enumerateSkills(dir) {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      // Flat .md file (e.g. code2prd.md)
      out.push({ name: entry.name.replace(/\.md$/, ''), baseDir: dir, skillFile: path.join(dir, entry.name) })
    } else if (entry.isDirectory()) {
      // Directory containing SKILL.md (e.g. frontend-design/SKILL.md)
      const skillMd = path.join(dir, entry.name, 'SKILL.md')
      if (fs.existsSync(skillMd)) {
        out.push({ name: entry.name, baseDir: path.join(dir, entry.name), skillFile: skillMd })
      }
    }
  }
  return out
}

/** 解析 SKILL.md 的 YAML frontmatter，取 name / description。只认单行标量，够用。 */
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end === -1) return {}
  const head = text.slice(3, end)
  const out = {}
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (!m) continue
    let value = m[2].trim()
    // 去掉包裹引号（技能描述里常带中文冒号，YAML 里通常已加引号）
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[m[1]] = value
  }
  return out
}

/** 取技能的 description（优先 frontmatter，读不到就退回正文首个非标题行）。 */
function skillDescription(skillFile) {
  try {
    const text = fs.readFileSync(skillFile, 'utf-8')
    const fm = parseFrontmatter(text)
    if (fm.description) return fm.description
    // 没有 frontmatter 时，退而取正文里第一段有实质内容的行
    const body = text.replace(/^---[\s\S]*?\n---/, '')
    for (const raw of body.split('\n')) {
      const line = raw.replace(/^#+\s*/, '').trim()
      if (line && !line.startsWith('|') && line.length > 4) return line.slice(0, 160)
    }
  } catch {
    // 读失败就当没有描述，不影响技能可用性
  }
  return ''
}

/** 技能详情缓存：key = skillFile，value = { mtimeMs, description }。 */
const descriptionCache = new Map()

function skillDescriptionCached(skillFile) {
  try {
    const st = fs.statSync(skillFile)
    const cached = descriptionCache.get(skillFile)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.description
    const description = skillDescription(skillFile)
    descriptionCache.set(skillFile, { mtimeMs: st.mtimeMs, description })
    return description
  } catch {
    return ''
  }
}

/**
 * 取「可直接交给模型」的描述：先过 resolvePlaceholders。
 * 2026-09-30 修：角色技能（pm-* / qa-*）的 description 里写着 {{CODE_REPO_DIR}} / {{CODE_REPO_DIR}}，
 * 而本模块的索引注入与 list_skills 都是**原样拼接**描述 —— 于是模型在提示词里看到的是字面量
 * {{CODE_REPO_DIR}}，照着去 read_file 必然报「文件不存在」，白烧一轮。
 * ⚠️ 替换必须发生在**消费端**，不能塞进 descriptionCache：占位符的值依赖**当前角色**
 * （PM_REPO_DIR / QA_REPO_DIR 随 role 变）与设置页授权目录（各 *OUTPUT_DIR），
 * 把替换结果按 mtime 缓存起来，切角色后仍会命中旧路径（缓存串味）。
 */
function skillDescriptionForModel(skillFile) {
  const raw = skillDescriptionCached(skillFile)
  return raw ? resolvePlaceholders(raw) : raw
}

/** 列出当前角色全部可见技能（去重，先出现的目录优先）。 */
function listSkillEntries() {
  ensureDir(DEFAULT_SKILLS_DIR)
  const seen = new Set()
  const out = []
  const harnessDirs = new Set([HARNESS_SKILLS_DIR, HARNESS_QA_SKILLS_DIR, HARNESS_EXCEL_SKILLS_DIR, HARNESS_LEGAL_SKILLS_DIR, HARNESS_DEV_SKILLS_DIR])
  for (const dir of getSkillDirs()) {
    // 标记来源，供注入时按相关性排序：角色专属技能 > 用户技能 > 内置通用技能
    const source = harnessDirs.has(dir) ? 'role' : dir === BUILTIN_SKILLS_DIR ? 'builtin' : 'user'
    for (const skill of enumerateSkills(dir)) {
      if (seen.has(skill.name)) continue
      seen.add(skill.name)
      out.push({ ...skill, source })
    }
  }
  return out
}

function listAllSkills() {
  const entries = listSkillEntries()
  // files 保持纯名称数组（既有调用方与模型都按这个读，不要改成对象数组）
  return {
    files: entries.map((e) => e.name).sort(),
    // skills 是带描述的明细，供模型判断「该不该用」；read_skill 仍按 name 取
    skills: entries
      .map((e) => ({ name: e.name, description: skillDescriptionForModel(e.skillFile) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .filter((s) => s.description),
  }
}

// 技能附带文件清单里要跳过的噪音目录/文件：
// __pycache__ / .pyc 是编译缓存，node_modules 是依赖，都不该占据本就有限的清单名额。
// （实测：xlsx 技能的清单曾被 .xsd schema 与 __pycache__ 占满，真正的 xl_clean.py 反被挤掉）
const SKILL_FILE_SKIP = new Set(['__pycache__', 'node_modules', '.git', '.DS_Store', 'package-lock.json', 'yarn.lock'])

/** 列出技能目录内的附带文件（脚本/参考资料），供模型按相对路径引用。 */
function listSkillFiles(baseDir) {
  try {
    const out = []
    const walk = (dir, prefix) => {
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (SKILL_FILE_SKIP.has(entry.name)) continue
        if (entry.name.endsWith('.pyc')) continue
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel)
        } else if (entry.name !== 'SKILL.md' || prefix) {
          out.push(rel)
        }
      }
    }
    walk(baseDir, '')
    // 排序：**浅层优先**，同层再按字典序。
    // 技能正文里引用的都是 `scripts/xl_clean.py` 这种浅层路径，
    // 若纯按字典序，`scripts/office/schemas/.../xxx.xsd` 这类深层文件会把它们全挤掉。
    return out
      .sort((a, b) => {
        const da = a.split('/').length
        const db = b.split('/').length
        return da !== db ? da - db : a.localeCompare(b)
      })
      .slice(0, SKILL_FILE_LIMIT)
  } catch {
    return []
  }
}

function readSkillByName(name) {
  const skillName = String(name || '').replace(/\.md$/, '')
  const dirs = getSkillDirs()
  for (const dir of dirs) {
    // Try flat file: skillname.md
    const flatPath = path.join(dir, skillName + '.md')
    if (fs.existsSync(flatPath)) {
      return shapeResult(skillName, dir, flatPath)
    }
    // Try directory/SKILL.md
    const baseDir = path.join(dir, skillName)
    const dirPath = path.join(baseDir, 'SKILL.md')
    if (fs.existsSync(dirPath)) {
      return shapeResult(skillName, baseDir, dirPath)
    }
  }
  throw new Error(`Skill not found: "${skillName}"`)
}

/**
 * 统一技能返回格式。baseDir 是关键新增：技能正文里的 `scripts/x.py`
 * 这类相对路径，模型要靠它拼出可用绝对路径。
 * 扁平 .md 技能通常直接躺在共有目录里（如 skills/ 根下几十个 .md），
 * 列该目录的文件只会是噪音，故只对目录式技能（有独立 baseDir）给清单。
 */
function shapeResult(skillName, baseDir, skillFile) {
  const content = resolvePlaceholders(fs.readFileSync(skillFile, 'utf-8'))
  const isDirectoryStyle = path.basename(skillFile) === 'SKILL.md'
  const result = { name: skillName + '.md', baseDir, content }
  if (isDirectoryStyle) {
    const files = listSkillFiles(baseDir)
    if (files.length) result.files = files
  }
  return result
}

/**
 * 把可用技能渲染成注入系统提示词的一段（对齐 opencode 的 <available_skills>）。
 * 只给 name + description，正文仍由 read_skill 按需加载 —— 这就是「渐进式披露」：
 * 常驻上下文只花几十 token/技能，而不是把每个 SKILL.md 全文塞进去。
 *
 * 排序：角色专属技能（dev-* / pm-* / xl-* …）> 用户技能 > 内置通用技能 ——
 * 角色技能与当前任务最相关，必须让它排在前面不被 MAX_INDEX_SKILLS 截掉。
 * 无技能或全无描述时返回空串，调用方跳过。
 */
function buildSkillIndexSection() {
  let entries
  try {
    entries = listSkillEntries()
  } catch {
    return ''
  }
  const rank = { role: 0, user: 1, builtin: 2 }
  const withDesc = entries
    .map((e) => ({ name: e.name, source: e.source, description: skillDescriptionForModel(e.skillFile) }))
    .filter((s) => s.description)
    .sort((a, b) => (rank[a.source] - rank[b.source]) || a.name.localeCompare(b.name))
  if (withDesc.length === 0) return ''

  const shown = withDesc.slice(0, MAX_INDEX_SKILLS)
  const lines = shown.map((s) => {
    const desc = s.description.length > MAX_INDEX_DESC
      ? s.description.slice(0, MAX_INDEX_DESC) + '…'
      : s.description
    return `- ${s.name}：${desc}`
  })
  const truncated = withDesc.length > shown.length
    ? `\n（技能较多，此处只列出前 ${shown.length} 个；其余可用 list_skills 查看完整清单）`
    : ''
  return `\n\n【可用技能清单 — 任务匹配时先用 read_skill 加载，不要自己从零写】
技能是经过验证的现成做法与参数，命中就加载，比你重新摸索更快更准：
${lines.join('\n')}${truncated}
使用方式：遇到与上面某条描述匹配的任务 → 先 read_skill('<技能名>') 拿到完整流程 → 按它执行。`
}

module.exports = { listAllSkills, readSkillByName, buildSkillIndexSection, listSkillEntries, getSkillDirs }
