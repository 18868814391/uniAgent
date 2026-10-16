// ============================================================
//  legal_npc_search —— 法务角色专用：国家法律法规数据库(npc.gov.cn)检索
//
//  主路径：纯 HTTP API（2026-09 实测可直连，无需浏览器/验证码）——
//    POST /law-search/search/list   关键词 → rows[]（含 bbbs=法规ID）
//    拿到 bbbs 后配合 download_url 下载
//    /law-search/download/pc?format=docx&bbbs=<ID> → docx 全文
//    实现见 ./flk-api.js（本文件内调用 npcSearchList）。
//
//  兜底：仅当主进程 fetch 超时/被 WAF 拦截（返回 HTML/非 JSON）时，
//  才回退到真实浏览器站内搜索（browser-test.js）：
//  流程：openBrowser → 定位搜索框 → type → Enter → 抽取 → 格式化返回。
//  早期注释曾称搜索接口"纯 fetch 一律 500"——该结论已被实测推翻，
//  浏览器 UI 搜索仅保留为极端网络环境的 fallback。
// ============================================================
const browserTest = require('../browser-test')
const { npcSearchList } = require('./flk-api')

const NPC_HOME = 'https://flk.npc.gov.cn/'
const RESULT_WAIT_MS = 15000
const OPEN_TIMEOUT_MS = 25000

// 在页面里把搜索结果抽取成结构化数组（兼容 SPA 的 class 命名）
function extractScript() {
  return `(function () {
    function txt(el) { return el ? (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : '' }
    var results = Array.prototype.slice.call(
      document.querySelectorAll('.result-content, .search-result-item, [class*="result-item"], li[class*="result"]')
    )
    var found = results.length > 0
    if (!found) {
      // 兜底：抓取主内容区文本，便于判断是「无结果」还是「被验证码拦截」
      var main = document.querySelector('.search-page-content') || document.querySelector('.container') || document.body
      var cap = main ? txt(main).slice(0, 1200) : ''
      var captcha = !!document.querySelector('img[src*="captcha"]') ||
        /验证码/.test(document.body.innerText)
      return { found: false, captcha: captcha, text: cap }
    }
    var items = results.slice(0, 12).map(function (el) {
      var titleEl = el.querySelector('.title, [class*="title"]')
      var title = txt(titleEl)
      var metaEls = el.querySelectorAll('.publish-time, .time, .department, .status, [class*="time"], [class*="department"]')
      var meta = Array.prototype.slice.call(metaEls).map(txt).filter(Boolean).join(' | ')
      var descEl = el.querySelector('.desc, [class*="desc"], .no-content, [class*="content"]')
      var desc = txt(descEl).slice(0, 320)
      var a = el.querySelector('a[href*="detail"]') || el.closest('a')
      var href = a ? a.href : ''
      return { title: title, meta: meta, desc: desc, href: href }
    }).filter(function (i) { return i.title || i.desc })
    return { found: true, count: items.length, items: items }
  })()`
}

// 在页面里定位搜索输入框：只考虑"可见"的文本/搜索框，避免命中隐藏控件；
// 优先带 搜索/法规/关键词 等特征（placeholder/aria-label/name/id/class），无特征则取第一个可见输入框。
// 返回可直接交给 type 的 CSS selector（id 用 CSS.escape 防特殊字符）。
function locateInputScript() {
  return `(function () {
    function visible(el) {
      if (!el) return false
      var rects = el.getClientRects && el.getClientRects()
      if (!rects || !rects.length) return false
      var st = window.getComputedStyle(el)
      return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
    }
    function feats(el) {
      return ((el.getAttribute('placeholder') || '') + ' ' +
              (el.getAttribute('aria-label') || '') + ' ' +
              (el.getAttribute('name') || '') + ' ' +
              (el.id || '') + ' ' + (el.className || '')).toLowerCase()
    }
    var all = Array.prototype.slice.call(document.querySelectorAll('input'))
    var KEY = /搜索|查询|法规|法律|文号|标题|关键词|关键字|条文|全文|请输入|search|keyword|law|regulat/
    var visibleInputs = all.filter(visible).filter(function (el) {
      var t = (el.type || '').toLowerCase()
      return t === 'text' || t === 'search' || t === ''
    })
    var hit = null
    for (var i = 0; i < visibleInputs.length; i++) {
      if (KEY.test(feats(visibleInputs[i]))) { hit = visibleInputs[i]; break }
    }
    if (!hit && visibleInputs.length) hit = visibleInputs[0]
    if (!hit) return { sel: null, total: all.length, visible: visibleInputs.length }
    if (hit.id) return { sel: '#' + (window.CSS && CSS.escape ? CSS.escape(hit.id) : hit.id) }
    if (hit.getAttribute('name') && /^[a-z0-9_-]+$/i.test(hit.getAttribute('name'))) {
      return { sel: 'input[name="' + hit.getAttribute('name') + '"]' }
    }
    return { sel: 'input', total: all.length, visible: visibleInputs.length, note: '首个可见输入框无稳定特征，用裸 input 兜底' }
  })()`
}

