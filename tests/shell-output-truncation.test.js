// execute_command 输出截断的回归测试 —— 2026-10-04
//
// 背景（第三轮评估实测确认的 P1）：旧实现是 `stdout.slice(0, 512KB)`，
// **既不落盘也不带任何标记**，而构建/测试的报错通常在输出尾部 ——
// 模型拿到被切掉结尾的输出，会得出「编译通过 / 测试通过」的结论。
// 这是「错误归因」（不是报错）：报错会触发它去查，沉默的错误结论不会。
//
// 顺带实测确认的两个坑（node 22，本机验证）：
//   ① execFile 一旦超出 maxBuffer，**Node 会杀掉子进程**，回调里只拿得到前 maxBuffer 个字符
//      → 尾部永久丢失。所以 maxBuffer 必须明显大于展示上限（现在是 32MB），再由我们自己裁头尾。
//   ② 超 maxBuffer 时 err.code 是字符串 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' 且 err.killed===undefined，
//      旧式 `err.code === 0 || !err.killed` 会判成 true → 一个被中途杀掉的命令报 success:true，
//      exitCode 还会是那串字符串。
//
// 本文件锁住：
//   1) shapeOutput 是纯函数：不超限原样返回；超限 → 头/尾保留 + 省略量 + 落盘完整内容
//   2) execute_command 正常小输出：success=true、exitCode 是**数字** 0、无 truncated 字段
//   3) 大输出：stdoutTruncated=true + stdoutPath 文件**内容完整**（可用 grep 捞），且 success 仍为 true
//   4) 非 0 退出码：仍算 success（口径不变），exitCode 是数字而不是字符串
//   5) 任何情况下 exitCode 都必须是数字（防回归到透传 err.code 字符串）
//
// shell.js 的 outputDir() 用 try/catch 兜底到系统临时目录，所以本文件**不需要 electron 桩**。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const shell = require(path.join(__dirname, '..', 'electron', 'tools', 'shell.js'))

// ---- 1) 纯函数：shapeOutput ----

test('shapeOutput：不超限时原样返回，不产生落盘', () => {
  const r = shell.shapeOutput('hello', 'stdout')
  assert.equal(r.text, 'hello')
  assert.equal(r.truncated, false)
  assert.equal(r.outputPath, undefined)
})

test('shapeOutput：超限时保留头尾、标出省略量、并把完整内容落盘', () => {
  const HEAD = shell.HEAD_CHARS
  const TAIL = shell.TAIL_CHARS
  // 造一段「开头可识别 + 中间大量填充 + 结尾是报错」的输出
  const head = 'HEAD-MARKER\n'
  const tail = '\nERROR: build failed at the very end'
  const total = shell.MAX_OUTPUT_CHARS * 2
  const raw = head + 'z'.repeat(total - head.length - tail.length) + tail

  const r = shell.shapeOutput(raw, 'stdout')
  assert.equal(r.truncated, true)
  assert.ok(r.text.startsWith('HEAD-MARKER'), '必须保留开头')
  assert.ok(r.text.trimEnd().endsWith(tail.trimStart()), '必须保留结尾（报错通常在尾部）')
  assert.match(r.text, /输出被截断/)
  assert.ok(r.omittedChars > 0)
  assert.equal(r.omittedChars, raw.length - HEAD - TAIL)

  // 完整内容落盘，且可被后续 grep 捞到
  assert.ok(r.outputPath, '超限时必须落盘')
  const saved = fs.readFileSync(r.outputPath, 'utf-8')
  assert.equal(saved.length, raw.length, '落盘的必须是完整输出，不是截断后的')
  assert.ok(saved.includes('ERROR: build failed at the very end'))
  assert.match(r.text, /grep_code/, '提示语要告诉模型怎么去捞，而不是重跑命令')
  fs.rmSync(r.outputPath, { force: true })
})

// ---- 2~5) 真跑进程 ----

