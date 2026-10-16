// ============================================================
//  网络健康探测 —— 右上角状态点的数据来源
//
//  背景：同一个模型端点（如 opencode.ai/zen/go/v1）在「IT 内网」下实测只有
//  4.6 KB/s（流式生成频繁卡死重连），换到移动网络 580 KB/s，差 100 倍以上。
//  这个模块周期性地对「当前活动 profile 的端点」做轻量连通探测，把结论推给
//  渲染层，由右上角状态点显示绿/黄/红。
//
//  探测口径（关键：测的是「网络路径」，不是「API 契约」）：
//    · GET {baseUrl}/models，串行 3 次，每次都用 agent:false 新建连接
//      —— 必须每次新建，否则连接复用会把 TLS 握手成本吃掉，量不到真实的抖动。
//    · 收到任何 HTTP 响应（含 401/404）都算「链路通」；只有网络层错误或超时算失败。
//    · 单次超时 6s；累计 2 次失败就提前收尾（已经够判 bad 了，不必等满 3 次）。
//
//  判定看三件事，而不是单纯看平均延迟 —— 实测「IT 网络」下的特征是
//  「小请求平时还挺快，但 TLS 握手 0.37~7.6s 剧烈抖动 + 偶发 20s 卡死」，
//  所以抖动（max - median）和超时数比中位数更能反映问题：
//    bad      : 失败 >= 2 次，或最坏一次 >= 9s
//    degraded : 失败 1 次，或最坏 >= 5s，或抖动 >= 2.5s
//    good     : 其余
//
//  阈值为什么不能更紧：每次都新建连接，健康基线的单次往返就有 2s 左右
//  （2026-10-14 实测：5G 下 median 2126ms / max 2475ms / jitter 349ms），
//  阈值贴着基线会误报；而 IT 网络下同一端点会飙到 6270ms 甚至打满 6s 超时，
//  留 5s / 9s 两档既能稳住误报，又不漏真问题。
//
//  不做探测的两种情况：API Key 未配置；正在跑 chat 请求（避免抢带宽、
//  也避免把「生成期间的正常耗时」误判成网络差）。
// ============================================================

const crypto = require('crypto')
const state = require('./state')

// ---- 常量 ----
const SAMPLES = 3
const SAMPLE_TIMEOUT_MS = 6000
const EARLY_ABORT_FAILURES = 2
const INTERVAL_GOOD_MS = 45 * 1000
const INTERVAL_BAD_MS = 25 * 1000
const START_DELAY_MS = 4000

const DEGRADED_MAX_MS = 5000
const BAD_MAX_MS = 9000
const DEGRADED_JITTER_MS = 2500

const PROBE_SUFFIX = '/models'

// 聊天侧报上来的「网络类失败」——**没有过期时间**，只由用户显式清除。
//
// 为什么需要这条通道：探针量的是「新建连接 + 小请求」，而用户踩到的故障是
// **长连接被掐**（实测内网下小请求平时只要 0.7s，探针判 good，可流式生成一直断）。
// 真实请求刚失败过，这是比合成探针更硬的证据，所以它说了算、且不靠探针结果推翻。
//
// ⚠️ 第一版给它设过 120s TTL，被用户当场抓出来：「气泡我没去管它，自己消失了 —— 不是说过
// 只有手动关闭才消失吗」。TTL 一过、探针又是 good，状态就回绿、气泡跟着收起。
// **所以这里刻意不留任何按时间自动失效的机制**（重试/超时同理，别再加回来，
// `tests/net-health.test.js` 有代码级断言盯着）。
// 清除入口只有两个，都是用户主动动作：
//   ① 关掉气泡（点 × / 再点一次状态点）→ clearChatFailure()
//   ② 点「重新检测」且这次探针返回 good（等于用户问了"现在好了吗"、系统答"好了"）
const PROBE_AFTER_FAILURE_MS = 800

// 网络层错误码/文案。用 err.cause.code 优先（undici 把真实原因放在 cause 里），
// 缺失时退回文案匹配 —— 实测 `TypeError: terminated` 的 cause.code 就是 ECONNRESET。
const NET_FAILURE_RE =
  /ECONNRESET|ECONNREFUSED|ECONNABORTED|ECONN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|terminated|socket hang up|fetch failed|network|SSL handshake|read operation timed out|请求超时|连接超时/i

// settings 惰性 require：与 repodirs / guard 同款，避免模块加载期的循环依赖
function settingsSafe() {
  try {
    return require('./settings')
  } catch (e) {
    return null
  }
}

// ---- 纯函数（可单测，不依赖 electron / state）----

