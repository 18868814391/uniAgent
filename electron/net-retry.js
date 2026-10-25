// ============================================================
//  弹性重试 —— 指数退避 + 抖动
//  对 429 / 5xx / 连接错误 / 首字节超时的 fetch 封装：重试前用 AbortController 信号可中断的 sleep
//  等待（用户点"中断"立即生效，不重试）。纯 Node 模块，可被单测直接 require。
// ============================================================

const MAX_RETRY_AFTER_MS = 10 * 1000 // Retry-After 头上限，避免被服务器带节奏等太久
const FIRST_BYTE_TIMEOUT_MS = 120 * 1000 // 单次请求等待响应头（首字节）的超时：服务端"接受连接但不响应"时兜底

// 首字节超时的重试预算（与 429/5xx 的 maxRetries **分开计**，互不挤占）。
// 为什么超时也要重试：这类卡死实测是**单条连接**的偶发故障，不是端点在坏 ——
// 用户遇到"fetch timed out: no response headers"后点「继续」立刻就好了，就是证据。
// 原先直接抛给用户（"重试大概率同样挂"的判断对"网关整体挂了"成立，对"这一根管子卡住"是错的）。
const MAX_TIMEOUT_RETRIES = 2
const TIMEOUT_RETRY_BASE_DELAY_MS = 2000 // 首字节超时后的重试间隔：2s → 4s（上限 4 倍）
const TIMEOUT_RETRY_MAX_FACTOR = 4

/**
 * 单次 fetch + 首字节超时 + 外部信号中断（Promise.race 实现）。
 * - ms <= 0：不启用超时，等价原样 fetch。
 * - 超时：reject 一个带 timedOut 标记的普通 Error（与用户中断区分开，由调用方决定是否重试）；
 * - 外部 signal 中止：reject AbortError（中断路径）。
 * 用 race 而非改 options.signal，规避 fetch 实现对 abort(reason) 支持的差异；
 * race 无论哪边先 settle，finally 都会清理定时器与监听，不会泄漏句柄。
 */
async function fetchOnceWithTimeout(url, options, ms) {
  // 注意：external 已中止时不在这里提前 throw —— 交给 fetch(url, options) 自身处理
  // （真实 fetch 遇已 abort 的 signal 会立即 reject AbortError 且不发网络请求），
  // 与"已中断不重试"的既有语义/测试保持一致。
  const external = options.signal
  if (!ms || ms <= 0) return fetch(url, options)
  if (external && external.aborted) return fetch(url, options)

  // 每次 attempt 独占一个 controller（而不是直接把 external 交给 fetch）——
  // 这样**超时那一刻才能真的掐断底层连接**。不掐的话，超时只是让 Promise.race 提前
  // 返回，那根 socket 还挂着、连接池里仍算"在用"；下次 attempt 很可能复用它 →
  // 重试打在同一个卡死的连接上，等于没重试。这是"超时也重试"能成立的前提。
  const attempt = new AbortController()
  let timer = null
  let onExternalAbort = null
  const timeoutPromise = new Promise((_, reject) => {
    onExternalAbort = () => {
      attempt.abort()
      const e = new Error('aborted')
      e.name = 'AbortError'
      reject(e)
    }
    if (external) external.addEventListener('abort', onExternalAbort, { once: true })
    timer = setTimeout(() => {
      // 先掐断再 reject：顺序反了会让 abort 的 AbortError 先 settle 掉 race，
      // 上层就看不到 timedOut 标记了
      attempt.abort()
      reject(Object.assign(
        new Error(`fetch timed out: no response headers within ${ms}ms`),
        { name: 'FetchTimeoutError', timedOut: true }
      ))
    }, ms)
  })
  try {
    // fetch 一侧在被 abort 后会抛 AbortError，但 race 已经被 FetchTimeoutError 先 settle，
    // race 内部对两侧都挂了 handler，所以不会产生 unhandled rejection。
    return await Promise.race([fetch(url, { ...options, signal: attempt.signal }), timeoutPromise])
  } finally {
    clearTimeout(timer)
    if (external && onExternalAbort) external.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * 读取 Retry-After 响应头：支持"秒数"或"HTTP 日期"两种格式，超上限截断。
 * 无该头返回 null。
 */
function parseRetryAfter(res) {
  const header = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null
  if (!header) return null
  const secs = parseInt(header, 10)
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS)
  const time = Date.parse(header)
  if (Number.isFinite(time)) {
    return Math.min(Math.max(time - Date.now(), 0), MAX_RETRY_AFTER_MS)
  }
  return null
}

/**
 * 可被信号中断的 sleep。信号已中断/等待中被中断 → 立即返回（调用方随后
 * 用同一 signal 发起 fetch 会立刻抛 AbortError，走原有中断/超时路径）。
 */
function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) return resolve()
    let timer = null
    const onAbort = () => {
      if (timer) clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
  })
}

/** 指数退避 + 抖动：base * 2^attempt（上限 maxDelay）+ 0~30% 抖动 */
function backoffDelay(attempt, baseDelay, maxDelay) {
  const exp = Math.min(baseDelay * 2 ** attempt, maxDelay)
  return Math.round(exp + exp * 0.3 * Math.random())
}

