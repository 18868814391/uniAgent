// ============================================================
//  tools/download —— download_url：从官方源直链下载文件到本地
//
//  为什么需要它：法务检索不必每次开内置浏览器做 UI 操作。
//  国家法律法规数据库（flk.npc.gov.cn）提供纯接口下载：
//    https://flk.npc.gov.cn/law-search/download/pc?format=docx&bbbs=<法规ID>
//  该接口无 WAF 拦截，返回 JSON { data: { url: <OSS 签名直链> } }，
//  第二步从 JSON 中取出直链（flkoss.obs-bj2.cucloud.cn）即可下载 docx/doc/pdf。
//  其它官方原文（地方人大 / 政府公报 .gov.cn 附件 docx/pdf）也可直接下载。
//
//  安全（防 SSRF）：
//   - 仅允许 http(s)；
//   - 用户传入的 URL 域名白名单：*.gov.cn / *.npc.gov.cn（官方域）；
//   - flk 下载接口第二跳的 OSS 直链只取自该接口响应 JSON 的 data.url，
//     不接受用户直接传入的任意 OSS/内网域名；并防御性校验第二跳直链
//     必须是公网 https（拒绝回环/私网/内网地址，防止误用 data.urlIn 等内网直链）；
//   - 大小上限 MAX_BYTES、超时 45s、输出仅落到 browser-downloads（fs-safe 白名单）。
// ============================================================
const path = require('path')
const fs = require('fs')
const { getBrowserDownloadsDir } = require('../settings')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const MAX_BYTES = 60 * 1024 * 1024 // 60MB，法规文件远小于此，防御恶意大文件
const TIMEOUT_MS = 45000

function isAllowedOfficialHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/:\d+$/, '')
  return h === 'gov.cn' || h.endsWith('.gov.cn') || h === 'npc.gov.cn' || h.endsWith('.npc.gov.cn')
}

function sanitizeFileName(name) {
  const s = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim()
    .slice(0, 180)
  return s || `download-${Date.now()}`
}

