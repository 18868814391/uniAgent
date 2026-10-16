// ============================================================
//  tools/shell —— shell 命令执行（Git Bash / sh）
//  300s 超时、输出超限「头尾保留 + 完整落盘」。返回结构化 JSON 字符串供工具结果喂回模型。
//  内置子进程跟踪：记录所有 spawn 的 child.pid，超时或退出时强杀进程树。
//
//  ⚠️ 输出截断绝不能静默（2026-10-04 修）：
//  旧实现是 `stdout.slice(0, 512KB)`，既不落盘也不带任何标记，而**构建/测试的报错通常在输出尾部** ——
//  模型拿到一段被切掉结尾的输出，会得出「编译通过 / 测试通过」的结论。
//  这类「错误归因」（而不是报错）对编码能力是负分：报错会触发它去查，沉默的错误结论不会。
//  现在：超过 MAX_OUTPUT_CHARS 时保留头/尾各 8KB，完整输出落盘 userData/tool-output/，
//  并在返回值里带 stdoutTruncated / stdoutChars / stdoutPath，工具描述也告诉模型怎么去捞。
// ============================================================
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { execFile } = require('child_process')

// ---- 子进程跟踪表：pid → child（防止 Python 等脚本执行完后变孤儿进程） ----
const activeChildren = new Map() // pid → { child, startedAt, command }

// 返回值里 stdout/stderr 的展示上限：超过就走「头尾 + 落盘」
const MAX_OUTPUT_CHARS = 512 * 1024
const HEAD_CHARS = 8 * 1024
const TAIL_CHARS = 8 * 1024
// execFile 的收集上限**必须明显大于 MAX_OUTPUT_CHARS**：
// 实测（node 22）一旦超出 maxBuffer，Node 会**杀掉子进程**、回调里只拿得到前 maxBuffer 个字符
// —— 尾部（也就是报错所在处）直接丢失，再怎么裁剪也救不回来。
// 所以调大到 32MB 先把完整输出收下来，再由 shapeOutput 自己裁头尾 + 落盘。
const EXEC_MAX_BUFFER = 32 * 1024 * 1024

/** 落盘目录：userData/tool-output（拿不到 electron 时退回系统临时目录，绝不影响命令结果）。
 *  目录来源与 fs-safe 白名单共用 settings.getCommandOutputDir() —— 否则模型拿到路径却读不了。 */
function outputDir() {
  try {
    const { getCommandOutputDir } = require('../settings')
    return getCommandOutputDir()
  } catch {
    return path.join(os.tmpdir(), 'localai-tool-output')
  }
}