/**
 * fetch 封装：429 / 5xx / 连接错误 / 首字节超时 → 退避重试；重试耗尽返回最后一次响应 / 抛最后一次错误。
 * - 每次 attempt 默认带首字节超时（firstByteTimeoutMs，默认 120s，传 0 可关闭）——
 *   服务端"接受连接但永不回响应头"时不再无限挂起（chat.js 等待 API 响应期间豁免 idle，
 *   此前这类挂起只能靠用户手动"停止"）。
 * - 首字节超时（FetchTimeoutError）**重试有限次**（maxTimeoutRetries，默认 2 次，独立预算，
 *   不挤占 429/5xx 的 maxRetries）：实测这类卡死是**单条连接**的偶发故障，不是端点整体坏了
 *   —— 用户以前遇到它，点一下「继续」立刻就通。超时那一刻会 abort 掉旧连接，重试用新连接。
 * - 400/401/403 等不重试（参数或鉴权问题，重试无用）。
 * - 用户中断（signal.aborted / AbortError）不重试，原样抛出。
 * - onRetry(attempt, delayMs, statusOrNull, info) 在每次重试前回调。
 *     statusOrNull：网络错误时为 null；info = { timedOut: boolean }（超时重试时为 true，
 *     调用方据此换一句准确的提示文案，别把"响应超时"说成"连接失败"）。
 *
 * ⚠️ 默认重试预算（maxRetries / baseDelay / maxDelay）是给「链路成簇抖动」留的窗口：
 *   间隔依次 1.5s → 3s → 6s → 12s → 20s（各带 0~30% 抖动），退避总长 ≈ 42s。
 *   原先的 3 次 / 0.8~8s 只有 5.6s 总窗口 —— 对 opencode 这类境外网关（实测 TCP 握手失败率
 *   ≈30%、且失败成簇）基本等于没重试：4 次全落在同一个坏窗口里就直接报错给用户。
 *   调大后仍可被 signal 随时中断（sleepAbortable 会立即返回），不会拖住「停止」按钮。
 */
async function fetchWithRetry(url, options = {}, {
  maxRetries = 5,
  baseDelay = 1500,
  maxDelay = 20000,
  firstByteTimeoutMs = FIRST_BYTE_TIMEOUT_MS,
  maxTimeoutRetries = MAX_TIMEOUT_RETRIES,
  timeoutRetryBaseDelay = TIMEOUT_RETRY_BASE_DELAY_MS,
  onRetry = null,
} = {}) {
  const signal = options.signal
  let attempt = 0
  let timeoutRetries = 0
  for (;;) {
    let res
    try {
      res = await fetchOnceWithTimeout(url, options, firstByteTimeoutMs)
    } catch (err) {
      if (signal && signal.aborted) throw err // 用户中断 / 空闲超时
      if (err && err.name === 'AbortError') throw err
      if (err && err.timedOut) {
        // 首字节超时：换新连接再试（预算独立于 429/5xx，避免两类故障互相挤占）。
        // 为什么不退避太久：这不是"服务端在限流让我等"，而是"这根连接卡了"——
        // 立刻换一根即可；但间隔也不能是 0，否则对真正挂掉的网关会连打 3 次。
        if (timeoutRetries >= maxTimeoutRetries) throw err
        const exp = timeoutRetryBaseDelay * 2 ** timeoutRetries
        const delay = Math.round(
          Math.min(exp, timeoutRetryBaseDelay * TIMEOUT_RETRY_MAX_FACTOR) +
          Math.random() * 300
        )
        const next = timeoutRetries + 1
        if (onRetry) onRetry(next, delay, null, { timedOut: true })
        await sleepAbortable(delay, signal)
        // 等待期间用户点了「停止」：sleepAbortable 会立即返回，这里提前退出，
        // 交给下一轮 fetch 抛 AbortError（与既有中断路径一致，不在这里吞掉）
        timeoutRetries++
        continue
      }
      if (attempt >= maxRetries) throw err
      const delay = backoffDelay(attempt, baseDelay, maxDelay)
      if (onRetry) onRetry(attempt + 1, delay, null, { timedOut: false })
      await sleepAbortable(delay, signal)
      attempt++
      continue
    }
    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || attempt >= maxRetries) return res
    const delay = parseRetryAfter(res) ?? backoffDelay(attempt, baseDelay, maxDelay)
    if (onRetry) onRetry(attempt + 1, delay, res.status, { timedOut: false })
    await sleepAbortable(delay, signal)
    attempt++
  }
}

/**
 * 把 fetch 失败翻译成「能定位原因」的一句话。
 * Node 的 fetch（undici）对连接层失败一律抛 `TypeError: fetch failed`，
 * 真实原因藏在 err.cause 里（UND_ERR_CONNECT_TIMEOUT / ECONNRESET / ENOTFOUND / 证书错误…）。
 * 只取 err.message 的话，界面上和日志里都只剩一句没有任何线索的 "fetch failed"。
 */
function describeFetchError(err) {
  const msg = (err && err.message) || String(err || '未知错误')
  const cause = err && err.cause
  if (!cause) return msg
  const code = cause.code || cause.errno || cause.name
  return code ? `${msg}（${code}）` : msg
}

module.exports = { fetchWithRetry, fetchOnceWithTimeout, parseRetryAfter, sleepAbortable, backoffDelay, describeFetchError, FIRST_BYTE_TIMEOUT_MS, MAX_TIMEOUT_RETRIES }
