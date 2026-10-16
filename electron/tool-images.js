// ============================================================
//  tool-images —— 工具产出图片的「侧通道」（工具结果 → 下一轮 user 消息）
// ------------------------------------------------------------
//  为什么必须有它（2026-10-05）：
//  OpenAI 兼容的 Chat Completions 协议里，`role:'tool'` 的 content **只能是字符串**，
//  没有任何图像通道（Anthropic 的 tool_result 与 OpenAI 的 Responses API 才支持数组，
//  里面能放 image/input_image）。于是模型能「看见」的图原先只有两条入口 ——
//  ① 用户把 https 图片直链贴进对话（fs-safe.imageUrlFromText）；
//  ② 用户把本地图片当附件发（fs-safe.localImagePart）。
//  两条都只作用于**最后一条 user 消息**，且都在请求组装那一刻一次性完成。
//  工具（browser_read_images）在网页里抓到的图因此无处可去，只能退化成文字描述。
//
//  做法：另开一条 sidecar（与 tool-activity.js 同款思路，不改 messages 的结构约束）——
//  工具把**已经编码好的** image_url part 暂存在这里；chat.js 在下一轮请求前把它们
//  连同提醒文本合并成**同一条** user 消息发出去（绝不能新开一条 —— 连着两条 user
//  消息部分网关直接 400）。
//
//  ⚠️ 刻意不落盘：part 里是 base64 data URL，一张降采样图 200~400KB 字符。
//  写进 turn.json 会顶穿 MAX_SNAPSHOT_BYTES → 落盘直接失败 → 反而把整份续跑快照丢掉
//  （"宁可少存图，也不能丢工具序列"）。代价：被中断后再点「继续」，那一轮的图片不会重放；
//  但工具结果里的图片清单（序号/alt/尺寸/源 URL）在快照里，需要时重新调一次
//  browser_read_images 即可。
//
//  生命周期：以会话为键，chat.js 在**每次 run 开始**清空（防上一轮残留 / 被中断的 run 污染），
//  在工具循环里 take（取出即清，不会重复注入）。
// ============================================================
const crypto = require('crypto')

// 单次注入的图片上限。与 fs-safe 的 MAX_IMAGES_PER_MESSAGE 同值（都是 4），
// 但**刻意不共用常量**：那条管的是"用户附件最多 4 张"，这条管的是"工具回灌最多 4 张"，
// 两条通道将来要各自放宽时不该互相绑住。
const MAX_INJECT_IMAGES = 4
// 单次注入的字符预算。**这是纯请求体积的闸**，不是 token 闸 ——
// 图像 token 按像素算（长边 1280 的图约 1.4k token/张，与 base64 长度无关）。
// 定 4MB 的依据（真实 Electron 实测）：降采样到 1280 后一张彩色图 JPEG q82 约 15~50 万字符，
// 4 张最多约 2MB；留一倍余量给"某张图特别花"的情况。
// ⚠️ 这个预算**曾经把用户的图静默丢掉**：PNG 源在降采样后仍按 PNG 编码（无损），
// 一张 2000×1500 转出来 249 万字符 → 撞 2MB 预算被丢 → 模型说"我看不到图"。
// 根因已在 fs-safe.encodeImagePart 修掉（大 PNG 落回 JPEG），这里顺手放宽以免再误伤。
const MAX_INJECT_CHARS = 4 * 1024 * 1024

// convId -> [{ hash, label, part }]
const pending = new Map()

function partUrl(part) {
  return part && part.image_url && typeof part.image_url.url === 'string' ? part.image_url.url : ''
}

function hashUrl(url) {
  return crypto.createHash('sha1').update(url).digest('hex')
}

/**
 * 暂存工具抓到的图片，等下一轮请求注入。
 * @param {string} convId 会话 id（与工具 ctx.convId 同源）
 * @param {Array<{label?: string, part: object}>} items
 * @returns {{accepted: number, duplicates: number, dropped: number, total: number}}
 */
function stashImages(convId, items) {
  const out = { accepted: 0, duplicates: 0, dropped: 0, total: 0 }
  const list = Array.isArray(items) ? items : []
  out.total = list.length
  if (!convId || list.length === 0) return out

  const bucket = pending.get(convId) || []
  const seen = new Set(bucket.map((it) => it.hash))
  let chars = bucket.reduce((sum, it) => sum + partUrl(it.part).length, 0)

  for (const item of list) {
    const part = item && item.part
    const url = partUrl(part)
    if (!url) {
      out.dropped++
      continue
    }
    const hash = hashUrl(url)
    if (seen.has(hash)) {
      out.duplicates++
      continue
    }
    if (bucket.length >= MAX_INJECT_IMAGES || chars + url.length > MAX_INJECT_CHARS) {
      out.dropped++
      continue
    }
    bucket.push({ hash, label: String((item && item.label) || '图片'), part })
    seen.add(hash)
    chars += url.length
    out.accepted++
  }

  if (bucket.length) pending.set(convId, bucket)
  else pending.delete(convId)
  return out
}

/**
 * 取出并清空该会话待注入的图片（返回顺序 = 暂存顺序，即工具的排序结果）。
 * @returns {Array<{hash: string, label: string, part: object}>}
 */
function takeImages(convId) {
  if (!convId) return []
  const bucket = pending.get(convId)
  if (!bucket || bucket.length === 0) return []
  pending.delete(convId)
  return bucket
}

function clearImages(convId) {
  if (convId) pending.delete(convId)
}

function pendingCount(convId) {
  const bucket = convId ? pending.get(convId) : null
  return bucket ? bucket.length : 0
}

/**
 * 图片清单文本 —— 作为**文字 part** 和图片 part 一起塞进同一条 user 消息。
 * 为什么清单也要发：① 模型知道每张图是什么（来源 + alt + 尺寸），不会张冠李戴；
 * ② 这一条文本会被续跑快照保留（图片本身不保留），续跑时至少还有清单可查。
 * @param {Array<{label: string}>} items
 */
function renderImageNote(items) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return ''
  const lines = list.map((it, i) => `${i + 1}. ${it.label || '图片'}`)
  return [
    `【图片】以下 ${list.length} 张图已作为图像附在本条消息中，你可以直接看到：`,
    ...lines,
    '（这就是它们的真实内容 —— 不要再把它们当纯文本推测，也不要说你看不到图片。需要更多张或换一张，再调用 browser_read_images。）',
  ].join('\n')
}

module.exports = {
  MAX_INJECT_IMAGES,
  MAX_INJECT_CHARS,
  stashImages,
  takeImages,
  clearImages,
  pendingCount,
  renderImageNote,
}