// 部分 SPA 布局按 Enter 不触发搜索；找不到输入框兜底按钮（文本/aria 含 搜索/查询）模拟点击
function clickSearchBtnScript() {
  return `(function () {
    function vis(el) {
      if (!el) return false
      if (el.offsetParent === null && !(el.getClientRects && el.getClientRects().length)) return false
      var st = window.getComputedStyle(el)
      return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
    }
    var els = Array.prototype.slice.call(document.querySelectorAll(
      'button, [role="button"], a, input[type="button"], input[type="submit"], .el-button, [class*="search-btn"], [class*="searchBtn"], [class*="query-btn"]'
    ))
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      var t = ((el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim()
      var aria = el.getAttribute('aria-label') || ''
      if (vis(el) && (t === '搜索' || t === '查询' || aria.indexOf('搜索') >= 0 || aria.indexOf('查询') >= 0 || /^(搜索|查询)/.test(t))) {
        el.click()
        return true
      }
    }
    return false
  })()`
}

// 受控输入框兜底：insertText 可能没同步到框架的 v-model/value。
// 用原生 value setter 赋值 + 派发 input/change 事件（兼容 Vue/React 受控组件）。
function forceInputValueScript(sel, value) {
  return `(function () {
    var sel = ${JSON.stringify(sel)}
    var kw = ${JSON.stringify(String(value || ''))}
    var el = window.__bt && window.__bt.resolveEl ? window.__bt.resolveEl(sel) : null
    if (!el) return { ok: false, reason: 'no element' }
    var before = el.value
    try {
      var proto = Object.getPrototypeOf(el)
      var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && desc.set) desc.set.call(el, kw)
      else el.value = kw
    } catch (e) {
      try { el.value = kw } catch (e2) { return { ok: false, reason: String(e2 && e2.message || e2) } }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, before: before, after: el.value }
  })()`
}

// 读取当前搜索框的 value（用于校验是否真的输入进去了）
function readInputValueScript(sel) {
  return `(function () {
    var sel = ${JSON.stringify(sel)}
    var el = window.__bt && window.__bt.resolveEl ? window.__bt.resolveEl(sel) : null
    return el ? (el.value || '') : ''
  })()`
}

// 页面结构 dump：定位/输入失败时把真实 DOM 带回来，便于诊断官网搜索框长什么样
function dumpPageInputsScript() {
  return `(function () {
    var out = { url: location.href, title: document.title, inputs: [], buttons: [], searchCandidates: [] }
    var ins = Array.prototype.slice.call(document.querySelectorAll('input'))
    out.inputs = ins.slice(0, 20).map(function (el) {
      var rects = el.getClientRects && el.getClientRects()
      var st = window.getComputedStyle(el)
      return {
        type: el.type, placeholder: el.getAttribute('placeholder') || '',
        id: el.id, name: el.getAttribute('name') || '', cls: (el.className || '').toString().slice(0, 80),
        visible: !!(rects && rects.length) && st.display !== 'none' && st.visibility !== 'hidden',
        display: st.display, value: (el.value || '').slice(0, 40),
      }
    })
    var btns = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"], .el-button'))
    out.buttons = btns.slice(0, 12).map(function (b) {
      return { text: ((b.innerText || b.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 30), cls: (b.className || '').toString().slice(0, 60) }
    })
    var cand = Array.prototype.slice.call(document.querySelectorAll('[class*="search"], [class*="Search"], [id*="search"], [id*="Search"]'))
    out.searchCandidates = cand.slice(0, 8).map(function (el) {
      return { tag: el.tagName, cls: (el.className || '').toString().slice(0, 80), id: el.id || '' }
    })
    return out
  })()`
}