function uniquePath(dir, filename) {
  const ext = path.extname(filename)
  const base = path.basename(filename, ext)
  let p = path.join(dir, filename)
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base}(${i})${ext}`)
  return p
}

// 下载单个 URL 的内容（含 45s 超时、HTTP 状态/响应体错误、大小上限）。
// 超时与网络错误翻译成可读文案（Node fetch abort 默认报 "The operation was aborted"，用户/模型看不懂）。
async function fetchBuf(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let buf
  let type = ''
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Referer: 'https://flk.npc.gov.cn/' },
    })
    if (!resp || !resp.ok) {
      const status = resp ? resp.status : 'ERR'
      let snippet = ''
      if (resp) snippet = String(await resp.text().catch(() => '')).trim().slice(0, 200)
      throw new Error(`HTTP ${status}${snippet ? `：${snippet}` : ''}`)
    }
    type = String(resp.headers.get('content-type') || '')
    const b = Buffer.from(await resp.arrayBuffer())
    if (b.length > MAX_BYTES) {
      throw new Error(`文件过大（${b.length} bytes > ${MAX_BYTES}），已中止`)
    }
    buf = b
  } catch (e) {
    const msg = e && e.message ? e.message : String(e)
    if (e && (e.name === 'AbortError' || /abort/i.test(msg))) {
      throw new Error(`请求超时（已等待 ${TIMEOUT_MS / 1000}s）`)
    }
    if (e instanceof Error) throw e
    throw new Error(msg)
  } finally {
    clearTimeout(timer)
  }
  return { buf, type }
}

/**
 * download_url —— 从官方直链下载文件（法务法规原文 / 政府公报附件）。
 * @param {object} args
 * @param {string} args.url   下载直链（*.gov.cn / *.npc.gov.cn）；
 *                            也可传 flk 下载接口 https://flk.npc.gov.cn/law-search/download/pc?format=docx&bbbs=<id>，
 *                            工具会自动解析其 JSON 并取签名直链下载。
 * @param {string} [args.name] 保存文件名（含扩展名，如 "xxx.docx"），不传则按响应推断
 * @returns {Promise<object>} { success, file, filename, bytes, url? }
 */
async function downloadUrl({ url, name }) {
  const raw = String(url || '').trim()
  if (!/^https?:\/\//i.test(raw)) {
    return { success: false, error: 'download_url 需要 http(s) 直链' }
  }
  let u
  try {
    u = new URL(raw)
  } catch {
    return { success: false, error: 'download_url url 不是合法 URL' }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { success: false, error: 'download_url 仅支持 http/https' }
  }
  if (!isAllowedOfficialHost(u.hostname)) {
    return {
      success: false,
      error: `download_url 域名不在官方白名单内：${u.hostname}（仅允许 *.gov.cn / *.npc.gov.cn 官方域；其它来源请用浏览器兜底或先定位到官方页面）`,
    }
  }

  // 实际落盘下载的目标 URL（初始为传入直链；flk 下载接口第二跳时替换为 OSS 签名直链）。
  // 放在 try 外，便于 catch 里识别"是否已进入 OSS 直链"以给出过期提示。
  let targetUrl = raw

  try {
    const first = await fetchBuf(raw)

    // flk 下载接口返回 JSON { data: { url: OSS 签名直链 } } → 第二跳只取响应里的 url
    let buf = first.buf
    let type = first.type
    const looksJson =
      type.includes('json') || /^[\s]*\{/.test(buf.slice(0, 512).toString('utf-8'))
    if (looksJson && /law-search\/download/i.test(raw)) {
      let data = null
      try {
        data = JSON.parse(buf.toString('utf-8'))
      } catch {}
      const d = data && data.data ? data.data : null
      const link = d && typeof d.url === 'string' ? d.url.trim() : ''
      if (!link || !/^https?:\/\//i.test(link)) {
        // 官方接口异常，或仅返回内网 data.urlIn（实测形如 http://example-internal-host:38080/...）——内网地址一律拒绝使用
        const hasUrlIn = !!(d && typeof d.urlIn === 'string' && /^https?:\/\//i.test(d.urlIn.trim()))
        const body = buf.toString('utf-8').slice(0, 300)
        return {
          success: false,
          error: hasUrlIn
            ? `flk 下载接口未返回公网签名直链 data.url（仅返回内网 data.urlIn，禁止使用内网地址下载）。${body}`
            : `flk 下载接口返回异常（可能 ID 无效或格式不支持）：${body}`,
        }
      }
      // 第二跳防御：官方 JSON 里的直链也必须拒绝回环/私网/内网地址（防接口异常时下发 urlIn 等造成 SSRF）
      let secondLinkOk = false
      try {
        const u2 = new URL(link)
        const host = (u2.hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
        const isPrivateOrLoopback =
          host === 'localhost' ||
          host.endsWith('.localhost') ||
          host === '::1' ||
          /^(127\.|10\.|192\.168\.|169\.254\.)/.test(host) ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(host) || // 172.16.0.0/12
          (/^[0-9a-f:]+$/i.test(host) && host.includes(':')) // 其余 IPv6 一律拒绝（官方直链为 IPv4 域名）
        secondLinkOk = u2.protocol === 'https:' && !isPrivateOrLoopback
      } catch {}
      if (!secondLinkOk) {
        return {
          success: false,
          error: `flk 下载接口返回的直链非公网 https 地址（可能是内网 data.urlIn），已拒绝下载：${link.slice(0, 120)}`,
        }
      }
      const second = await fetchBuf(link)
      targetUrl = link
      buf = second.buf
      type = second.type
    }

    // 文件名优先级：调用方 name > 直链 filename= 参数 > URL 尾段 > 时间戳
    let filename = ''
    if (name) {
      filename = String(name)
    } else {
      const fm = String(targetUrl).match(/filename=([^&]+)/i)
      filename = fm ? decodeURIComponent(fm[1]) : ''
      if (!filename) {
        filename = decodeURIComponent(String(targetUrl).split('?')[0].split('/').pop() || '')
      }
    }
    filename = sanitizeFileName(filename)
    const dir = getBrowserDownloadsDir()
    fs.mkdirSync(dir, { recursive: true })
    const savePath = uniquePath(dir, filename)
    fs.writeFileSync(savePath, buf)
    return {
      success: true,
      file: savePath,
      filename: path.basename(savePath),
      bytes: buf.length,
      contentType: type,
      url: targetUrl,
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    // 若失败已发生在 OSS 签名直链（非官方域的第二跳）上，提示直链约 1 小时有效、过期需重新解析
    let hint = ''
    try {
      const host = new URL(targetUrl).hostname.toLowerCase()
      if (!isAllowedOfficialHost(host)) {
        hint = '。OSS 签名直链约 1 小时有效，若已过期请重新调用 flk 下载接口（law-search/download/pc?bbbs=<法规ID>）获取新直链后重试'
      }
    } catch {}
    return { success: false, error: `download_url 执行失败：${msg}${hint}` }
  }
}

module.exports = { downloadUrl, isAllowedOfficialHost }
