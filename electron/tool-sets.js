// ============================================================
//  tool-sets —— 按角色（以及按"是不是子代理"）划分的工具集常量与纯函数
//
//  为什么单独成文件（2026-10-24）：
//   子代理也要用到「哪些工具算该角色的工具」这份判定，但加载链是
//     main.js -> chat.js -> tools/index.js -> sub-agent.js
//   子代理若 require(chat) 就会在 chat.js 尚未加载完时拿到空对象
//   （AGENTS.md 记录的循环依赖坑：解构出 undefined）。
//   所以把常量与纯判定搬到这里：**本模块不 require 任何项目内模块**，谁都能安全地先取它。
//
//  ⚠️ 开源版与上游（企业版）的差异（2026-10-24 移植时确认）：
//   企业版有 dev 角色的工具白名单，子代理必须与它取交集（否则 dev 子代理会拿到
//   13 个 browser_* / ERP / 法务工具：白付 schema token，两个并行子代理还会抢同一个
//   测试 BrowserWindow）。**开源版不做工具收窄** —— settings.role 恒为 dev、
//   主 Agent 拥有全部工具（见 chat.js「开源版：不做工具收窄」），所以这里
//   DEV_TOOL_NAMES 刻意保持 null（= 不收窄），子代理行为与原先完全一致：只减 BLOCKED_TOOLS。
//   将来若要给开源版加白名单，只需把 DEV_TOOL_NAMES 赋成 Set 即可（本模块与调用方都无需再改）。
// ============================================================

/**
 * 当前角色的工具白名单。开源版为 **null**（不收窄）—— 判据见 isToolAllowedForSubAgent。
 */
const DEV_TOOL_NAMES = null

/**
 * 一个工具能不能下发给**子代理**。
 *
 * @param {string} name 工具名
 * @param {{role?: string, blocked?: Set<string>}} o
 *   role    —— 当前角色（state.settings.role）；白名单非 null 时按其收窄
 *   blocked —— 子代理一律不可用的名单（tools/subagent-policy.js 的 BLOCKED_TOOLS）
 * @returns {boolean}
 */
function isToolAllowedForSubAgent(name, { role, blocked } = {}) {
  if (!name) return false
  if (blocked && blocked.has(name)) return false
  // 白名单为 null -> 该角色不做收窄（开源版恒为此分支），与「只减 BLOCKED」完全等价。
  if (DEV_TOOL_NAMES && !DEV_TOOL_NAMES.has(name)) return false
  return true
}

/**
 * 过滤子代理的工具定义列表（TOOLS_DEFINITION 的形态）。
 * @param {Array<{type:string, function:{name:string}}>} tools
 * @param {{role?: string, blocked?: Set<string>}} o
 */
function filterSubAgentTools(tools, o = {}) {
  if (!Array.isArray(tools)) return []
  return tools.filter((t) => isToolAllowedForSubAgent(t && t.function && t.function.name, o))
}

module.exports = {
  DEV_TOOL_NAMES,
  isToolAllowedForSubAgent,
  filterSubAgentTools,
}