/**
 * 在国家法律法规数据库检索。
 * @param {object} args
 * @param {string} args.query  检索关键词（法规名称 / 条文主题 / 发文字号等）
 * @param {number} [args.page] 结果页码，默认 1
 * @returns {Promise<object>} { success, found?, count?, captchaRequired?, result, error? }
 */
// 浏览器站内搜索（fallback）：打开官网→输入→提交→抽取（保留原实现）
async function legalNpcSearchWithBrowser({ query, page = 1 }) {
  const keyword = String(query || '').trim()
  if (!keyword) {
    return { success: false, error: 'legal_npc_search 缺少 query 参数' }
  }

  try {
    // 1) 打开官网（复用同一个测试浏览器窗口；真实浏览器可过 WZWS WAF）
    await browserTest.openBrowser(NPC_HOME, OPEN_TIMEOUT_MS)

    // 2) 定位搜索框：SPA 首页可能延迟渲染输入框——先轮询等待最多 4s；
    //    仍失败再用 snapshot 的角色/名称匹配兜底
    let sel = ''
    const locDeadline = Date.now() + 4000
    while (Date.now() < locDeadline && !sel) {
      const loc = await browserTest.evalJs(locateInputScript()).catch(() => ({ sel: '' }))
      sel = (loc && loc.sel) || ''
      if (!sel) await new Promise((r) => setTimeout(r, 500))
    }
    if (!sel) {
      const snap = await browserTest.snapshot(150)
      const elements = (snap && snap.elements) || []
      const inputEl =
        elements.find((e) => /input|searchbox/.test(e.role || '') && /搜索|查询|法规|法律|条例|全文|关键词/.test(e.name || '')) ||
        elements.find((e) => /input|searchbox/.test(e.role || ''))
      sel = (inputEl && inputEl.sel) || ''
    }
    if (!sel) sel = 'input'

    // 3) 键入并搜索：输入后校验 value 是否真的写入（受控组件可能没同步），
    //    未写入则用原生 setter+input 事件强制注入；Enter 无效时补点「搜索/查询」按钮。
    const typed = await browserTest.type(sel, keyword)
    await new Promise((res) => setTimeout(res, 300))
    let inputValue = typed && typed.value ? String(typed.value) : ''
    const forced = inputValue.indexOf(keyword) < 0
    if (forced) {
      const f = await browserTest.evalJs(forceInputValueScript(sel, keyword)).catch(() => null)
      if (f && f.ok) inputValue = String(f.after || '')
      await new Promise((res) => setTimeout(res, 200))
    }
    await browserTest.press('Enter')
    await new Promise((res) => setTimeout(res, 500))
    const probe = await browserTest.evalJs(extractScript()).catch(() => null)
    let searchBtnClicked = false
    if (probe && !probe.found && !probe.captcha && !(probe.text && /没有|未找到|无相关|暂无/.test(probe.text))) {
      searchBtnClicked = await browserTest.evalJs(clickSearchBtnScript()).catch(() => false)
      if (!searchBtnClicked) {
        await browserTest.click('text=搜索').catch(() => {})
        await browserTest.click('text=查询').catch(() => {})
      }
    }

    // 4) 等待结果出现（首页默认排序，搜索结果渲染为 .result-content）
    let data = null
    const deadline = Date.now() + RESULT_WAIT_MS
    while (Date.now() < deadline) {
      const r = await browserTest.evalJs(extractScript()).catch(() => null)
      if (r && (r.found || r.captcha)) { data = r; break }
      if (r && r.text && /没有|未找到|无相关|暂无/.test(r.text)) { data = r; break }
      await new Promise((res) => setTimeout(res, 800))
    }
    if (!data) {
      // 兜底取一次
      data = await browserTest.evalJs(extractScript()).catch(() => ({ found: false, text: '（无法读取结果区）' }))
    }

    // 5) 翻页（若请求非首页且结果区存在分页）
    if (page && Number(page) > 1 && data && data.found) {
      const turned = await browserTest
        .evalJs(
          `(function(){
            var links = Array.prototype.slice.call(document.querySelectorAll('.el-pager li, [class*="pager"] li, a[class*="page"]'));
            for (var i=0;i<links.length;i++){ if(links[i].textContent.trim()==='${Number(page)}'){ links[i].click(); return true } }
            return false
          })()`
        )
        .catch(() => false)
      if (turned) {
        await new Promise((res) => setTimeout(res, 1500))
        data = await browserTest.evalJs(extractScript()).catch(() => data)
      }
    }

    // 6) 格式化
    if (data && data.captcha) {
      return {
        success: true,
        captchaRequired: true,
        result:
          '⚠️ 国家法律法规数据库的检索需要输入验证码。已为你打开「网页测试」窗口并停在验证码页面，' +
          '请在窗口内手动输入验证码完成检索；完成后可再次发起相同关键词的检索。',
      }
    }
    if (!data || !data.found) {
      const hint = data && data.text ? '页面返回片段：' + data.text.slice(0, 260) : ''
      const dbg =
        `[输入诊断] 定位选择器=${sel}；输入框值=${inputValue || '(空)'}；强制注入=${forced}；补点搜索按钮=${searchBtnClicked || false}`
      let dumpTxt = ''
      if (forced || !inputValue) {
        const dump = await browserTest.evalJs(dumpPageInputsScript()).catch(() => null)
        if (dump) dumpTxt = '\n[页面结构] ' + JSON.stringify(dump)
      }
      return {
        success: true,
        found: false,
        result:
          `在国家法律法规数据库官网未检索到「${keyword}」的结果。\n${hint ? hint + '\n' : ''}${dbg}${dumpTxt}\n` +
          '请勿仅凭官网未搜到就断言该法规不存在或非公开——可能原因：① 关键词需调整（用全称或发文字号）；② 地方性法规可能尚未被该库收录；③ 关键词未真正提交（见输入诊断）。\n' +
          '下一步建议：换更精确的关键词重试 / 对地方性法规改用 search_web 定向检索当地人大、政府公报的官方原文（.gov.cn 域名）并下载核对 / 或咨询执业律师。',
      }
    }

    const lines = [`# 国家法律法规数据库检索结果：『${keyword}』（第 ${Number(page) || 1} 页，共 ${data.count} 条）`, '']
    data.items.forEach((it, idx) => {
      lines.push(`## ${idx + 1}. ${it.title || '（无标题）'}`)
      if (it.meta) lines.push(`- 信息：${it.meta}`)
      if (it.desc) lines.push(`- 摘要：${it.desc}`)
      if (it.href) lines.push(`- 详情链接：${it.href}`)
      lines.push('')
    })
    lines.push('---')
    lines.push('来源：国家法律法规数据库 https://flk.npc.gov.cn/ （公开数据，具体条文以官网原文及执业律师意见为准）')

    return { success: true, found: true, count: data.count, result: lines.join('\n') }
  } catch (err) {
    return { success: false, error: `legal_npc_search 执行失败：${err && err.message ? err.message : String(err)}` }
  }
}