/** baseUrl -> 探测 URL；非法或非 http(s) 返回 null */
function buildProbeUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null
  let u
  try {
    u = new URL(baseUrl.trim())
  } catch (e) {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const path = u.pathname.replace(/\/+$/, '')
  u.pathname = `${path}${PROBE_SUFFIX}`
  u.search = ''
  u.hash = ''
  return u
}

/** opencode 网关强制要求 x-opencode-session，其它端点不需要（别乱加未知头） */
function needsOpencodeSession(hostname) {
  return /(^|\.)opencode\.ai$/i.test(String(hostname || ''))
}

/**
 * 聊天侧失败的等级判定（纯函数）。
 *
 * 为什么需要它：探针量的是「新建连接 + 一次小请求」，而用户实际踩到的故障是
 * **长连接被掐** —— 实测内网下小请求平时只要 0.7s、探针判 good，可流式生成一直
 * 以 `terminated（ECONNRESET）` 中断。真实请求刚失败过，这是比探针更硬的证据。
 *
 * @param {{message?:string, code?:string, kind?:'error'|'timeout'}} input
 *        code 优先取 `err.cause.code`（undici 把真实原因放 cause 里），缺失时退回文案匹配
 * @returns {'bad'|'degraded'|null} null = 不是网络类失败（如 400/401/模型不收图），不抬状态
 */
function classifyChatFailure(input) {
  const kind = (input && input.kind) || 'error'
  // 空闲超时：180s 一个字节都没有。可能是网络卡住，也可能是模型真的想太久，判轻一档。
  if (kind === 'timeout') return 'degraded'
  const text = `${(input && input.code) || ''} ${(input && input.message) || ''}`
  return NET_FAILURE_RE.test(text) ? 'bad' : null
}

// 严重度排序：数值大的赢。unconfigured 最低 —— 没配 Key 时压根不会有聊天失败。
const LEVEL_RANK = { bad: 4, degraded: 3, good: 2, unknown: 1, unconfigured: 0 }

/**
 * 最终对外状态 = max(探针结论, 聊天失败证据)。纯函数。
 * 只要证据还在，**探针的 good 永远翻不了它** —— 否则又回到"探针绿、请求一直断"。
 *
 * 证据不给过期：既然用户要求「只有手动关才消失」，就不能有任何按时间自动失效的机制。
 * `ttlMs` 只是留给测试注入用的可选项，生产路径不传（即永不过期）。
 *
 * @param {{probeState:string, failure:?{level:string, at:number}, now?:number, ttlMs?:number}} input
 */
function effectiveState(input) {
  const probeState = (input && input.probeState) || 'unknown'
  // 没配 Key 时压根发不出聊天请求，失败证据不适用 —— 此时「API 未配置」才是真相，
  // 挂个「网络异常」会把人指到错的方向。
  if (probeState === 'unconfigured') return 'unconfigured'
  const f = input && input.failure
  if (!f || typeof f.at !== 'number') return probeState
  const now = typeof (input && input.now) === 'number' ? input.now : Date.now()
  // 时钟大幅回拨（at 落在未来）视为脏数据丢弃，避免一个错误时间戳把状态点永久染红
  if (f.at > now + 1000) return probeState
  // 仅测试注入时生效
  if (typeof (input && input.ttlMs) === 'number' && now - f.at >= input.ttlMs) return probeState
  const want = f.level === 'degraded' ? 'degraded' : 'bad'
  return (LEVEL_RANK[want] || 0) > (LEVEL_RANK[probeState] || 0) ? want : probeState
}

/**
 * 由采样结果判定等级。
 * @param {{configured:boolean, samples:number[], failures:number}} input
 *        samples = 每次成功往返的总耗时（ms）
 * @returns {'unconfigured'|'bad'|'degraded'|'good'}
 */
function classify({ configured, samples, failures }) {
  if (!configured) return 'unconfigured'
  const list = Array.isArray(samples) ? samples.slice().sort((a, b) => a - b) : []
  if (!list.length) return 'bad'
  const median = list[Math.floor(list.length / 2)]
  const max = list[list.length - 1]
  const jitter = max - median
  if (failures >= 2 || max >= BAD_MAX_MS) return 'bad'
  if (failures === 1 || max >= DEGRADED_MAX_MS || jitter >= DEGRADED_JITTER_MS) return 'degraded'
  return 'good'
}

// ---- 单次探测 ----

