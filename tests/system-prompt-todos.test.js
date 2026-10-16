// 【任务清单】公共提示词段的回归测试（2026-09-30 update_todos 放开给全角色时补）。
//
// 为什么需要这个文件：工具能不能用是两件事 —— ① `chat.js` 下不下发（由
// tests/update-todos-inject.test.js 锁）；② 模型知不知道**什么时候该用**（由本文件锁）。
// 纪律刻意写在 settings.js 的公共段（对全角色生效），而不是各角色的 harness 提示词里 ——
// 否则一放开就得改 6 份提示词，且同一规则维护多份必然漂移。
//
// 这里直接 stub electron 后 require 真实的 settings.js，跑 buildSystemPrompt()，
// 逐个角色断言。stub 要够全，少一个字段就在 require 阶段炸（技能 §9 的坑）。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const PROJ = path.join(__dirname, '..')

const electronStub = {
  app: {
    getPath: () => path.join(require('node:os').tmpdir(), 'localai-prompt-test'),
    getName: () => 'local-ai',
    getVersion: () => '0.0.0',
    on: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
    isPackaged: false,
  },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showMessageBox: async () => ({ response: 0 }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', openExternal: async () => '' },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  nativeTheme: { on: () => {}, shouldUseDarkColors: true },
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  return origLoad.apply(this, arguments)
}

const state = require(path.join(PROJ, 'electron/state.js'))
const settings = require(path.join(PROJ, 'electron/settings.js'))

// 已知的运行期占位符：由 chat.js 每次请求才替换，直调 buildSystemPrompt 看到字面量是正常的。
// ⚠️ 这个排除集不许随意扩张 —— 加进来等于给自己的断言开后门（技能 §9）。
const KNOWN_PLACEHOLDERS = new Set(['EXCEL_WORK_DIR', 'PM_REPO_DIR', 'QA_REPO_DIR'])

function leftoverPlaceholders(text) {
  const hits = new Set()
  for (const m of text.matchAll(/\{\{([A-Z_]+)\}\}/g)) {
    if (KNOWN_PLACEHOLDERS.has(m[1])) continue
    hits.add(m[1])
  }
  return [...hits]
}

function promptFor(role) {
  state.settings = {
    allowedDirs: ['C:/Users/syf/Desktop/mes/localAi'],
    skillsDir: path.join(PROJ, 'skills'),
    memoryDir: path.join(require('node:os').tmpdir(), 'localai-memory'),
    role,
  }
  return settings.buildSystemPrompt(state.settings.allowedDirs, ['帮我处理一个多步任务'])
}

const ALL_ROLES = ['general', 'product', 'qa', 'excel', 'legal', 'dev']

test('【任务清单】公共段对所有角色注入（含通用角色）', () => {
  for (const role of ALL_ROLES) {
    const prompt = promptFor(role)
    assert.ok(prompt.includes('【任务清单'), `${role} 角色缺少【任务清单】公共段`)
    assert.ok(prompt.includes('update_todos'), `${role} 角色的公共段必须点名 update_todos 工具`)
  }
})

test('公共段交代了「什么时候用」与「每轮回显」两个关键点', () => {
  const prompt = promptFor('general')
  assert.match(prompt, /3 步以上/, '必须给出触发条件，否则模型不会用')
  assert.match(prompt, /回显/, '必须说明清单会每轮回显 —— 这是「不用靠记忆」的依据')
  assert.match(prompt, /调用节奏|不要重复调用/, '必须给出调用节奏，否则会被判成重复调用拦下')
})

test('公共段与工具说明不重复维护同一份规则（指向工具说明）', () => {
  const prompt = promptFor('general')
  assert.match(prompt, /见 update_todos 的工具说明/, '细节应指向工具说明，避免两处漂移')
})

test('dev 自己的提示词不再重复长篇规则，只保留与本角色相关的部分', () => {
  const prompt = promptFor('dev')
  assert.match(prompt, /【任务清单】段/, 'dev 提示词应引用公共段而不是自己再写一遍')
  // 具体规则只应出现在公共段里一次
  const occurrences = prompt.split('同时只允许一项').length - 1
  assert.ok(occurrences <= 1, `「同时只允许一项」这类细则不该在提示词里出现多次（实际 ${occurrences} 次）`)
})

test('所有角色的提示词都没有残留占位符', () => {
  for (const role of ALL_ROLES) {
    const left = leftoverPlaceholders(promptFor(role))
    assert.deepEqual(left, [], `${role} 角色提示词里有未解析占位符：${left.join(', ')}`)
  }
})

test('公共段与 dev 提示词都不得要求「做完后清空清单」（回归：曾导致面板收尾时消失）', () => {
  // 禁用措辞本身**一个字都不能出现在提示词里** —— 否则模型可能反过来照做
  // （第一版就踩过：公共段里为了"提示后人"写了"完整版历史写成过…"，那段 meta 文本
  //  反倒把禁用措辞又送进了每轮注入的提示词）。
  // ⚠️ 只挑**无歧义**的禁用措辞：不能写成 /做完后清空/ —— 它会匹配到禁令本身
  //    "**不要**在做完后清空清单"，断言必然假 FAIL（本次实测踩过）。
  const bad = [/全部做完后清空/, /完成后清空一次/, /清空一次/, /收尾时清空/]
  for (const role of ALL_ROLES) {
    const prompt = promptFor(role)
    for (const re of bad) {
      assert.doesNotMatch(prompt, re, `${role} 角色提示词里出现了强制清空指令：${re}`)
    }
  }
  const dev = promptFor('dev')
  assert.match(dev, /做完不要清空清单/, 'dev 提示词必须显式禁止收尾清空')
  assert.match(dev, /不要在做完后清空清单/, '公共段必须显式禁止收尾清空')
})

test('角色隔离仍然成立：general 不含 dev 专属技能，dev 不含 pm-* 技能', () => {
  const gen = promptFor('general')
  assert.equal(gen.includes('dev-code-change'), false, 'general 不该看到 dev 的技能清单')
  const devPrompt = promptFor('dev')
  assert.equal(devPrompt.includes('pm-code-align'), false, 'dev 不该看到产品角色技能')
  assert.ok(devPrompt.includes('dev-code-change'), 'dev 必须看到自己的技能')
})

// ============================================================
//  回归：角色提示词里的「工具列举」是一份隐式白名单
//  2026-09-30 实测：excel 角色的【可用工具】段列了 5 类工具却没写 update_todos，
//  于是该角色永远不出任务清单 —— 模型认为"不在我工具列表里的工具=我没有"。
//  这类漏改不会有任何报错，只能靠断言兜住。
// ============================================================

test('凡角色提示词里枚举了工具，就必须含 update_todos', () => {
  const enumerating = []
  for (const role of ALL_ROLES) {
    const prompt = promptFor(role)
    if (!prompt.includes('## 可用工具')) continue
    enumerating.push(role)
    assert.ok(
      prompt.includes('update_todos'),
      `${role} 角色的【可用工具】段枚举了工具却没写 update_todos —— 模型会认为它没有这个工具`
    )
  }
  // 断言不能空转：至少得有一个角色真的枚举了工具（否则这条测试等于没测）
  assert.ok(enumerating.length > 0, '没有任何角色枚举工具，本断言失去意义，请检查探测方式')
  assert.ok(enumerating.includes('excel'), 'excel 角色枚举工具（本次回归的起因），必须被覆盖到')
})

test('excel 角色：提示词把「固定工作流」与「本次任务清单」区分开（回归）', () => {
  const prompt = promptFor('excel')
  // 关键：固定 6 步流程 ≠ 本次任务的步骤，否则模型认为"计划已给定"而不建清单
  assert.match(prompt, /本次任务|本次步骤/, '必须点明清单记的是「本次任务」的步骤')
  assert.match(prompt, /update_todos/)
  assert.match(prompt, /固定/, '要说明固定工作流与本次清单是两件事')
})

// ============================================================
//  回归：看图能力段（多模态）必须与「工具是否下发」同源
//  2026-10-05 新增：材料（提示词）说"你能看图 / 用 browser_read_images"，
//  而 chat.js 没下发那个工具（配置没勾「支持读图」）→ 模型会反复尝试调用不存在的工具、
//  白烧往返；反过来勾了却不说，模型压根不会去取图（材料里此前「图片/视觉/多模态」零命中）。
// ============================================================
const visionOn = (role = 'general') => {
  state.settings = {
    allowedDirs: ['C:/workspace/localAi'],
    skillsDir: path.join(PROJ, 'skills'),
    memoryDir: path.join(require('node:os').tmpdir(), 'localai-memory'),
    role,
    modelProfiles: [{ id: 'deepseek-default', vision: true }],
    activeProfileId: 'deepseek-default',
  }
  return settings.buildSystemPrompt(state.settings.allowedDirs, ['看看这个页面 https://demo.local/list'])
}

test('vision 开启：提示词显式声明「你能看图」，并给出取网页图片的动作链', () => {
  const prompt = visionOn('general')
  assert.match(prompt, /【看图能力/, '必须整段声明看图能力，否则模型会自称"我无法查看图片"')
  assert.match(prompt, /browser_read_images/, '必须点名取图工具')
  assert.match(prompt, /browser_open/, '必须给出「先打开页面再取图」的先后顺序')
  assert.match(prompt, /当轮/, '必须说明图片只当轮有效（后续轮次要重新取），否则模型会以为图一直在历史里')
  // 开启后不能再声称"你无法看图"（那是 browser_screenshot 的旧文案，会自相矛盾）
  assert.doesNotMatch(prompt, /你无法看图/, 'vision 开启后不得再出现「你无法看图」')
})

test('vision 关门时看/取图工具一律不得出现，且截图文案仍是"看不到"', () => {
  const prompt = promptFor('general')   // promptFor 不传 profile → 回落到激活配置（未勾选）
  assert.equal(prompt.includes('browser_read_images'), false, '没勾「支持读图」时不得出现取图工具')
  assert.equal(prompt.includes('read_image'), false, '没勾时 read_image 也没下发，材料里不能提它')
  assert.equal(prompt.includes('【看图能力'), false, '没勾时不该声称能看图')
  assert.match(prompt, /browser_screenshot 默认被禁用/)
})

// 回归（2026-10-05 真实事故）：用户给了一张 UI 截图，模型看不到图，于是跑了 10 次 execute_command
// 用 Windows.Media.Ocr 抠文字 —— 用户看到的是"它说自己没有视觉通道"，也不知道怎么把能力打开。
// 所以 vision 关闭时必须注入**行为纪律**：如实说明 + 给可执行下一步 + 禁止 OCR 绕路。
test('vision 关闭时注入「不支持读图」的纪律：禁止 OCR 绕路 + 指向设置页', () => {
  for (const role of ['general', 'dev']) {
    const prompt = promptFor(role)
    assert.match(prompt, /当前配置不支持读图/, `${role}：必须明确告知收不到图片（否则它会去折腾 OCR）`)
    assert.match(prompt, /不要用 OCR/, `${role}：必须禁止 OCR / 像素推断这类假装读图的绕路`)
    assert.match(prompt, /设置 → 模型配置/, `${role}：必须给出可执行的下一步（去哪开启），而不是一句"我看不到"`)
    assert.match(prompt, /支持读图（多模态）/, `${role}：要点名那个开关`)
  }
})

test('vision 开启 + dev 角色：正常注入看图段，但只能提 read_image（dev 没有任何 browser_*）', () => {
  const prompt = visionOn('dev')
  assert.match(prompt, /【看图能力/, 'dev 也要能看图（read_image），段必须注入')
  assert.match(prompt, /read_image/, '必须点名 read_image')
  assert.equal(prompt.includes('browser_read_images'), false, 'dev 不下发 browser_* 工具，材料里就不能提它')
})

test('vision 开启 + 通用角色：三条取图路径都在（本机文件 / 图片直链 / 网页）', () => {
  const prompt = visionOn('general')
  assert.match(prompt, /read_image/, '本机图片文件走 read_image')
  assert.match(prompt, /browser_read_images/, '网页里的图走 browser_read_images')
  assert.match(prompt, /https 图片直链|附件/, '要说明"用户贴的图已经在消息里了"')
  assert.match(prompt, /不要用 read_file 读图片/, '必须明说不要用 read_file 读图（会吐乱码）')
})