// 把 API 检索结果格式化为给 AI 的 markdown（含 bbbs、时效性与下载指引）
function formatApiRows({ keyword, page, total, rows }) {
  const lines = [`# 国家法律法规数据库检索结果：『${keyword}』（第 ${Number(page) || 1} 页，共 ${total} 条）`, '']
  rows.forEach((it, idx) => {
    lines.push(`## ${idx + 1}. ${it.title || '（无标题）'}`)
    const meta = [it.gbrq ? `公布：${it.gbrq}` : '', it.sxrq ? `施行：${it.sxrq}` : '', it.flxz || ''].filter(Boolean).join(' ／ ')
    if (meta) lines.push(`- 信息：${meta}`)
    if (it.zdjgName) lines.push(`- 制定机关：${it.zdjgName}`)
    if (it.sxx != null) lines.push(`- 时效性编码（sxx=${it.sxx}，数值含义以官网条目标注为准）`)
    lines.push(`- 法规 ID（bbbs）：${it.bbbs}`)
    lines.push(`- 获取 docx 全文：调用 download_url，url = 「https://flk.npc.gov.cn/law-search/download/pc?format=docx&bbbs=${it.bbbs}」，name = 「${(it.title || '法规').replace(/[\\/:*?"<>|]/g, '_')}.docx」`)
    lines.push('')
  })
  lines.push('---')
  lines.push('来源：国家法律法规数据库 https://flk.npc.gov.cn/（纯接口检索；同名多版本命中时，优先选择时效性对应「现行有效」（对照官网标注）且公布日期最新者，具体条文以官网原文及执业律师意见为准）')
  return lines.join('\n')
}

