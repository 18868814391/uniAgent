// ============================================================
//  Turn Messages —— 消息序列归一化 + 历史指纹（纯函数，无副作用）
//
//  为什么单独成一个模块：这两件事被**两处**需要，且必须逐字节一致 ——
//    · turn-snapshot.js（中断续跑快照：存盘前收窄字段、判断 history 是否一致）
//    · session-log.js（会话日志：每轮完整序列落盘、续跑时比对渲染层 history）
//  如果各自实现，两边的「字段收窄口径」或「指纹算法」迟早漂移 —— 一旦漂移，
//  日志投影出来的历史和快照记下的历史就对不上，续跑会静默失效（不报错，只是总不命中）。
//
//  也不能让 session-log 从 turn-snapshot 解构：那会形成加载期耦合，
//  任何只桩掉 turn-snapshot 的测试（chat 系列）都会把 session-log 一起打挂。
// ============================================================

/**
 * 内容收窄成纯文本。
 *
 * 内容可能是数组（多模态消息：text part + image_url part，例如「用户贴了图片」或
 * 「browser_read_images 抓到网页图片后注入的下一轮消息」）。落盘时**只保留文字部分**：
 * base64 图片动辄 200~400KB 一张，写进去必然超体积上限 → 整份记录被丢弃。
 * ⚠️ 也不能整体退化成空串：回放时那条 user 消息会变成空 content，部分网关直接 400。
 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n\n')
  }
  return ''
}

/**
 * 收窄字段：落盘的消息会被原样回放给模型，脏字段（多余的 UI 属性、undefined）一律不进文件。
 * 保留 role / content / tool_calls / tool_call_id（后两者是接口不 400 的前提）。
 * @param {Array} raw
 * @returns {Array}
 */
function normalizeTurnMessages(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((m) => m && typeof m === 'object')
    .map((m) => {
      const out = {
        role: typeof m.role === 'string' ? m.role : 'user',
        content: textOf(m.content),
      }
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        out.tool_calls = m.tool_calls.map((tc) => ({
          id: tc && tc.id ? String(tc.id) : '',
          type: 'function',
          function: {
            name: tc && tc.function && tc.function.name ? String(tc.function.name) : '',
            arguments:
              tc && tc.function && typeof tc.function.arguments === 'string' ? tc.function.arguments : '{}',
          },
        }))
      }
      if (typeof m.tool_call_id === 'string') out.tool_call_id = m.tool_call_id
      return out
    })
}

/**
 * history 指纹：只取 role + content。
 *
 * 渲染层发来的 history 也只有这两个字段，任何一条消息被改动（用户编辑重发、删消息、
 * 换角色新建会话）都会让指纹变化。多模态消息只算文字部分（与 normalizeTurnMessages 同口径）。
 * @param {Array} messages
 * @returns {string} sha1 hex
 */
function hashHistory(messages) {
  const crypto = require('crypto')
  const normalized = (Array.isArray(messages) ? messages : []).map((m) => [
    m && m.role ? String(m.role) : '',
    textOf(m && m.content),
  ])
  return crypto.createHash('sha1').update(JSON.stringify(normalized)).digest('hex')
}

module.exports = { textOf, normalizeTurnMessages, hashHistory }
