// fetchWithRetry 单测：429 / 5xx / 网络错误重试、指数退避、中断不重试。
// 通过 mock 全局 fetch 验证，不发起真实网络请求。
const test = require('node:test')
const assert = require('node:assert/strict')
const { fetchWithRetry, parseRetryAfter, sleepAbortable, backoffDelay, describeFetchError } = require('../electron/net-retry.js')

function makeResponse(status, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  }
}

test('429 后重试成功，onRetry 收到状态码与退避时长', async () => {
  const originalFetch = global.fetch
  const calls = []
  global.fetch = async () => {
    calls.push(calls.length)
    return calls.length === 1 ? makeResponse(429, { 'retry-after': '0' }) : makeResponse(200)
  }
  try {
    const retries = []
    const res = await fetchWithRetry('http://x', {}, { baseDelay: 5, onRetry: (a, d, s) => retries.push({ a, d, s }) })
    assert.equal(res.status, 200)
    assert.equal(calls.length, 2)
    assert.equal(retries.length, 1)
    assert.equal(retries[0].a, 1)
    assert.equal(retries[0].s, 429)
    assert.ok(retries[0].d >= 0)
  } finally {
    global.fetch = originalFetch
  }
})

test('5xx 重试耗尽返回最后一次响应（请求次数 = maxRetries + 1）', async () => {
  const originalFetch = global.fetch
  let count = 0
  global.fetch = async () => { count++; return makeResponse(503) }
  try {
    const res = await fetchWithRetry('http://x', {}, { maxRetries: 2, baseDelay: 5 })
    assert.equal(res.status, 503)
    assert.equal(count, 3)
  } finally {
    global.fetch = originalFetch
  }
})

test('网络错误重试后成功', async () => {
  const originalFetch = global.fetch
  let n = 0
  global.fetch = async () => {
    n++
    if (n === 1) throw new TypeError('fetch failed')
    return makeResponse(200)
  }
  try {
    const res = await fetchWithRetry('http://x', {}, { baseDelay: 5 })
    assert.equal(res.status, 200)
    assert.equal(n, 2)
  } finally {
    global.fetch = originalFetch
  }
})

test('非重试状态码（400/401）直接返回，不重试', async () => {
  const originalFetch = global.fetch
  let count = 0
  global.fetch = async () => { count++; return makeResponse(401) }
  try {
    const res = await fetchWithRetry('http://x', {}, { maxRetries: 3, baseDelay: 5 })
    assert.equal(res.status, 401)
    assert.equal(count, 1)
  } finally {
    global.fetch = originalFetch
  }
})

test('已中断的信号不重试，原样抛出错误', async () => {
  const originalFetch = global.fetch
  const controller = new AbortController()
  controller.abort()
  let count = 0
  global.fetch = async () => {
    count++
    const err = new Error('aborted')
    err.name = 'AbortError' // 与真实 fetch 中断时抛出的 AbortError 一致
    throw err
  }
  try {
    await assert.rejects(
      () => fetchWithRetry('http://x', { signal: controller.signal }, { maxRetries: 3, baseDelay: 5 }),
      (err) => err.name === 'AbortError'
    )
    assert.equal(count, 1)
  } finally {
    global.fetch = originalFetch
  }
})

test('parseRetryAfter：秒数 / HTTP 日期 / 缺失', () => {
  assert.equal(parseRetryAfter(makeResponse(429, { 'retry-after': '3' })), 3000)
  assert.equal(parseRetryAfter(makeResponse(429, { 'retry-after': '0' })), 0)
  assert.equal(parseRetryAfter(makeResponse(429)), null)
  // HTTP 日期格式
  const t = Date.now() + 4000
  const dateStr = new Date(t).toUTCString()
  const got = parseRetryAfter(makeResponse(429, { 'retry-after': dateStr }))
  assert.ok(got >= 3000 && got <= 4000, `HTTP 日期应解析为剩余毫秒，得到 ${got}`)
  // 超过上限截断到 10s
  assert.equal(parseRetryAfter(makeResponse(429, { 'retry-after': '99999' })), 10000)
})

test('sleepAbortable：信号已中断时立即返回', async () => {
  const controller = new AbortController()
  controller.abort()
  const start = Date.now()
  await sleepAbortable(100000, controller.signal)
  assert.ok(Date.now() - start < 1000, '中断后应立即返回')
})

test('backoffDelay：指数增长且带抖动', () => {
  const seen = new Set()
  for (let i = 0; i < 20; i++) seen.add(backoffDelay(0, 800, 8000))
  assert.ok(seen.size > 1, '抖动应产生不同值')
  assert.ok(backoffDelay(0, 800, 8000) >= 800)
  assert.ok(backoffDelay(10, 800, 8000) <= 8000 * 1.3, '受 maxDelay 约束')
})

test('describeFetchError：带出 undici 的真实原因（fetch failed 只有这一层是真相）', () => {
  // 真实形态：undici 抛 TypeError('fetch failed')，原因藏在 err.cause
  const connectTimeout = new TypeError('fetch failed')
  connectTimeout.cause = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
  assert.equal(describeFetchError(connectTimeout), 'fetch failed（UND_ERR_CONNECT_TIMEOUT）')

  const reset = new TypeError('fetch failed')
  reset.cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  assert.equal(describeFetchError(reset), 'fetch failed（ECONNRESET）')

  // 没有 cause（普通业务错误，如 API 4xx）：原样返回，不凭空加括号
  assert.equal(describeFetchError(new Error('API error 500: boom')), 'API error 500: boom')

  // cause 没有 code 时用 errno / name 兜底
  const aggregate = new TypeError('fetch failed')
  aggregate.cause = { name: 'AggregateError' }
  assert.equal(describeFetchError(aggregate), 'fetch failed（AggregateError）')

  // 非 Error / 空值不应抛错（catch 块里再抛一次会盖掉原始失败）
  assert.equal(describeFetchError(null), '未知错误')
  assert.equal(describeFetchError('boom'), 'boom')
})
