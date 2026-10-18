// 默认模型 id 回归测试
//
// 背景：`deepseek-v4-flash` 已不是官方现行名称，默认值改为 `deepseek-flash`。
// 光改常量不够——存量 settings.json 里存的仍是旧 id，normalizeProfiles 只在字段为空时才回退默认值，
// 所以必须显式迁移，否则老装机启动后仍会拿旧 id 去请求。
//
// 这里锁住四条不变量：
//   1) 默认常量 = deepseek-flash（且已被上下文窗口表登记）
//   2) 内置 DeepSeek 配置里的旧默认 id → 迁移为新 id（含只有顶层 legacy 字段的老装机）
//   3) 用户自建配置里的同名值 → 不改写（可能指向自家网关的合法别名）
//   4) 内置配置被手工改成别的模型名 → 不覆盖
//
// settings.js 是 CJS 且加载时 require('electron')，故用桩模块顶掉 electron / state / helpers，
// 使其能在纯 Node（无 Electron）下被 require。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SETTINGS = path.join(__dirname, '..', 'electron', 'settings.js')

function loadSettings(env = {}) {
  const stub = (request, exports) => {
    const id = require.resolve(request, { paths: [path.dirname(SETTINGS)] })
    require.cache[id] = { id, filename: id, loaded: true, exports }
  }
  stub('electron', {
    app: {
      getPath: () => path.join(require('node:os').tmpdir(), 'local-ai-test'),
      getName: () => 'local-ai',
      getVersion: () => '0.0.0-test',
      isPackaged: false,
    },
    ipcMain: { handle() {} },
  })
  // settings.js 加载时会调 resolvePython()（异步、失败自吞），这里给个可控实现
  stub('./helpers', {
    execFilePromise: async () => ({ stdout: '' }),
    runElevated: async () => {},
    downloadAndInstall: async () => {},
    resolvePython: async () => ['python3'],
  })
  stub('./state', { settings: {}, loginInfo: null, userResources: null })
  // 清掉 settings.js 自身缓存，让不同桩配置各自生效
  delete require.cache[require.resolve(SETTINGS)]
  return require(SETTINGS)
}

const settings = loadSettings()

test('默认模型 id 已是 deepseek-flash，且登记了上下文窗口', () => {
  assert.equal(settings.DEFAULT_MODEL_ID, 'deepseek-flash')
  assert.equal(settings.MODEL_CONTEXT_WINDOWS[settings.DEFAULT_MODEL_ID], 1024 * 1024)
})

test('存量内置配置仍是旧 id → 迁移为新 id', () => {
  const out = settings.normalizeProfiles([
    {
      id: 'deepseek-default',
      name: 'DeepSeek',
      apiKey: 'sk-legacy',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      contextWindow: 1024 * 1024,
    },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].model, 'deepseek-flash')
  assert.equal(out[0].apiKey, 'sk-legacy', '迁移不应影响其它字段')
})

test('老装机只有顶层 legacy 字段（无 modelProfiles）也要迁移', () => {
  const out = settings.normalizeProfiles(undefined, { model: 'deepseek-v4-flash' })
  const builtin = out.find((p) => p.id === 'deepseek-default')
  assert.ok(builtin, '应补出内置 DeepSeek 配置')
  assert.equal(builtin.model, 'deepseek-flash')

  // legacy 也缺失 → 落到默认 id
  const out2 = settings.normalizeProfiles(undefined, {})
  assert.equal(out2[0].model, 'deepseek-flash')
})

test('用户自建配置不被改写（可能是自家网关的合法别名）', () => {
  const out = settings.normalizeProfiles([
    { id: 'deepseek-default', name: 'DeepSeek', model: 'deepseek-flash', contextWindow: 1024 * 1024 },
    {
      id: 'profile-abc',
      name: '自建网关',
      baseUrl: 'https://my-gw.example/v1',
      model: 'deepseek-v4-flash',
      contextWindow: 1024 * 1024,
    },
  ])
  assert.equal(out.find((p) => p.id === 'profile-abc').model, 'deepseek-v4-flash')
})

test('内置配置被手工改成别的模型名 → 不覆盖用户意图', () => {
  const out = settings.normalizeProfiles([
    { id: 'deepseek-default', name: 'DeepSeek', model: 'deepseek-chat', contextWindow: 1024 * 1024 },
  ])
  assert.equal(out[0].model, 'deepseek-chat')
})

test('模型名缺失时回退到默认 id', () => {
  const out = settings.normalizeProfiles([
    { id: 'profile-empty', name: '空模型', model: '   ', contextWindow: 1024 * 1024 },
  ])
  assert.equal(out.find((p) => p.id === 'profile-empty').model, 'deepseek-flash')
})

// 2026-10：读图（多模态）默认值由 false 改为 true —— 主流模型都支持图片输入，
// 不该让用户先去设置页手动勾选。这里锁住"内置配置缺省即多模态"这一不变量。
test('内置 DeepSeek 配置默认支持读图（多模态）', () => {
  assert.equal(settings.DEFAULT_DEEPSEEK_PROFILE.vision, true)
  // 无 modelProfiles 的老装机 / 全新安装，补出的内置配置也应是多模态
  const out = settings.normalizeProfiles(undefined, {})
  const builtin = out.find((p) => p.id === 'deepseek-default')
  assert.equal(builtin.vision, true)
})

test('源码里不再残留旧默认 id 的硬编码（迁移表与注释除外）', () => {
  const src = fs.readFileSync(SETTINGS, 'utf-8')
  const hits = src
    .split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => line.includes('deepseek-v4-flash'))
    // 允许：迁移表键值、说明注释
    .filter(({ line }) => !/^\s*(\/\/|\*)/.test(line) && !/LEGACY_DEFAULT_MODELS|^\s*'deepseek-v4-flash':/.test(line))
  assert.deepEqual(hits.map((h) => `L${h.no}: ${h.line.trim()}`), [], '旧 id 只应出现在迁移表与注释中')
})
