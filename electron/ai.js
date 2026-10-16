// ============================================================
//  OpenAI 兼容调用工具 —— JSON mode 请求 + 会话标题生成
//  callJson 是通用入口,会话标题 / 摘要压缩(code in context.js)等复用。
// ============================================================
const { fetchWithRetry } = require('./net-retry')
const state = require('./state')
const crypto = require('crypto')

/**
 * 结构化输出（JSON mode）—— response_format: { type: 'json_object' }
 * 让模型直接产出合法 JSON,再解析成强类型对象。
 */
async function callJson({ key, model, messages, maxTokens = 512, signal, onRetry } = {}) {
  const { getApiBaseUrl } = require('./settings')
  const response = await fetchWithRetry(
    `${getApiBaseUrl()}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'x-opencode-session': crypto.randomUUID(),
      },
      body: JSON.stringify({
        model,
        messages,
        response_format: { type: 'json_object' },
        max_tokens: maxTokens,
      }),
      signal,
    },
    { onRetry }
  )
  if (!response.ok) {
    const errText = await response.text().catch(() => 'Unknown error')
    throw new Error(`API error ${response.status}: ${errText}`)
  }
  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content || ''
  return JSON.parse(content)
}

// 用模型为会话生成简短标题（JSON mode）。失败返回 ''，调用方保留截断兜底。
// DeepSeek json_object 模式要求提示词里出现 "json" 字样。
// 与历史语义一致:使用 settings 的 legacy alias(apiKey/model)。
async function generateConversationTitle(firstUserText) {
  const { DEFAULT_MODEL_ID } = require('./settings')
  const key = state.settings.apiKey
  const model = state.settings.model || DEFAULT_MODEL_ID
  if (!key) return ''
  const data = await callJson({
    key,
    model,
    messages: [
      {
        role: 'system',
        content:
          '你是会话标题生成器。根据用户的第一条消息，用中文生成一个简洁的对话标题（不超过 20 个字），不要引号、不要解释、不要多余内容。请用 json 格式输出，只输出一个 JSON 对象：{"title":"标题"}',
      },
      { role: 'user', content: String(firstUserText).slice(0, 500) },
    ],
    maxTokens: 64,
  })
  const title = typeof data?.title === 'string' ? data.title.trim() : ''
  if (!title || title.length > 40) return '' // 防御：空或异常超长的结果丢弃
  return title.replace(/["'“”‘’]/g, '')
}

module.exports = { callJson, generateConversationTitle }