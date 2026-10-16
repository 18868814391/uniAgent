// ============================================================
//  孤儿脚本进程清扫 —— 纯函数判定（不需要 electron / 不需要真起进程）
//
//  背景：2026-09-30 实测事故 —— Excel 角色跑 explore6.py 时应用被重启，
//  bash → py.exe → python.exe 整条链变孤儿继续跑，残留一个 6.0 GB 的 python.exe。
//  这里锁住「什么算孤儿」，尤其是**不能误杀**的那几种。
// ============================================================
const test = require('node:test')
const assert = require('node:assert')
const oc = require('../electron/tools/orphan-cleanup')

const XL = 'C:\\Users\\syf\\Desktop\\myAIWorkspace\\.xl-work'
const PY = 'C:\\Users\\syf\\AppData\\Local\\Programs\\Python\\Python311\\python.exe'

/** 本次事故的真实进程链：bash(16128) → py.exe(12224) → python.exe(32292)，bash 的父 34584 已消失 */
const REAL_ORPHAN_CHAIN = [
  { pid: 32292, ppid: 12224, name: 'python.exe', cmd: `${PY} ${XL}\\explore6.py` },
  { pid: 12224, ppid: 16128, name: 'py.exe', cmd: `C:\\WINDOWS\\py.exe -3 ${XL}\\explore6.py` },
  { pid: 16128, ppid: 34584, name: 'bash.exe', cmd: `"C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe" -c "py -3 \\"${XL}\\explore6.py\\""` },
]

const names = (list) => list.map((p) => p.pid).sort((a, b) => a - b)

test('复刻事故现场：父链断掉的 bash→py→python 整条链都判为孤儿', () => {
  const found = oc.findOrphanScriptProcesses(REAL_ORPHAN_CHAIN)
  assert.deepEqual(names(found), [12224, 16128, 32292], '三层都应命中')
})

test('链上有活着的 electron → 不是孤儿（正在被本应用执行，绝不能杀）', () => {
  const procs = [
    ...REAL_ORPHAN_CHAIN.slice(0, 2),
    { pid: 16128, ppid: 10552, name: 'bash.exe', cmd: `bash -c "py -3 ${XL}\\explore6.py"` },
    { pid: 10552, ppid: 20168, name: 'electron.exe', cmd: 'electron.exe . --no-sandbox' },
    { pid: 20168, ppid: 1, name: 'node.exe', cmd: 'node vite.js dev' },
  ]
  assert.deepEqual(oc.findOrphanScriptProcesses(procs), [], '链上有 electron 时一条都不许动')
})

test('命令行不含 .xl-work → 不是本应用的脚本（用户自己的 python 不许碰）', () => {
  const procs = [
    { pid: 9001, ppid: 8888, name: 'python.exe', cmd: `C:\\Python311\\python.exe C:\\Users\\syf\\Desktop\\我的脚本.py` },
    { pid: 8888, ppid: 7777, name: 'bash.exe', cmd: 'bash -c "python 我的脚本.py"' },
  ]
  assert.deepEqual(oc.findOrphanScriptProcesses(procs), [], '只认 .xl-work 目录')
})

test('进程名不在候选集（node / electron / cmd）→ 一律不碰', () => {
  const procs = [
    { pid: 1, ppid: 999, name: 'node.exe', cmd: `node ${XL}\\run.js` },
    { pid: 2, ppid: 999, name: 'cmd.exe', cmd: `cmd /c ${XL}\\a.bat` },
  ]
  assert.deepEqual(oc.findOrphanScriptProcesses(procs), [])
})

test('pythonw.exe / python3.13.exe 也认（候选名正则留了余量）', () => {
  const procs = [
    { pid: 11, ppid: 999, name: 'pythonw.exe', cmd: `pythonw ${XL}\\a.py` },
    { pid: 12, ppid: 999, name: 'python3.13.exe', cmd: `python3.13 ${XL}\\b.py` },
  ]
  assert.deepEqual(names(oc.findOrphanScriptProcesses(procs)), [11, 12])
})

test('父链成环（数据异常）→ 保守视为安全，不动手', () => {
  const procs = [
    { pid: 21, ppid: 22, name: 'python.exe', cmd: `python ${XL}\\a.py` },
    { pid: 22, ppid: 21, name: 'bash.exe', cmd: `bash -c "python ${XL}\\a.py"` },
  ]
  assert.deepEqual(oc.findOrphanScriptProcesses(procs), [], '环里没有 electron，但也不该按孤儿处理')
})

test('只有链路末端断了才算孤儿：父活着但祖父没了的中间层也要命中', () => {
  const procs = [
    { pid: 31, ppid: 32, name: 'python.exe', cmd: `python ${XL}\\a.py` },
    { pid: 32, ppid: 33, name: 'py.exe', cmd: `py -3 ${XL}\\a.py` },
    { pid: 33, ppid: 40404, name: 'bash.exe', cmd: `bash -c "py -3 ${XL}\\a.py"` },
    // 40404 不存在
  ]
  assert.deepEqual(names(oc.findOrphanScriptProcesses(procs)), [31, 32, 33])
})

test('parseTable：解析 pid/ppid/name/cmd（cmd 里含空格不截断，CRLF 兼容）', () => {
  const text = [
    '32292\t12224\tpython.exe\tC:\\Python311\\python.exe C:\\Users\\syf\\My Dir\\.xl-work\\a.py',
    '12224\t16128\tpy.exe\tpy -3 a.py',
    '',
    '16128\t34584\tbash.exe\tbash -c "py -3 a.py"',
  ].join('\r\n')
  const rows = oc.parseTable(text)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], {
    pid: 32292,
    ppid: 12224,
    name: 'python.exe',
    cmd: 'C:\\Python311\\python.exe C:\\Users\\syf\\My Dir\\.xl-work\\a.py',
  })
  assert.equal(rows[2].pid, 16128)
})

test('parseTable：非法行（列数不足 / pid 非数字）被丢弃，不抛错', () => {
  assert.deepEqual(oc.parseTable(''), [])
  assert.deepEqual(oc.parseTable('garbage'), [])
  assert.deepEqual(oc.parseTable('notanumber\t1\tpython.exe\tx'), [])
  assert.equal(oc.parseTable('1\t2\tpython.exe\tx').length, 1, '缺 cmd 也算合法行（cmd 为空串）')
})

test('killOrphanScriptProcesses：非 Windows 平台直接跳过，不做任何事', async () => {
  if (process.platform === 'win32') return // 本机是 Windows，这条只在别的平台有意义
  const res = await oc.killOrphanScriptProcesses()
  assert.equal(res.found, 0)
  assert.equal(res.skipped, true)
})
