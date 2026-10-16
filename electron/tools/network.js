// ============================================================
//  tools/network —— 联网搜索（Bing 优先、DuckDuckGo 兜底）
//  在国内网络环境可用的搜索引擎中抓取结果并解析为结构化列表。
// ============================================================

/**
 * Search the web by fetching from search engines that work in China.
 * Primary: Bing (cn.bing.com). Falls back to DuckDuckGo as secondary.
 */
async function searchWeb(query) {
  const maxResults = 6

  // Search providers to try in order (first one that returns results wins)
  const providers = [
    { name: 'Bing', url: `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}` },
    { name: 'DuckDuckGo', url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}` },
  ]

  for (const provider of providers) {
    try {
      console.log(`[searchWeb] trying ${provider.name}: ${provider.url}`)
      const response = await fetch(provider.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) {
        console.log(`[searchWeb] ${provider.name} HTTP ${response.status}`)
        continue
      }
      const html = await response.text()
      const results = parseSearchResults(provider.name, html, maxResults)
      if (results.length > 0) {
        console.log(`[searchWeb] ${provider.name} returned ${results.length} results`)
        return JSON.stringify({ success: true, results })
      }
      console.log(`[searchWeb] ${provider.name} returned 0 results, trying next`)
    } catch (err) {
      console.log(`[searchWeb] ${provider.name} error: ${err.message}`)
      // Continue to next provider
    }
  }

  // All providers failed
  return JSON.stringify({
    success: true,
    results: [],
    note: '搜索暂不可用，可能是网络限制导致。你可以稍后重试，或在设置中配置搜索 API。',
  })
}

/**
 * Parse search results from HTML based on provider.
 */
function parseSearchResults(provider, html, maxResults) {
  if (provider === 'Bing') {
    return parseBingResults(html, maxResults)
  }
  return parseDuckDuckGoResults(html, maxResults)
}

/**
 * Parse Bing search results HTML (cn.bing.com format).
 * Bing results use <li class="b_algo"> with <h2><a href="...">title</a></h2> and <p>snippet</p>
 */
function parseBingResults(html, maxResults) {
  const results = []
  // Match each result block: <li class="b_algo">...</li>
  const blocks = html.match(/<li[^>]*class="b_algo"[^>]*>[\s\S]*?<\/li>/gi) || []
  for (const block of blocks) {
    // Extract URL from <a href="..."> inside h2
    const urlMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/i)
    // Extract title - text inside <a> within h2
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)
    // Extract snippet from <p> with class b_lineclamp2
    const snippetMatch = block.match(/<p[^>]*class="[^"]*b_lineclamp2[^"]*"[^>]*>([\s\S]*?)<\/p>/i)

    if (!urlMatch) continue

    const url = urlMatch[1]
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : ''
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : ''

    if (!title) continue

    results.push({ title, url, snippet })
    if (results.length >= maxResults) break
  }
  return results
}

/**
 * Parse DuckDuckGo lite search results HTML.
 */
function parseDuckDuckGoResults(html, maxResults) {
  const results = []
  const resultBlocks = html.match(/<a[^>]+rel="nofollow"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi) || []

  for (const block of resultBlocks) {
    const urlMatch = block.match(/href="([^"]+)"/i)
    const titleMatch = block.replace(/<[^>]+>/g, '').trim()
    if (!urlMatch || !titleMatch) continue

    const url = urlMatch[1]
    if (url.startsWith('/') || url.startsWith('#')) continue

    const blockIndex = html.indexOf(block)
    const afterBlock = html.slice(blockIndex + block.length, blockIndex + block.length + 500)
    const snippetMatch = afterBlock.match(/<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i)
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : ''

    results.push({ title: titleMatch, url, snippet })
    if (results.length >= maxResults) break
  }
  return results
}

module.exports = { searchWeb }