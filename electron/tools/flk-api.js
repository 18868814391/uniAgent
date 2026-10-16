// ============================================================
//  flk-api —— 国家法律法规数据库（flk.npc.gov.cn）纯 HTTP API
//  实测（2026-09）：检索接口 /law-search/search/list 与下载接口
//  /law-search/download/pc 均可直连（无需浏览器、无验证码），
//  仅需 UA + Referer。本模块不依赖 Electron，可独立单元测试。
//
//  链路：
//    1. POST /law-search/search/list  关键词 → rows[]（含 bbbs=法规ID）
//    2. GET  /law-search/download/pc?format=docx&bbbs=<ID>
//          → JSON.data.url（flkoss OSS 签名直链，1h 有效）
//    3. GET  上一步直链 → 官方 docx/doc 全文
// ============================================================
const NPC_BASE = 'https://flk.npc.gov.cn'
const NPC_SEARCH_LIST = `${NPC_BASE}/law-search/search/list`
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const TIMEOUT_MS = 25000
// 瞬时故障（网络错误 / 5xx / 超时）额外重试 1 次，降低无谓的浏览器兜底与误报错
const RETRY_COUNT = 1
const RETRY_DELAY_MS = 800

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 单次 POST；失败不重试，返回带成功/失败标记的结构化结果（不再向调用方抛异常）
async function postJsonOnce(url, bodyObj) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let resp
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': UA, Referer: NPC_BASE + '/' },
      body: JSON.stringify(bodyObj),
      signal: ctrl.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    const msg = e && e.message ? e.message : String(e)
    const timeout = !!(e && (e.name === 'AbortError' || /abort/i.test(msg)))
    // 超时给明确文案（Node fetch abort 默认报 "The operation was aborted"，对用户/模型不可读）
    return timeout
      ? { success: false, timeout: true, error: `请求超时（已等待 ${TIMEOUT_MS / 1000}s）` }
      : { success: false, networkError: true, error: `网络请求失败：${msg}` }
  }
  clearTimeout(timer)
  const text = await resp.text()
  if (!resp.ok) {
    return { success: false, httpStatus: resp.status, raw: text.slice(0, 300) }
  }
  const ct = String(resp.headers.get('content-type') || '')
  if (!ct.includes('json') && !/^[\s]*\{/.test(text.slice(0, 200))) {
    // 返回了 HTML/验证码页 → 视为被反爬拦截（走浏览器兜底）
    return { success: false, blocked: true, raw: text.slice(0, 300) }
  }
  try {
    return { success: true, data: JSON.parse(text) }
  } catch {
    return { success: false, raw: text.slice(0, 300) }
  }
}

// 带轻量自动重试的 POST：网络错误 / 超时 / 5xx 重试 1 次；4xx 与业务性失败不重试
async function postJson(url, bodyObj) {
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    const out = await postJsonOnce(url, bodyObj)
    const retriable = !!(
      out &&
      (out.timeout || out.networkError || (out.httpStatus != null && out.httpStatus >= 500))
    )
    if (retriable && attempt < RETRY_COUNT) {
      await sleep(RETRY_DELAY_MS)
      continue
    }
    return out
  }
}

// 去除搜索结果里的 <em class='highlight'>…</em> 高亮标签
function stripEmTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '')
}

/**
 * 按关键词检索法规（对应官网"全文/标题"搜索）。
 * @param {object} p
 * @param {string} p.query      检索内容（法规全称 / 关键词）
 * @param {number} [p.page]     页码（默认 1）
 * @param {number} [p.pageSize] 每页条数（默认 15）
 * @param {number} [p.searchType] 2=标题+全文（默认 2）
 * @returns {Promise<{success:boolean, total?:number, rows?:Array, httpStatus?:number, blocked?:boolean, raw?:string}>}
 */
async function npcSearchList({ query, page = 1, pageSize = 15, searchType = 2 } = {}) {
  const kw = String(query || '').trim()
  if (!kw) return { success: false, error: '缺少检索内容 query' }
  const body = {
    searchRange: 1,
    sxrq: [],
    gbrq: [],
    searchType,
    sxx: [],
    gbrqYear: [],
    flfgCodeId: [],
    zdjgCodeId: [],
    searchContent: kw,
    xgzlSearch: false,
    orderByParam: { order: '-1', sort: '' },
    pageNum: Math.max(1, Number(page) || 1),
    pageSize: Math.min(50, Math.max(1, Number(pageSize) || 15)),
  }
  const res = await postJson(NPC_SEARCH_LIST, body)
  if (!res.success) return res
  const d = res.data || {}
  const rows = Array.isArray(d.rows) ? d.rows : []
  return {
    success: true,
    total: typeof d.total === 'number' ? d.total : rows.length,
    rows: rows.map((r) => ({
      bbbs: r.bbbs || '',
      title: stripEmTags(r.title),
      gbrq: r.gbrq || '', // 公布日期
      sxrq: r.sxrq || '', // 施行日期
      zdjgName: r.zdjgName || '', // 制定机关
      flxz: r.flxz || '', // 法规性质（法律/行政法规/地方法规…）
      sxx: r.sxx, // 时效性
      score: r.score,
    })),
  }
}

module.exports = { npcSearchList }