// 主入口：先走纯 HTTP API（快、无需浏览器）；失败（网络/超时/5xx/WAF 拦截）再退回浏览器站内搜索。
// 降级时把"接口失败原因"标注进结果，让用户/模型/日志知道这次结果来自浏览器兜底而非纯接口。
async function legalNpcSearch(args = {}) {
  const keyword = String(args.query || '').trim()
  if (!keyword) return { success: false, error: 'legal_npc_search 缺少 query 参数' }

  // 归一化 API 失败原因（供降级标注与最终报错复用）
  const reasonOf = (r) => {
    if (!r) return '接口无响应'
    if (r.timeout) return r.error || `接口请求超时（>25s）`
    if (r.networkError) return r.error || '网络请求失败'
    if (r.httpStatus != null) return `接口返回 HTTP ${r.httpStatus}`
    if (r.blocked) return '接口返回非 JSON（可能被反爬 / WAF 拦截）'
    return r.error || '接口返回未知错误'
  }

  let r = null
  try {
    r = await npcSearchList({ query: keyword, page: args.page, searchType: 2 })
  } catch (err) {
    // npcSearchList 现不应抛（postJsonOnce 已吞掉网络/超时异常），此处仅作最后防线
    r = { success: false, error: err && err.message ? err.message : String(err) }
  }

  if (r && r.success) {
    if (!r.rows || !r.rows.length) {
      return {
        success: true,
        found: false,
        result:
          `国家法律法规数据库未检索到「${keyword}」相关法规（已通过官网接口真实检索，非页面读取失败）。\n` +
          '可能原因：① 名称不完整（换全称/发文字号重试）；② 官网尚未收录该法规。下一步：换关键词重试 / 对地方性法规用 search_web 找当地人大或政府公报的官方原文（.gov.cn）下载核对 / 咨询执业律师。',
      }
    }
    return {
      success: true,
      found: true,
      api: true,
      count: r.total,
      result: formatApiRows({ keyword, page: args.page, total: r.total, rows: r.rows }),
    }
  }

  // API 失败 → 浏览器站内搜索兜底，并透明标注降级原因
  const apiFailReason = reasonOf(r)
  const degradeNote = `⚠️ 官网纯接口检索失败——${apiFailReason}；已自动改用浏览器站内搜索兜底。\n\n`
  try {
    const b = await legalNpcSearchWithBrowser(args)
    if (b && b.success) {
      // 浏览器兜底成功：在结果开头补降级说明；浏览器自身报错（error 分支）则原样返回并携带原因
      if (typeof b.result === 'string' && b.result) {
        return { ...b, result: degradeNote + b.result, degraded: true, apiFailReason }
      }
      return { ...b, degraded: true, apiFailReason }
    }
    return { ...b, apiFailReason }
  } catch (err2) {
    return {
      success: false,
      error: `legal_npc_search 失败：官网接口 ${apiFailReason}；浏览器兜底亦失败：${err2 && err2.message ? err2.message : err2}`,
    }
  }
}

module.exports = { legalNpcSearch }
