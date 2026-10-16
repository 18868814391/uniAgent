// ============================================================
//  tools/orphan-cleanup —— 清扫上一次运行遗留的「孤儿脚本进程」
//
//  为什么需要（2026-09-30 实测事故）：
//  Excel 专家角色处理 xlsx 时，execute_command 起的是
//    bash.exe -c "py -3 <授权目录>/.xl-work/explore6.py"
//  进程链为 bash → py.exe → python.exe。脚本跑很久（openpyxl 遍历 9810 行 × 120 列），
//  期间应用被重启（dev 模式重载 / 异常退出），于是：
//    · execFile 的超时定时器随 Electron 主进程一起消失，没人再管这条链；
//    · main.js 的 before-quit → killAllChildren() 只在「正常退出」路径上跑，也没跑到。
//  结果整条链变成孤儿继续跑 —— 实测残留一个 python.exe 占 6.0 GB、跑了近 2 小时。
//
//  判定「孤儿」的条件（三条同时满足，宁可不杀也不误杀）：
//    ① 进程名是 python* / py / bash 之一；
//    ② 命令行里出现 .xl-work（本应用 Excel/本地任务的专属临时目录名）——
//       用户自己的脚本不会跑这个目录，这是最关键的排他条件；
//    ③ 沿 ParentProcessId 上溯，**链上没有活着的 electron 进程**。
//       正常执行中的命令链是 bash ← electron（本应用主进程），必然命中 electron；
//       上次实例遗留的链条会在某个「已不存在的 pid」处断掉。
//
//  纯函数（parseTable / findOrphanScriptProcesses）与副作用（listProcesses / kill）
//  分开导出，前者供 tests/orphan-cleanup.test.js 直接断言，不需要 electron 环境。
// ============================================================
const { execFile, execFileSync } = require('child_process')

// 本应用 Excel/本地任务的会话级临时目录名（与 xl-work.js 的 WORK_SUBDIR 一致）。
// 刻意不 require('./xl-work')/settings —— 那个链条会拉进 electron，
// 而本模块要在启动早期、纯 node 下也能被 require 与测试。
const WORK_DIR_MARK = '.xl-work'

const CANDIDATE_NAMES = [/^pythonw?\.exe$/i, /^python\d+(\.\d+)?\.exe$/i, /^py\.exe$/i, /^bash\.exe$/i]
const ELECTRON_NAME = /^electron(\.exe)?$/i

// 进程表探测：PowerShell 一把梭取全表，拼成 "pid\tppid\tname\tcmdline" 行后整体 Base64。
// 用 Base64 是为了绕开 PowerShell 5.1 控制台编码（中文路径会按 GBK 输出导致乱码）+ 长行折行。
const PROBE_SCRIPT = [
  '$rows = @(Get-CimInstance Win32_Process)',
  '$lines = foreach ($p in $rows) {',
  '  $cmd = [string]$p.CommandLine',
  '  $cmd = $cmd -replace "`r", " " -replace "`n", " " -replace "`t", " "',
  '  "{0}`t{1}`t{2}`t{3}" -f $p.ProcessId, $p.ParentProcessId, $p.Name, $cmd',
  '}',
  '$text = $lines -join "`n"',
  '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))',
].join('; ')

/** 解析 "pid\tppid\tname\tcmdline" 文本表 → [{pid, ppid, name, cmd}] */
function parseTable(text) {
  const out = []
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    if (!Number.isInteger(pid)) continue
    out.push({
      pid,
      ppid: Number.isInteger(ppid) ? ppid : 0,
      name: parts[2] || '',
      cmd: parts.slice(3).join(' ') || '',
    })
  }
  return out
}

/**
 * 从进程表里挑出「本次应用早已退出、但脚本还在跑」的孤儿进程。
 * @param {Array<{pid:number,ppid:number,name:string,cmd:string}>} procs
 * @param {{mark?:string}} [opts]
 */
function findOrphanScriptProcesses(procs, opts = {}) {
  const mark = opts.mark || WORK_DIR_MARK
  const list = Array.isArray(procs) ? procs : []
  const byPid = new Map()
  for (const p of list) byPid.set(Number(p.pid), p)

  const isCandidate = (p) => {
    if (!CANDIDATE_NAMES.some((re) => re.test(String(p.name || '')))) return false
    return String(p.cmd || '').includes(mark)
  }

  // 沿 ppid 上溯：链上出现 electron → 属于某个还活着的应用实例，不是孤儿
  const ownedByLiveApp = (p) => {
    let cur = p
    const seen = new Set()
    while (cur) {
      if (ELECTRON_NAME.test(String(cur.name || ''))) return true
      const pid = Number(cur.pid)
      if (seen.has(pid)) return true // 环（数据异常）→ 保守视为安全，不动手
      seen.add(pid)
      const parent = byPid.get(Number(cur.ppid))
      if (!parent) return false // 父链断了 → 孤儿
      cur = parent
    }
    return false
  }

  return list.filter((p) => isCandidate(p) && !ownedByLiveApp(p))
}

/** 取当前进程表（仅 Windows；其它平台返回空数组） */
function listProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([])
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROBE_SCRIPT],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve([])
        try {
          // PowerShell 可能把 base64 按控制台宽度折行 → 去掉所有空白再解码
          const b64 = String(stdout).replace(/\s+/g, '')
          const text = Buffer.from(b64, 'base64').toString('utf8')
          resolve(parseTable(text))
        } catch {
          resolve([])
        }
      },
    )
  })
}

function killPidTree(pid) {
  try {
    const taskkill = process.env.SystemRoot
      ? `${process.env.SystemRoot}\\System32\\taskkill.exe`
      : 'taskkill'
    execFileSync(taskkill, ['/F', '/T', '/PID', String(pid)], { timeout: 5000, stdio: 'ignore' })
    return true
  } catch {
    return false // 进程已退出 / 权限不足 —— 忽略，下次启动再试
  }
}

/**
 * 清扫孤儿脚本进程。幂等、异步、永不抛错（失败只记日志）。
 * @returns {Promise<{found:number, killed:number[], skipped?:boolean, error?:string}>}
 */
async function killOrphanScriptProcesses(opts = {}) {
  if (process.platform !== 'win32') return { found: 0, killed: [], skipped: true }
  let procs
  try {
    procs = await listProcesses()
  } catch (e) {
    return { found: 0, killed: [], error: e.message }
  }
  if (procs.length === 0) return { found: 0, killed: [] }

  const orphans = findOrphanScriptProcesses(procs, opts)
  if (orphans.length === 0) return { found: 0, killed: [] }

  const killed = []
  for (const p of orphans) {
    if (killPidTree(p.pid)) killed.push(p.pid)
    console.log(`[orphan-cleanup] killed orphan PID ${p.pid} (${p.name}): ${String(p.cmd).slice(0, 160)}`)
  }
  return { found: orphans.length, killed }
}

module.exports = {
  WORK_DIR_MARK,
  parseTable,
  findOrphanScriptProcesses,
  listProcesses,
  killOrphanScriptProcesses,
}