function probeOnce(url, { key, timeoutMs }) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const isHttps = url.protocol === 'https:'
    const mod = isHttps ? require('https') : require('http')

    const headers = { Accept: 'application/json', 'User-Agent': 'LocalAI-NetHealth/1.0' }
    if (key) headers.Authorization = `Bearer ${key}`
    if (needsOpencodeSession(url.hostname)) headers['x-opencode-session'] = crypto.randomUUID()

    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      try {
        req.destroy()
      } catch (e) {
        /* ignore */
      }
      resolve(r)
    }

    let req
    try {
      req = mod.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: `${url.pathname}${url.search || ''}`,
          method: 'GET',
          headers,
          agent: false, // 每次新建连接，才能量到 TLS 握手的真实成本
          rejectUnauthorized: false, // 与 network:fetchJson 口径一致（自签/过期证书场景）
        },
        (res) => {
          let bytes = 0
          res.on('data', (c) => {
            bytes += c.length
          })
          res.on('end', () => finish({ ok: true, status: res.statusCode, bytes, totalMs: Date.now() - t0 }))
          res.on('error', () => finish({ ok: true, status: res.statusCode, bytes, totalMs: Date.now() - t0 }))
        }
      )
    } catch (e) {
      return resolve({ ok: false, error: e.message || 'request build failed', totalMs: Date.now() - t0 })
    }

    req.setTimeout(timeoutMs, () => finish({ ok: false, error: 'timeout', timedOut: true, totalMs: Date.now() - t0 }))
    req.on('error', (e) => finish({ ok: false, error: e.code || e.message, totalMs: Date.now() - t0 }))
    req.end()
  })
}

// ---- 状态与调度 ----

// 探针自己的结论（不含聊天失败证据）
let probeState = 'unknown'
let probeInfo = {
  configured: false,
  host: '',
  model: '',
  failures: 0,
  attempts: 0,
  medianMs: null,
  maxMs: null,
  jitterMs: null,
  bytes: 0,
  checkedAt: null,
  error: '',
}
// 聊天侧报上来的失败证据 { message, at, level }；超过 TTL 自动失效
let chatFailure = null

// 对外快照（state 已合并失败证据）
let current = { state: 'unknown', probeState: 'unknown', chatFailure: null, ...probeInfo }

let timer = null
let failureProbeTimer = null
let probing = false
let started = false

/** 用「探针结论 + 失败证据」重算对外快照。改状态的地方都要走这里。 */
function recompute({ push = true } = {}) {
  const state = effectiveState({ probeState, failure: chatFailure })
  current = {
    state,
    probeState,
    // 失败证据不设过期 —— 气泡要一直挂着，直到用户自己关掉（见文件顶部注释）
    chatFailure: chatFailure
      ? { message: chatFailure.message || '', at: chatFailure.at, level: chatFailure.level }
      : null,
    ...probeInfo,
  }
  if (push) pushUpdate()
  return current
}

function snapshot() {
  return { ...current }
}

function pushUpdate() {
  const win = state.mainWindow
  if (!win) return
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return
  try {
    win.webContents.send('net-health:update', snapshot())
  } catch (e) {
    /* 窗口正在销毁，忽略 */
  }
}

function resolveTarget() {
  const settings = settingsSafe()
  if (!settings || typeof settings.getActiveProfile !== 'function') {
    return { configured: false, baseUrl: '', key: '', model: '', host: '' }
  }
  let profile = null
  try {
    profile = settings.getActiveProfile()
  } catch (e) {
    profile = null
  }
  if (!profile) return { configured: false, baseUrl: '', key: '', model: '', host: '' }
  const baseUrl = profile.baseUrl || ''
  const key = profile.apiKey || ''
  const url = buildProbeUrl(baseUrl)
  return {
    configured: !!key && !!url,
    baseUrl,
    key,
    model: profile.model || '',
    host: url ? url.host : '',
    url,
  }
}

async function runProbe({ force = false } = {}) {
  if (probing) return snapshot()
  probing = true
  try {
    const target = resolveTarget()

    // 未配置：直接把探针结论置为 unconfigured（保留旧语义：状态点变红/提示未配置）
    if (!target.configured) {
      probeState = 'unconfigured'
      probeInfo = {
        configured: false,
        host: target.host || '',
        model: target.model || '',
        failures: 0,
        attempts: 0,
        medianMs: null,
        maxMs: null,
        jitterMs: null,
        bytes: 0,
        error: '',
        checkedAt: Date.now(),
      }
      return recompute()
    }

    // 正在跑 chat：不探测，保留上一次结论（避免抢带宽 + 误判）
    if (!force && state.chatRuns && state.chatRuns.size > 0) {
      return snapshot()
    }

    const samples = []
    let failures = 0
    let bytes = 0
    let lastError = ''

    for (let i = 0; i < SAMPLES; i++) {
      const r = await probeOnce(target.url, { key: target.key, timeoutMs: SAMPLE_TIMEOUT_MS })
      if (r.ok) {
        samples.push(r.totalMs)
        bytes += r.bytes || 0
      } else {
        failures++
        lastError = r.error || 'failed'
      }
      if (failures >= EARLY_ABORT_FAILURES) break
    }

    const sorted = samples.slice().sort((a, b) => a - b)
    const medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
    const maxMs = sorted.length ? sorted[sorted.length - 1] : null

    probeState = classify({ configured: true, samples, failures })
    probeInfo = {
      configured: true,
      host: target.host,
      model: target.model,
      failures,
      attempts: samples.length + failures,
      medianMs,
      maxMs,
      jitterMs: medianMs === null ? null : maxMs - medianMs,
      bytes,
      error: lastError,
      checkedAt: Date.now(),
    }
    return recompute()
  } catch (e) {
    probeState = 'unknown'
    probeInfo = { ...probeInfo, error: e.message || String(e), checkedAt: Date.now() }
    return recompute()
  } finally {
    probing = false
  }
}

