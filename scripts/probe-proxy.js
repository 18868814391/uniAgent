#!/usr/bin/env node
/**
 * probe-proxy.js —— 找公司有没有「能正常出境」的正向代理
 *
 * 用法（在 IT 网下跑）：
 *   node scripts/probe-proxy.js
 *       -> 读系统 PAC / 手动代理配置，并尝试 WPAD 自动发现
 *
 *   node scripts/probe-proxy.js http://proxy.corp.local:8080
 *       -> 额外实测这个候选代理：经它访问 opencode.ai，对比直连的握手与吞吐
 *
 * 为什么需要它：如果公司有代理、且代理的出境线路比 IT Wi-Fi 直连好，
 * 那就不用加第二块网卡 —— 让 localAi 的这个端点走代理即可（需要应用侧加一行
 * undici ProxyAgent，Node 的原生 fetch 不吃 HTTP_PROXY 环境变量）。
 *
 * 本脚本只做只读探测：不修改任何系统设置，不写入注册表。
 */

const http = require('http')
const https = require('https')
const { execFileSync } = require('child_process')

const CANDIDATE = process.argv[2] || null
const TARGET = 'https://opencode.ai/zen/go/v1/models'

function systemProxySettings() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "$k = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue; " +
      "Write-Output ('ProxyEnable=' + $k.ProxyEnable); " +
      "Write-Output ('ProxyServer=' + $k.ProxyServer); " +
      "Write-Output ('AutoConfigURL=' + $k.AutoConfigURL); " +
      "Write-Output ('ProxyOverride=' + $k.ProxyOverride); " +
      "Write-Output ('AutoDetect=' + $k.AutoDetect)"
    ], { encoding: 'utf8' })
    return out.trim()
  } catch (e) { return '(读取失败: ' + e.message + ')' }
}

// WPAD 自动发现：试几个常见主机名
function tryWpad() {
  const names = ['wpad', 'wpad.' + (process.env.USERDNSDOMAIN || ''), 'proxy', 'proxy.' + (process.env.USERDNSDOMAIN || '')]
    .filter((n) => !n.endsWith('.'))
  const results = []
  return new Promise((resolve) => {
    let left = names.length
    if (!left) return resolve(results)
    for (const n of names) {
      const req = http.get({ host: n, port: 80, path: '/wpad.dat', timeout: 4000 }, (res) => {
        let d = ''
        res.on('data', (c) => { d += c })
        res.on('end', () => {
          const hit = /PROXY\s+([^\s;]+)/i.exec(d)
          results.push({ name: n, status: res.statusCode, proxy: hit ? hit[1] : null, len: d.length })
          if (--left === 0) resolve(results)
        })
      })
      req.on('timeout', () => { req.destroy() })
      req.on('error', () => { if (--left === 0) resolve(results) })
    }
  })
}

// 经代理取一个小资源，测握手 + 吞吐
function viaProxy(proxyUrl, targetUrl, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const p = new URL(proxyUrl)
    const t = new URL(targetUrl)
    const t0 = Date.now()
    const req = http.request({
      host: p.hostname, port: p.port || 8080,
      method: 'CONNECT', path: `${t.hostname}:443`, timeout: timeoutMs,
      headers: { Host: `${t.hostname}:443` },
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return resolve({ ok: false, err: `CONNECT ${res.statusCode}` })
      const tls = require('tls').connect({ socket, servername: t.hostname }, () => {
        const tlsMs = Date.now() - t0
        socket.write(`GET ${t.pathname} HTTP/1.1\r\nHost: ${t.hostname}\r\nUser-Agent: curl/8\r\nConnection: close\r\n\r\n`)
        let got = 0
        socket.on('data', (c) => { got += c.length })
        socket.on('end', () => { try { socket.destroy() } catch {} ; resolve({ ok: true, tlsMs, totalMs: Date.now() - t0, bytes: got }) })
        socket.on('close', () => resolve({ ok: true, tlsMs, totalMs: Date.now() - t0, bytes: got }))
      })
      tls.on('error', (e) => resolve({ ok: false, err: 'TLS ' + e.code }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'CONNECT 超时' }) })
    req.on('error', (e) => resolve({ ok: false, err: e.code || e.message }))
    req.end()
  })
}

function direct(targetUrl) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const t = new URL(targetUrl)
    const req = https.get({ host: t.hostname, path: t.pathname, timeout: 20000 }, (res) => {
      let got = 0
      res.on('data', (c) => { got += c.length })
      res.on('end', () => resolve({ ok: true, totalMs: Date.now() - t0, bytes: got }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: '超时' }) })
    req.on('error', (e) => resolve({ ok: false, err: e.code || e.message }))
  })
}

;(async () => {
  console.log('')
  console.log('════ 公司正向代理探测 ════')
  console.log('')
  console.log('[1] 系统代理配置 (HKCU Internet Settings)')
  systemProxySettings().split('\n').forEach((l) => console.log('    ' + l))

  console.log('')
  console.log('[2] WPAD 自动发现（试 wpad / proxy 等主机名）')
  const wpad = await tryWpad()
  if (!wpad.length) console.log('    无响应（可能主机名不存在或被阻断）')
  for (const w of wpad) {
    console.log(`    ${w.name.padEnd(30)} HTTP ${w.status}  ${w.proxy ? '发现代理: ' + w.proxy : '(无 PROXY 指令)'}`)
  }

  console.log('')
  console.log('[3] 直连 opencode.ai 基线')
  const d = await direct(TARGET)
  console.log(`    ${d.ok ? `OK  ${d.totalMs}ms  ${d.bytes}B` : '失败: ' + d.err}`)

  if (CANDIDATE) {
    console.log('')
    console.log(`[4] 经候选代理 ${CANDIDATE}`)
    const r = await viaProxy(CANDIDATE, TARGET)
    if (r.ok) {
      console.log(`    CONNECT+TLS ${r.tlsMs}ms   总计 ${r.totalMs}ms   收到 ${r.bytes}B`)
      const speedup = d.ok ? (d.totalMs / r.totalMs).toFixed(2) : 'n/a'
      console.log(`    相对直连提速：${speedup}x`)
    } else {
      console.log(`    失败: ${r.err}`)
    }
  } else {
    console.log('')
    console.log('提示：若你有已知的公司代理地址，重跑并带上它，例如：')
    console.log('    node scripts/probe-proxy.js http://proxy.corp.local:8080')
  }
  console.log('')
})()
