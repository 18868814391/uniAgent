// 工作目录锚点（P0-6，2026-10-24）的回归测试 —— 真起 bash，不打桩命令执行。
//
// 要锁住的口径：
//   ① 一条命令里 cd 到某目录 → 锚点记住它，下一条命令**接着在那里执行**（不必再拼 cd）
//   ② 显式传 cwd → 这条命令在那里跑，且锚点跟着更新
//   ③ 非 dev 角色行为不变（仍从主目录起，不记锚点）—— 免得改了行为却没人验证
//   ④ 退出码语义不被"追加记录 cwd"的那两行破坏
//
// shell.js / cwd-anchor.js 都经 require('../state') 拿状态，这里用同一个桩对象，
// 于是测试能直接看到本该被回写的 state.devCwd。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SHELL = path.join(__dirname, '..', 'electron', 'tools', 'shell.js')

function stub(request, exports) {
  const id = require.resolve(request, { paths: [path.dirname(SHELL)] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

const stateStub = { settings: { role: 'dev', allowedDirs: [] }, devCwd: null }
stub('../state', stateStub)
stub('../settings', {
  settings: {},
  getCommandOutputDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'localai-shell-out-')),
})

const shell = require(SHELL)
const cwdAnchor = require(path.join(__dirname, '..', 'electron', 'cwd-anchor.js'))

const toPosix = (p) => {
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(String(p))
  return m ? `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : String(p).replace(/\\/g, '/')
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `localai-cwd-${tag}-`))
}

// Windows 上 os.tmpdir() 是 8.3 短路径（ADMINI~1），而 `pwd -P` 给的是长路径；
// Git Bash 还会把临时目录映射成 /tmp。所以**不比较路径字符串**，改用「标记文件能否看到」+
// realpath 归一化 —— 这才是"命令到底在哪个目录执行"的真实判据。
const real = (p) => {
  try {
    return fs.realpathSync.native(p).toLowerCase()
  } catch {
    try {
      return fs.realpathSync(p).toLowerCase()
    } catch {
      return path.resolve(String(p || '')).toLowerCase()
    }
  }
}
function marker(dir) {
  const name = `marker-${Math.random().toString(36).slice(2, 8)}.txt`
  fs.writeFileSync(path.join(dir, name), 'x')
  return name
}

async function run(command, opts) {
  const raw = await shell.executeCommand(command, opts)
  return JSON.parse(raw)
}

test('cd 之后，下一条命令默认就在那里执行（不用再拼 cd）', async () => {
  stateStub.settings.role = 'dev'
  stateStub.devCwd = null
  const dir = tmpDir('a')
  const m = marker(dir)

  const r1 = await run(`cd "${toPosix(dir)}" && pwd`)
  assert.equal(r1.exitCode, 0, r1.stderr || '第一条命令应当成功')
  assert.equal(real(stateStub.devCwd || ''), real(dir), '锚点应被回写')

  const r2 = await run(`ls ${m}`)
  assert.equal(r2.exitCode, 0, '第二条命令应当已经在锚点目录里（能看到 marker）')
})

test('显式 cwd：这条命令在指定目录执行，锚点跟着走', async () => {
  stateStub.settings.role = 'dev'
  stateStub.devCwd = null
  const a = tmpDir('b1')
  const b = tmpDir('b2')
  const ma = marker(a)
  const mb = marker(b)

  const r1 = await run(`ls ${ma}`, { cwd: a })
  assert.equal(r1.exitCode, 0, '应当能在 a 里看到 a 的 marker')
  const r2 = await run(`ls ${mb}`, { cwd: b })
  assert.equal(r2.exitCode, 0, '应当能在 b 里看到 b 的 marker')
  assert.equal(real(stateStub.devCwd || ''), real(b), '锚点应跟到 b')
})

test('非 dev 角色行为不变：不记锚点，命令仍从主目录起', async () => {
  stateStub.settings.role = 'qa'
  stateStub.devCwd = null
  const dir = tmpDir('c')

  await run(`cd "${toPosix(dir)}" && pwd`)
  assert.equal(stateStub.devCwd, null, '非 dev 不该记锚点')

  const r2 = await run('pwd')
  assert.equal(
    r2.stdout.trim().toLowerCase(),
    toPosix(os.homedir()).toLowerCase(),
    '非 dev 仍从主目录起（与旧行为一致）',
  )
  stateStub.settings.role = 'dev'
})

test('追加的"记录 cwd"两行不改变退出码语义', async () => {
  stateStub.settings.role = 'dev'
  stateStub.devCwd = null
  const r = await run('exit 7')
  assert.equal(r.exitCode, 7, `退出码应原样透传，实际 ${r.exitCode}`)
})

test('命令失败也不会污染锚点判定（cd 成功的仍算数）', async () => {
  stateStub.settings.role = 'dev'
  stateStub.devCwd = null
  const dir = tmpDir('d')
  const r = await run(`cd "${toPosix(dir)}" && ls definitely-not-exist-xyz`)
  assert.notEqual(r.exitCode, 0, '命令本身应当失败')
  assert.equal(real(stateStub.devCwd || ''), real(dir))
})

test('cwdAnchor.peek()：非 dev 返回 null（检索默认目录不会被带偏）', () => {
  stateStub.settings.role = 'dev'
  stateStub.devCwd = 'D:\\proj'
  assert.equal(cwdAnchor.peek(), 'D:\\proj')
  stateStub.settings.role = 'qa'
  assert.equal(cwdAnchor.peek(), null)
  stateStub.settings.role = 'dev'
  cwdAnchor.reset()
  assert.equal(cwdAnchor.peek(), null)
})
