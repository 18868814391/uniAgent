// execute_command 输出落盘目录的白名单放行 —— 回归测试（2026-10-04）
//
// 背景：execute_command 超长输出时只在返回值里给「头尾各 8KB + 一个 stdoutPath」，
// 并让模型去那个文件里 grep 完整日志。但 read_file / grep_code 都走 fs-safe 的 isPathAllowed，
// 而 userData/tool-output **不在**用户的授权目录里 —— 只有 dev 角色会无条件放行。
// 于是对「产品 / Excel / 法务 / 通用」这些角色，「去 stdoutPath 捞报错」是一句空头支票：
// 模型拿到路径却收到 Access denied，只能重跑命令（正是我们想避免的）。
//
// 修法：settings.js 新增 getCommandOutputDir()，并加进 isPathAllowed 的 autoAllowed
// （与 browser-downloads / excel-output 同款处理）。
//
// 本文件锁住两条：
//   1) 非 dev 角色能读到 tool-output 目录里的文件（配套项真的生效）
//   2) 没有因此开出别的洞：授权目录之外的文件仍然 Read / Access denied
//
// fs-safe.js 加载时 require('electron')，故用桩模块顶掉依赖。
// ⚠️ 本文件用非 dev 角色，isPathAllowed 会真正走完整逻辑 → getRoleRepoRoot() 也会被调到，
//    必须连 '../repodirs' 一起桩掉（否则它会去调 app.getPath 而爆栈）。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const FS_SAFE = path.join(__dirname, '..', 'electron', 'tools', 'fs-safe.js')

function stub(request, exports) {
  const id = require.resolve(request, { paths: [path.dirname(FS_SAFE)] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

// 一个"假的 userData"：tool-output 就落在它下面
const FAKE_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-userdata-'))
const TOOL_OUTPUT = path.join(FAKE_USERDATA, 'tool-output')
fs.mkdirSync(TOOL_OUTPUT, { recursive: true })

stub('electron', {
  ipcMain: { handle() {} },
  dialog: {},
  BrowserWindow: class {},
  nativeImage: {},
  shell: {},
})
// ⚠️ 关键：role 是 product（非 dev）→ isPathAllowed 不再无条件放行，真正走白名单判定
stub('../state', {
  settings: { role: 'product', allowedDirs: [], skillsDir: '', memoryDir: '' },
  attachedFilePaths: new Set(),
})
stub('../settings', {
  settings: {},
  HARNESS_ROOT: path.join(os.tmpdir(), 'localai-harness-stub'),
  resolvePlaceholders: (s) => s,
  getErpKbRoot: () => null,
  getLegalKbRoot: () => null,
  getProductOutputDir: () => null,
  getTestOutputDir: () => null,
  getExcelOutputDir: () => null,
  getLegalOutputDir: () => null,
  getBrowserDownloadsDir: () => null,
  // 被测项：落盘目录的唯一定义处
  getCommandOutputDir: () => TOOL_OUTPUT,
})
stub('../windows', { hardenWindow: () => {} })
stub('../repodirs', { getRoleRepoRoot: () => null })

const fsSafe = require(FS_SAFE)

test('非 dev 角色能读到 tool-output 里的日志（落盘路径不是空头支票）', () => {
  const log = path.join(TOOL_OUTPUT, 'build.log')
  fs.writeFileSync(log, 'progress...\nERROR: Module not found\nFINISHED WITH ERRORS\n', 'utf-8')

  // read_file 这条链（readFileWithRange → readFileSafe → isPathAllowed）
  const content = fsSafe.readFileWithRange(log, undefined, undefined)
  assert.equal(typeof content, 'string', '小日志应原样返回')
  assert.match(content, /ERROR: Module not found/, '模型必须能读到完整日志里的报错行')

  // list_directory 也要能列出该目录（模型据此确认文件确实存在）
  const listed = fsSafe.listDirSafe(TOOL_OUTPUT)
  assert.ok(listed.files.includes('build.log'), 'tool-output 目录应可列出')

  fs.rmSync(log, { force: true })
})

test('没有因此开出别的洞：白名单外的路径仍然拒绝', () => {
  const outside = path.join(FAKE_USERDATA, 'not-allowed')
  fs.mkdirSync(outside, { recursive: true })
  const f = path.join(outside, 'secret.txt')
  fs.writeFileSync(f, 'should not be readable', 'utf-8')

  assert.throws(
    () => fsSafe.readFileWithRange(f, undefined, undefined),
    /Access denied/,
    'autoAllowed 只该放行指定目录，不能顺手放行整个 userData',
  )
})