/**
 * 聊天侧上报一次「网络类失败」。由 chat.js 在真实出错处调用（那里有 err.cause.code，最准）。
 *
 * · 非网络类失败（kind='error' 但错误码/文案都不像网络问题，例如 400/401/模型不收图）
 *   → 直接忽略，不会把状态点染红。
 * · 记下后**立刻重算并推送**，再延迟 0.8s 补探一次：状态点要马上红，气泡里的数字也别是旧的。
 * · 证据**不设过期、也不会被探针的 good 推翻**，只能由 clearChatFailure() 显式清掉。
 *
 * @returns {object} 最新快照
 */
function noteChatNetworkFailure(input) {
  const level = classifyChatFailure(input)
  if (!level) return snapshot()
  chatFailure = {
    message: String((input && input.message) || '').slice(0, 300),
    at: Date.now(),
    level,
  }
  const snap = recompute()
  if (failureProbeTimer) clearTimeout(failureProbeTimer)
  failureProbeTimer = setTimeout(() => {
    failureProbeTimer = null
    runProbe({ force: true }).catch(() => {})
  }, PROBE_AFTER_FAILURE_MS)
  return snap
}

/**
 * 清除聊天失败证据 —— **唯一**让警告态退出的方式，由用户主动动作触发：
 *   ① 关掉气泡（点 × / 再点一次状态点）
 *   ② 点「重新检测」且这次探针返回 good（用户问了"现在好了吗"，系统答"好了"）
 * 别加定时器把它自动清掉（第一版就是这么被用户抓到的）。
 *
 * @returns {object} 最新快照
 */
function clearChatFailure() {
  if (!chatFailure) return snapshot()
  chatFailure = null
  if (failureProbeTimer) {
    clearTimeout(failureProbeTimer)
    failureProbeTimer = null
  }
  return recompute()
}

function scheduleNext() {
  if (!started) return
  if (timer) clearTimeout(timer)
  const delay =
    current.state === 'bad' || current.state === 'degraded' ? INTERVAL_BAD_MS : INTERVAL_GOOD_MS
  timer = setTimeout(() => {
    runProbe()
      .catch(() => {})
      .then(() => scheduleNext())
  }, delay)
}

/** 启动周期探测（幂等）。窗口就绪后再调用。 */
function start() {
  if (started) return
  started = true
  setTimeout(() => {
    runProbe()
      .catch(() => {})
      .then(() => scheduleNext())
  }, START_DELAY_MS)
}

function stop() {
  started = false
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (failureProbeTimer) {
    clearTimeout(failureProbeTimer)
    failureProbeTimer = null
  }
}

function registerIpc() {
  const { ipcMain } = require('electron')
  // 取当前结论（渲染层挂载时先拿一次，避免等下一次周期探测）
  ipcMain.handle('net-health:get', () => snapshot())
  // 手动/被触发的一次探测（渲染层在聊天报错、或用户点状态点时调用）
  ipcMain.handle('net-health:check', () => runProbe({ force: true }))
  // 用户主动清掉网络异常警告（关气泡 / 重新检测后确认已恢复）
  ipcMain.handle('net-health:clearFailure', () => clearChatFailure())
  start()
}

module.exports = {
  registerIpc,
  start,
  stop,
  runProbe,
  snapshot,
  // 聊天侧上报入口（chat.js 在真实出错处直接调用，不走 IPC）
  noteChatNetworkFailure,
  clearChatFailure,
  // 纯函数，供测试
  buildProbeUrl,
  needsOpencodeSession,
  classify,
  classifyChatFailure,
  effectiveState,
  // 常量导出，便于测试与调参
  CONST: {
    SAMPLES,
    SAMPLE_TIMEOUT_MS,
    EARLY_ABORT_FAILURES,
    INTERVAL_GOOD_MS,
    INTERVAL_BAD_MS,
    DEGRADED_MAX_MS,
    BAD_MAX_MS,
    DEGRADED_JITTER_MS,
    PROBE_AFTER_FAILURE_MS,
  },
}
