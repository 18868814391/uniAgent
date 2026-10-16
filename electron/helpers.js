// ============================================================
//  通用进程/安装助手 —— execFile / UAC 提权 / 下载并安装
//  供 settings(系统组件安装)与 kbase(zip 解压)等模块复用。
// ============================================================
const fs = require('fs')
const { execFile, spawn } = require('child_process')

function execFilePromise(cmd, args, extraOptions = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 600000, maxBuffer: 128 * 1024 * 1024, ...extraOptions }, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

/**
 * Run a command with elevated privileges via PowerShell (UAC prompt).
 * The user will see a UAC dialog — this is expected for software installers.
 */
function runElevated(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', `Start-Process -FilePath "${cmd.replace(/"/g, '\\"')}" -ArgumentList '${args.map(a => a.replace(/'/g, "''")).join(' ')}' -Wait -Verb RunAs`],
      { stdio: 'ignore', windowsHide: false }
    )
    child.on('close', (code) => {
      // msiexec exit codes: 0=success, 1641/3010=success+reboot, others=fail
      if (code === 0 || code === 1641 || code === 3010) resolve()
      else reject(new Error(`安装程序退出码: ${code}。请尝试手动安装。`))
    })
    child.on('error', reject)
  })
}

/**
 * 解析一个"真正可用"的 Python 解释器，返回可直接传给 execFile/spawn 的 [exe, ...args]。
 *
 * 背景：本机装了 LibreOffice 后，它自带的 python.exe 会抢到 PATH 最前面，
 * 导致裸 `python` 命令解析到 LibreOffice 内置 Python（缺 openpyxl/pandas，且在
 * C:\Program Files 下装不进用户包）；另外 WindowsApps 里的 python.exe 只是个
 * 静默重定向器（运行啥也不干）。两种情况都会让 Excel 依赖探测/安装全部失败。
 *
 * 策略：优先用 Windows 官方 Python 启动器 `py -3`（永远指向用户正常 Python，
 * 不受 PATH 污染），否则回退遍历 PATH 里第一个能 `import openpyxl` 的解释器。
 * 返回形如 ['py', '-3'] 或 ['C:\\...\\python.exe']，调用方用 spread 拼到参数前即可。
 */
async function resolvePython() {
  // 1) py 启动器：最稳，指向用户安装的 Python（通常自带 openpyxl/pandas）
  for (const attempt of [['py', '-3'], ['py', '-3.10'], ['py']]) {
    try {
      await execFilePromise(attempt[0], attempt.slice(1).concat(['--version']))
      return attempt
    } catch {}
  }
  // 2) 回退：PATH 中第一个能 import openpyxl 的 python（取绝对路径，避免后续被 PATH 变动影响）
  for (const cmd of ['python', 'python3', 'python.exe']) {
    try {
      await execFilePromise(cmd, ['-c', 'import openpyxl'])
      const { stdout } = await execFilePromise(cmd, ['-c', 'import sys; print(sys.executable)'])
      const exe = stdout.trim()
      return exe ? [exe] : [cmd]
    } catch {}
  }
  // 3) 实在没有就用裸 python，至少给个可执行入口
  return ['python']
}

// 流式下载单个文件到 destPath，向 event.sender 推送下载进度（system:downloadProgress）
async function downloadAndInstall(event, url, destPath, type, startMessage) {
  event.sender.send('system:downloadProgress', { type, percent: 0, message: startMessage || '正在下载...' })

  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载失败 (HTTP ${response.status})`)

  const total = parseInt(response.headers.get('content-length') || '0', 10)
  const reader = response.body.getReader()
  const writeStream = fs.createWriteStream(destPath)

  let downloaded = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    downloaded += value.length
    writeStream.write(Buffer.from(value))
    if (total > 0) {
      const pct = Math.round((downloaded / total) * 100)
      event.sender.send('system:downloadProgress', { type, percent: pct, downloaded, total })
    }
  }

  await new Promise((resolve, reject) => {
    writeStream.end(resolve)
    writeStream.on('error', reject)
  })
}

module.exports = { execFilePromise, runElevated, downloadAndInstall, resolvePython }