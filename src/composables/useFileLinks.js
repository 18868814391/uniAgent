// 文件链接处理：把 AI 回复 / md 预览里的本地文件路径转成可点击链接，并对外部链接打标。
// 点击事件统一走容器级委托（resolveFileLinkClick），由组件转发给主进程打开文件，
// 不向单个链接绑定监听器，避免流式渲染下监听器累积。

// 常见文档/产物扩展名
const FILE_EXT = '(?:xlsx|xls|csv|md|markdown|docx?|pdf|txt|png|jpe?g|svg|json|ya?ml|html?|pptx?|zip)'

// 盘符绝对路径：C:\Users\syf\Desktop\a.xlsx / C:/Users/.../a.xlsx（目录段允许含空格）
const PATH_WIN = /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\r\n]+\.(?:xlsx|xls|csv|md|markdown|docx?|pdf|txt|png|jpe?g|svg|json|ya?ml|html?|pptx?|zip)\b/
// 家目录路径：~\.local-ai\skills\a.md
const PATH_TILDE = /~[\\/][A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)*\.(?:xlsx|xls|csv|md|markdown|docx?|pdf|txt|png|jpe?g|svg|json|ya?ml|html?|pptx?|zip)\b/

const FILE_PATH_G = new RegExp(`${PATH_WIN.source}|${PATH_TILDE.source}`, 'gi')
const FILE_PATH_ONE = new RegExp(`${PATH_WIN.source}|${PATH_TILDE.source}`, 'i')

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function makeFileLink(p) {
  return `<a class="file-link" href="#" data-kind="file" data-path="${escapeHtml(p)}" title="点击打开：${escapeHtml(p)}">📄 ${escapeHtml(p)}</a>`
}

// 整段文本是否就是一条文件路径（用于 <code> 整段命中）
function looksLikeWholePath(s) {
  const m = s.match(FILE_PATH_ONE)
  return !!(m && m[0] === s)
}

/**
 * 装饰 markdown-body 容器内的链接与文件路径：
 *  - 已有 <a>：http(s)/mailto → data-kind="external"；本地路径 → data-kind="file"；
 *    其他 scheme（如 javascript:）摘掉 href 防止危险导航。
 *  - 文本节点（含内联 <code>）里形如文件路径的内容 → 包成可点击的 <a class="file-link">。
 * 代码块（<pre>）保持原样，避免把命令/示例误转成链接。
 */
export function decorateMarkdownFileLinks(container) {
  if (!container) return

  // 1) 已有 <a> 打标 / 拦截
  const anchors = container.querySelectorAll('a[href]')
  for (const a of anchors) {
    const href = a.getAttribute('href') || ''
    if (/^(https?:|mailto:|tel:)/i.test(href)) {
      a.dataset.kind = 'external'
    } else if (/^[A-Za-z]:[\\/]/.test(href) || /^~[\\/]/.test(href) || /^file:\/\//i.test(href)) {
      let p = href
      if (/^file:\/\//i.test(p)) {
        // file:///C:/path → C:/path
        p = decodeURIComponent(p.replace(/^file:\/\/\/?/, '').replace(/^\/([A-Za-z]:)/, '$1'))
      }
      a.dataset.kind = 'file'
      a.dataset.path = p
    } else {
      a.removeAttribute('href')
      a.removeAttribute('target')
    }
  }

  // 2) 文本节点里的路径 → 可点击链接
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const jobs = []
  while (walker.nextNode()) {
    const node = walker.currentNode
    const parent = node.parentNode
    if (!parent || parent.closest('a')) continue
    if (parent.tagName === 'PRE') continue // 代码块保持原样
    const raw = node.textContent
    if (!raw) continue
    const isCode = parent.tagName === 'CODE'
    if (isCode && looksLikeWholePath(raw.trim())) {
      jobs.push({ node, html: makeFileLink(raw.trim()) })
      continue
    }
    const replaced = raw.replace(FILE_PATH_G, (m) => makeFileLink(m))
    if (replaced !== raw) jobs.push({ node, html: replaced })
  }
  for (const j of jobs) {
    const span = document.createElement('span')
    span.innerHTML = j.html
    j.node.parentNode.replaceChild(span, j.node)
  }
}

/**
 * 容器级点击委托：解析被点击的链接。
 * 返回 { kind: 'file'|'external', value }；不是已打标的链接时返回 null。
 */
export function resolveFileLinkClick(e) {
  const a = e.target && e.target.closest && e.target.closest('a')
  if (!a || !a.dataset || !a.dataset.kind) return null
  if (a.dataset.kind === 'file') return { kind: 'file', value: a.dataset.path }
  if (a.dataset.kind === 'external') return { kind: 'external', value: a.getAttribute('href') }
  return null
}