const BASH_OK = (() => {
  try {
    const { execFileSync } = require('node:child_process')
    const p = shell.resolveShellPath()
    execFileSync(p, ['-c', 'echo ok'], { timeout: 10000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const BIG = 600 * 1024 // 600KB > 512KB 展示上限

function tmpBigFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-sh-'))
  const p = path.join(dir, 'big.txt')
  // 头尾特征串，便于验证头尾都留住了
  fs.writeFileSync(p, 'START-OF-OUTPUT\n' + 'y'.repeat(BIG) + '\nFINAL-ERROR-LINE\n', 'utf-8')
  return p
}

test('小输出：success=true、exitCode 是数字 0、不带 truncated 字段', { skip: !BASH_OK && '本机没有可用的 bash' }, async () => {
  const r = JSON.parse(await shell.executeCommand('echo hello-shell'))
  assert.equal(r.success, true)
  assert.equal(r.exitCode, 0)
  assert.equal(typeof r.exitCode, 'number')
  assert.equal(r.timedOut, false)
  assert.match(r.stdout, /hello-shell/)
  assert.equal(r.stdoutTruncated, undefined, '小输出不该有截断字段')
  assert.equal(r.stdoutPath, undefined)
})

test('大输出：保留头尾 + 落盘完整内容 + 明确标记（不再静默截断）', { skip: !BASH_OK && '本机没有可用的 bash' }, async () => {
  const big = tmpBigFile()
  const r = JSON.parse(await shell.executeCommand(`cat "${big}"`))

  assert.equal(r.stdoutTruncated, true, '必须显式标记截断')
  assert.equal(typeof r.stdoutChars, 'number')
  assert.ok(r.stdoutChars > shell.MAX_OUTPUT_CHARS, '应报告真实输出长度')
  assert.ok(r.stdoutPath, '必须给出去哪儿捞完整输出的路径')
  assert.match(r.stdout, /START-OF-OUTPUT/, '保留开头')
  assert.match(r.stdout, /FINAL-ERROR-LINE/, '保留结尾 —— 报错常常在这里')
  assert.match(r.stdout, /输出被截断/)

  // 落盘文件是完整的（这才是「不要重跑命令」的前提）
  const saved = fs.readFileSync(r.stdoutPath, 'utf-8')
  assert.ok(saved.includes('FINAL-ERROR-LINE'))
  assert.equal(saved.length, fs.statSync(big).size, '落盘内容长度应与原文件一致')

  // 命令本身成功了（cat 正常退出），success 不应因截断而变 false
  assert.equal(r.success, true)
  assert.equal(r.exitCode, 0)
  assert.equal(typeof r.exitCode, 'number')

  fs.rmSync(r.stdoutPath, { force: true })
  fs.rmSync(big, { force: true })
})

test('非 0 退出码：仍算 success（口径不变），但 exitCode 必须是数字', { skip: !BASH_OK && '本机没有可用的 bash' }, async () => {
  // bash 对不存在的命令返回 127
  const r = JSON.parse(await shell.executeCommand('this_command_does_not_exist_xyz 2>/dev/null'))
  assert.equal(typeof r.exitCode, 'number', 'exitCode 绝不能是字符串（旧版会把 err.code 原样透传）')
  assert.equal(r.exitCode, 127)
  assert.equal(r.success, true, '非 0 退出码仍算 success，交给模型读 exitCode 判断')
})

test('重定向到 stderr 的输出同样受上限保护且有落盘路径', { skip: !BASH_OK && '本机没有可用的 bash' }, async () => {
  const big = tmpBigFile()
  const r = JSON.parse(await shell.executeCommand(`cat "${big}" >&2`))
  assert.equal(r.stderrTruncated, true)
  assert.ok(r.stderrPath, 'stderr 超限也要落盘')
  const saved = fs.readFileSync(r.stderrPath, 'utf-8')
  assert.ok(saved.includes('FINAL-ERROR-LINE'))
  fs.rmSync(r.stderrPath, { force: true })
  fs.rmSync(big, { force: true })
})
