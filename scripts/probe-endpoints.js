#!/usr/bin/env node
/**
 * probe-endpoints.js —— 对比「当前网络下各 API 端点」的可用性
 *
 * 用法：
 *   node scripts/probe-endpoints.js
 *
 * 作用：把 settings.json 里所有 modelProfiles 走一遍（最小聊天请求），
 *       测 解析 / TCP / TLS / 首字节 / 总耗时。
 *       用来回答：「在 IT 网下，换成国内端点是不是就顺了？」
 *
 * 安全：API key 只在内存里读用，绝不打屏、绝不落盘、只打码后 4 位。
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const dns = require('dns')
const crypto = require('crypto')

const SETTINGS = path.join(process.env.APPDATA || '', 'local-ai', 'settings.json')

function loadProfiles() {
  const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
  const legacy = { name: '(当前默认)', apiKey: s.apiKey, baseUrl: s.baseUrl, model: s.model }
  const list = (s.modelProfiles || []).map((p) => ({ name: p.name, apiKey: p.apiKey, baseUrl: p.baseUrl, model: p.model }))
  return [legacy, ...list].filter((p) => p.baseUrl && p.model)
}

const mask = (k) => (!k ? '(无)' : '****' + String(k).slice(-4))
const hostOf = (u) => { try { return new URL(u).hostname } catch { return null } }

function probe(p, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const host = hostOf(p.baseUrl)
    if (!host) return resolve({ ...p, err: 'baseUrl 解析失败' })
    const t0 = Date.now()
    const marks = {}
    const isHttps = p.baseUrl.startsWith('https')
    const lib = isHttps ? https : http

    const body = JSON.stringify({
      model: p.model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
    })

    const url = new URL(p.baseUrl.replace(/\/$/, '') + '/chat/completions')
    const commonHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Authorization: `Bearer ${p.apiKey || ''}`,
      // opencode 网关强制要求（缺了直接 400 MissingSessionID）
      'x-opencode-session': crypto.randomUUID(),
      'User-Agent': 'curl/8.4.0',
    }

    const finish = (extra) => resolve({
      ...p,
      host,
      tls: marks.tls,
      ttfb: marks.ttfb,
      total: (Date.now() - t0) / 1000,
      ...extra,
    })

    let req
    const onRes = (res) => {
      marks.ttfb = (Date.now() - t0) / 1000
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        let msg = ''
        try {
          const j = JSON.parse(data)
          if (j.error) msg = j.error.message || j.error.type || JSON.stringify(j.error).slice(0, 80)
          else msg = j.choices?.[0]?.message?.content ? 'ok' : (j.choices ? 'ok(空内容)' : '未知响应')
        } catch { msg = data.slice(0, 80).replace(/\s+/g, ' ') }
        finish({ code: res.statusCode, msg })
      })
    }

    try {
      req = lib.request(url, { method: 'POST', headers: commonHeaders, timeout: timeoutMs }, onRes)
    } catch (e) {
      return finish({ code: 0, err: e.message })
    }
    if (isHttps) {
      req.on('socket', (s) => {
        s.on('secureConnect', () => { marks.tls = (Date.now() - t0) / 1000 })
        s.on('connect', () => { marks.tcp = (Date.now() - t0) / 1000 })
      })
    }
    req.on('timeout', () => { req.destroy(); finish({ code: 0, err: `超时 ${timeoutMs}ms` }) })
    req.on('error', (e) => finish({ code: 0, err: e.code || e.message }))
    req.write(body)
    req.end()
  })
}

;(async () => {
  const t0 = Date.now()
  console.log('')
  console.log('════ API 端点可用性对比 ════')
  const profiles = loadProfiles()
  const results = []
  for (const p of profiles) {
    const r = await probe(p)
    results.push(r)
  }
  const nameW = Math.min(22, Math.max(...results.map((r) => r.name.length), 4))
  console.log(`\n${'端点'.padEnd(nameW)} ${'host'.padEnd(32)} ${'tcp'.padStart(6)} ${'tls'.padStart(6)} ${'首字节'.padStart(7)} ${'总耗时'.padStart(7)}  HTTP  结果`)
  console.log('-'.repeat(120))
  for (const r of results) {
    const f = (v) => (typeof v === 'number' ? v.toFixed(2) + 's' : '--')
    const verdict = r.err ? r.err : (r.code === 200 ? (r.msg === 'ok' ? '可用' : r.msg) : `HTTP ${r.code} · ${r.msg}`)
    console.log(
      `${String(r.name).padEnd(nameW)} ${String(r.host).padEnd(32)} ` +
      `${f(r.tcp).padStart(6)} ${f(r.tls).padStart(6)} ${f(r.ttfb).padStart(7)} ${f(r.total).padStart(7)}  ` +
      `${String(r.code || '-').padStart(4)}  ${verdict}`
    )
  }
  console.log('')
  console.log('注：总耗时含模型首字节延迟，跨端点不可直接比绝对值；重点看 tcp/tls 是否 >1s 或出现超时。')
  console.log(`key 只用了后 4 位核对： ${results.map((r) => `${r.name}=${mask(r.apiKey)}`).join('   ')}`)
  console.log(`\n共 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
})()