/** 把完整输出写盘，返回绝对路径；失败返回 null（落盘失败不能影响命令本身的结果）。 */
function persistOutput(text, tag) {
  try {
    const dir = outputDir()
    fs.mkdirSync(dir, { recursive: true })
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}-${tag}.log`
    const file = path.join(dir, name)
    fs.writeFileSync(file, text, 'utf-8')
    return file
  } catch {
    return null
  }
}

/**
 * 输出整形：不超限原样返回；超限则「头 8KB + 省略说明 + 尾 8KB」，并把完整内容落盘。
 * @returns {{text: string, truncated: boolean, omittedChars?: number, outputPath?: string|null}}
 */
function shapeOutput(raw, tag) {
  const text = raw || ''
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false }

  const head = text.slice(0, HEAD_CHARS)
  const tail = text.slice(-TAIL_CHARS)
  const omitted = text.length - HEAD_CHARS - TAIL_CHARS
  const outputPath = persistOutput(text, tag)
  const marker = `\n\n...[输出被截断：共 ${text.length} 字符，超过 ${MAX_OUTPUT_CHARS} 字符上限；`
    + `此处只保留开头 ${HEAD_CHARS} 字符与结尾 ${TAIL_CHARS} 字符，中间 ${omitted} 字符已省略]\n`
    + (outputPath
      ? `完整输出已落盘：${outputPath}\n请用 grep_code 在该文件里捞关键字（如 error / failed / FAIL），不要原样重跑这条命令。`
      : '（完整输出落盘失败，如需更多内容请让命令只输出关心的部分，例如加 `| tail -n 200`。）')
  return {
    text: head + marker + '\n...(以下为输出结尾)...\n' + tail,
    truncated: true,
    omittedChars: omitted,
    outputPath,
  }
}

/**
 * Resolve a working bash shell path on Windows.
 * Git for Windows can live in many locations; the default installer uses
 * C:\Program Files\Git, but custom installs (e.g. C:\tools\Git) are common.
 * Returns an absolute path if a known location exists, otherwise lets the OS
 * resolve `bash` from PATH.
 */
function resolveShellPath() {
  if (process.platform !== 'win32') return '/bin/sh'

  const candidates = [
    process.env.GIT_BASH, // explicit override (set GIT_BASH to your bash.exe)
    'C:\\Program Files\\Git\\bin\\bash.exe', // default 64-bit install
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe', // default 32-bit install
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'), // per-user install
    'C:\\tools\\Git\\bin\\bash.exe', // common custom location
    'C:\\tools\\Git\\usr\\bin\\bash.exe',
    'C:\\Git\\bin\\bash.exe',
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {}
  }

  // Last resort: rely on PATH (Git's bin/usr/bin is often on PATH).
  return 'bash'
}

/**
 * Kill a process tree on Windows (taskkill /F /T /PID) or Unix (kill -TERM -pid).
 * Ensures Python child processes spawned via bash don't survive as orphans.
 */
function killProcessTree(pid) {
  try {
    if (process.platform === 'win32') {
      const { execFileSync } = require('child_process')
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 5000, stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGTERM') // negative pid = kill process group
    }
  } catch {
    // process already dead — ignore
  }
}

/**
 * Execute a shell command with timeout.
 * Returns stdout + stderr. Capped at 512 KB output to prevent abuse.
 * Tracks child process PID and force-kills the entire process tree on timeout
 * to prevent Python/orphan processes from lingering.
 *
 * ⚠️ 超时**刻意不用 execFile 自带的 timeout**（2026-09-30 实测事故）：
 * execFile 的 timeout 会先由 Node 把 bash 干掉，然后我们才去
 * `taskkill /T /PID <bash>` —— 而 Windows 的 `/T` 是按「当前还活着的父子关系」
 * 展开进程树的，父进程（bash）都没了，它的子进程（py.exe / python.exe）就整批
 * 变成孤儿继续跑。实测残留过一个占 6.0 GB、跑了近 2 小时的 python.exe。
 * 正确顺序是「趁 bash 还活着先 taskkill /T」，所以改成本模块自管定时器。
 */

/**
 * 从命令里挑出「明确要写入的文件」—— `>` / `>>` 重定向与 `tee` 的目标。
 * 用来给 tools/ai-created 记账：模型常用 `cat > x.py << 'EOF'` 这类写法生成脚本，
 * 那种文件也是 AI 产物，删它不该弹确认框。
 *
 * 刻意保守：只认字面量路径。带变量（$OUT）、通配符、`&1`（`2>&1` 的副产物）、
 * `/dev/null` 这类一律跳过 —— 解析能力的边界必须小于「误记用户文件」的代价。
 */
function unquote(s) {
  const t = String(s || '')
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

function isLiteralOutputPath(t) {
  if (!t) return false
  if (t === '-' || t.startsWith('&')) return false
  if (/^\/dev\/(null|stdout|stderr)$/i.test(t)) return false
  if (/[$*?`!]/.test(t)) return false // 变量展开 / 通配 / 历史展开 → 认不出真实目标
  if (/['"]/.test(t)) return false    // 引号没配平（多半是引号字符串里出现的 ">"，如 echo "a > b"）
  return true
}

function parseOutputTargets(command, cwd) {
  const s = String(command || '')
  const found = []
  const push = (raw) => {
    const t = unquote(raw)
    if (!isLiteralOutputPath(t)) return
    try {
      found.push(path.resolve(cwd || os.homedir(), t))
    } catch {
      /* 路径非法，跳过 */
    }
  }
  // 重定向：可有可选前缀（1 / 2 / &），`>>` 与 `>` 都收
  const reRedir = /(?:^|[\s;&|()])(?:[12&]?>>?)[ \t]*("[^"]+"|'[^']+'|[^\s;&|()<>]+)/g
  let m
  while ((m = reRedir.exec(s))) push(m[1])
  // tee [-a] file [file2 …] —— 参数分隔只认空格 / Tab，**不跨行**：
  // 否则 `tee a.md\npython x.py` 会把下一条命令的 `python` 也当成输出文件。
  const reTee = /(?:^|[\s;&|()])tee\b((?:[ \t]+-{1,2}\w+)*)[ \t]+((?:"[^"]+"|'[^']+'|[^\s;&|()<>]+)(?:[ \t]+(?:"[^"]+"|'[^']+'|[^\s;&|()<>]+))*)/g
  while ((m = reTee.exec(s))) {
    const args = m[2].split(/[ \t]+/).filter(Boolean)
    for (const a of args) push(a)
  }
  return [...new Set(found)]
}

/** 记账：命令跑完后，把这次「新造出来」的文件登记为 AI 产物（记账失败不影响命令结果） */
function noteAiOutput(file) {
  try {
    // 惰性 require：与本模块「尽量少依赖项目内模块」的取向一致，也避开加载顺序问题
    require('./ai-created').noteAiWrite(file, true)
  } catch {
    /* ignore */
  }
}

async function executeCommand(command) {
  const timeoutMs = 300_000

  // 执行前先算出「命令要写、且当前还不存在」的文件（执行后再逐个 stat 落账）。
  // 只认执行前不存在的 —— 用户已有的文件被重定向覆盖，不该因此变成「AI 的草稿」。
  let freshOutputs = []
  try {
    freshOutputs = parseOutputTargets(command, os.homedir()).filter((p) => !fs.existsSync(p))
  } catch {
    freshOutputs = []
  }

  return new Promise((resolve) => {
    // Run via Git Bash on Windows, or sh on other platforms
    const shellPath = resolveShellPath()
    const shellArgs = ['-c', command]

    let settled = false
    let timer = null
    let timedOut = false

    const finish = (payload) => {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      resolve(JSON.stringify(payload))
    }

    let child = null
    try {
      child = execFile(shellPath, shellArgs, {
        maxBuffer: EXEC_MAX_BUFFER,
        cwd: os.homedir(),
      }, (err, stdout, stderr) => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        // 进程结束 → 从跟踪表移除
        if (child && child.pid) activeChildren.delete(child.pid)

        const isEnoent = !!err && err.code === 'ENOENT'
        const maxBufferHit = !!err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        const hint = isEnoent
          ? `找不到 shell (${shellPath})。请安装 Git for Windows（默认装到 C:\\Program Files\\Git），或用 GIT_BASH 环境变量指定 bash.exe 路径。`
          : ''

        const outShape = shapeOutput(stdout, 'stdout')
        const errShape = shapeOutput(stderr, 'stderr')

        // exitCode 归一化：err.code 可能是**字符串**（ERR_CHILD_PROCESS_STDIO_MAXBUFFER / ENOENT…），
        // 直接透传会让模型收到 "exitCode": "ERR_..." —— 既不是数字、也无法与 0 比较。
        //   0      正常结束
        //   n≠0    命令自己的退出码
        //   -1     被超时强杀 / 被信号杀
        //   -2     输出超过收集上限（不是命令的退出码）
        //   1      压根没起来（ENOENT 等）
        let exitCode
        if (timedOut) exitCode = -1
        else if (!err) exitCode = 0
        else if (Number.isInteger(err.code)) exitCode = err.code
        else if (maxBufferHit) exitCode = -2
        else exitCode = 1

        // success 口径（与旧版一致）：非 0 退出码**仍算 success**，交给模型读 exitCode/stderr 判断；
        // 只有「进程被我们/系统杀掉、或压根没起来」才算失败。
        // 旧版这里漏了 maxBuffer 这一种：err.code 是字符串且 err.killed 为 undefined，
        // `err.code === 0 || !err.killed` 会判成 true → 一个被中途杀掉的命令报 success:true。
        const exitOk = !err || err.code === 0 || (!err.killed && !isEnoent && !maxBufferHit)

        const payload = {
          success: !timedOut && exitOk,
          stdout: outShape.text,
          stderr: errShape.text || hint,
          exitCode,
          killed: timedOut || !!(err && err.killed) || maxBufferHit,
          timedOut,
        }
        if (outShape.truncated) {
          payload.stdoutTruncated = true
          payload.stdoutChars = (stdout || '').length
          payload.stdoutOmitted = outShape.omittedChars
          if (outShape.outputPath) payload.stdoutPath = outShape.outputPath
        }
        if (errShape.truncated) {
          payload.stderrTruncated = true
          payload.stderrChars = (stderr || '').length
          payload.stderrOmitted = errShape.omittedChars
          if (errShape.outputPath) payload.stderrPath = errShape.outputPath
        }
        if (isEnoent) {
          payload.error = hint
        } else if (maxBufferHit) {
          payload.error = `输出超过了收集上限（${Math.round(EXEC_MAX_BUFFER / 1024 / 1024)}MB），进程已被中断，`
            + `只能拿到前 ${Math.round(EXEC_MAX_BUFFER / 1024 / 1024)}MB。请让命令只输出关心的内容`
            + '（例如加 `| tail -n 200`、`--quiet`，或把日志写到文件后再 grep）。'
        }
        // 命令新造出来的文件（重定向 / tee 的目标）→ 登记为 AI 产物
        for (const p of freshOutputs) {
          try {
            if (fs.existsSync(p)) noteAiOutput(p)
          } catch {
            /* ignore */
          }
        }
        finish(payload)
      })

      // 注册到跟踪表：记录 PID 和启动时间
      if (child.pid) {
        activeChildren.set(child.pid, { child, startedAt: Date.now(), command: command.slice(0, 200) })
        console.log(`[shell] tracked child PID ${child.pid}: ${command.slice(0, 120)}`)
        timer = setTimeout(() => {
          timedOut = true
          console.log(`[shell] timeout ${timeoutMs}ms → killing tree of PID ${child.pid} (bash 仍活着，整棵树一起杀)`)
          killProcessTree(child.pid)
          try { child.kill('SIGKILL') } catch { /* 已退出 */ }
        }, timeoutMs)
      }
    } catch (e) {
      finish({ success: false, error: e.message })
    }
  })
}

/**
 * 强制终止所有仍在运行的子进程（app 退出或用户中断时调用）。
 * 按 PID 逐个杀进程树，确保 Python 等脚本不留孤儿进程。
 */
function killAllChildren() {
  if (activeChildren.size === 0) return
  console.log(`[shell] killing ${activeChildren.size} active child process(es)`)
  for (const [pid, info] of activeChildren) {
    const age = ((Date.now() - info.startedAt) / 1000).toFixed(1)
    console.log(`[shell]   killing PID ${pid} (age ${age}s): ${info.command.slice(0, 80)}`)
    killProcessTree(pid)
  }
  activeChildren.clear()
}

module.exports = {
  executeCommand,
  resolveShellPath,
  killAllChildren,
  // 导出给单测用（输出整形 / 重定向目标解析都是纯函数，不需要真起进程）
  shapeOutput,
  parseOutputTargets,
  MAX_OUTPUT_CHARS,
  HEAD_CHARS,
  TAIL_CHARS,
  EXEC_MAX_BUFFER,
}