// ============================================================
//  Sub-Agent —— 独立 LLM 循环引擎
//  从主 Agent 的 chat.js 简化而来：保留流式 API 调用 + 工具循环，
//  去掉 IPC 事件推送、reasoning 转发、兜底答案、空闲超时等。
//  子 Agent 运行期间对渲染层不可见，仅通过 chat:subagent 事件通知状态。
// ============================================================
const state = require('./state')
const crypto = require('crypto')
const { TOOLS_DEFINITION } = require('./tool-schemas')
const { fetchWithRetry } = require('./net-retry')
const settings = require('./settings')
const { looksLikeTextToolCall, parseTextToolCalls } = require('./text-tool-call')
// 只读策略（纯常量 + 纯函数，无依赖 → 不会加剧上面的循环依赖问题）
const subagentPolicy = require('./tools/subagent-policy')
// 工具集判定（纯常量 + 纯函数，不 require 项目内其它模块）：名单只在这一处维护，
// 不在本文件另写一份（见 AGENTS.md「工具集与写盘诊断」段）。
const { filterSubAgentTools } = require('./tool-sets')

// ⚠️ 循环依赖陷阱（2026-09-20 实测确认，勿改回顶层解构）
//   加载链：main.js → chat.js → tools/index.js → sub-agent.js →（若此处 require './tools'）
//   本模块是在 tools/index.js 尚未加载完时被 require 的，那一刻 tools/index.js 的
//   module.exports 仍是空对象 {}，顶层解构出来的 executeToolCall 会是 undefined，
//   导致子 Agent 的每一次工具调用都返回 "executeToolCall is not a function"。
//   （此前的写法就是顶层解构，属于长期潜伏的 bug。）
//   修法：不在顶层 require './tools'，改为**调用时**再取 —— 那时 tools/index.js 已加载完成。
let _toolsModule = null
function callTool(tc, ctx) {
  if (!_toolsModule || typeof _toolsModule.executeToolCall !== 'function') {
    _toolsModule = require('./tools')
    if (typeof _toolsModule.executeToolCall !== 'function') {
      throw new Error('工具执行器未就绪（tools/index.js 尚未加载完成）')
    }
  }
  return _toolsModule.executeToolCall(tc, ctx)
}

const { getActiveProfile } = settings

// ============================================================
//  上下文削减（2026-10-24 补）—— 子代理原先**没有任何**削减机制
//
//  事故形态：子代理把某个目录 dump 一遍、或跑一条输出很大的只读命令，
//  结果全量进 currentMessages，窗口直接顶爆 → 后面每一步都 400，
//  而它只有 10 分钟墙钟兜底，主 Agent 等来的是"超时/半截结论"，白烧一整轮。
//  主循环早就有的两件套（spill 落盘 + 更早结果折叠）在子代理里完全缺失。
//
//  折叠窗口取「其他类」的小值：子代理是只读检索角色，几乎全是 grep/read/ls 的结果，
//  不像改码那样需要同时对照多份源码原文（那份大窗口只给主循环的 read_file）。
// ============================================================
const SUB_AGENT_TURN_START = 2   // currentMessages 前两条是 [system, user]
const SUB_AGENT_FOLD_KEEP = 3    // 兜底窗口（取不到 chat 的窗口自适应函数时用）

/** 单份结果超预算 → 原文落盘，请求里换成「首尾预览 + 路径」。失败一律回原文。 */
function spillResult(convId, tc, content) {
  try {
    const spilled = spill.maybeSpillToolResult({
      conversationId: convId,
      toolName: tc.function.name,
      callId: tc.id,
      content,
    })
    return spilled !== null ? spilled : content
  } catch {
    return content
  }
}

/** 折叠本轮更早的工具结果。同时把「本轮累计多少条被折掉」退化处理成不影响主流程。 */
function foldSubAgentResults(messages, contextWindow) {
  try {
    // 顶层 require('./chat') 会踩加载期循环依赖（见文件头），这里调用时再取
    const chat = require('./chat')
    if (typeof chat.foldOldToolResults !== 'function') return 0
    const keep = typeof chat.otherKeepForContext === 'function'
      ? chat.otherKeepForContext(contextWindow)
      : SUB_AGENT_FOLD_KEEP
    return chat.foldOldToolResults(
      messages,
      SUB_AGENT_TURN_START,
      keep,
      chat.TOOL_RESULT_FOLD_MIN,
      { contextWindow },
    )
  } catch {
    return 0
  }
}

// 子代理的工具循环**没有步数上限**（2026-10-05）：改由墙钟超时（下方 SUB_AGENT_TIMEOUT_MS）
// 与「进展停滞收口」（loopPolicy）双保险。原来的 30 轮硬上限会把「读得慢但一直在推进」
// 的检索任务平白掐断，而又没有超时那样的部分成果兜底语义。
const SUB_AGENT_TIMEOUT_MS = 10 * 60 * 1000 // 10 分钟

// 子 Agent 不可用的工具（名字表见 tools/subagent-policy.js，与执行层的拒绝名单同一份）：
//   · spawn_sub_agent / get_sub_agent_results —— 防递归派生
//   · ask_user —— 子代理不能挂起等用户（主 Agent 会陪着一起等）
//   · update_todos —— 子代理的 ctx.convId 就是**主会话**的 id（见下面 callTool 调用处），
//     它写清单会直接覆盖主 Agent 的清单，接着 chat.js 会把「子任务的那份清单」当成主任务的进度
//     每轮回显给主 Agent —— 主模型会照着一份不属于它的计划走。子代理任务短、界面不可见，本来也不需要清单。
//   · write_file / edit_file / delete_file / write_skill / write_memory（2026-10-04 补）——
//     子代理是只读调研角色，且**完全不经过 tools/guard.js**（guard 只在 chat.js 主循环对 dev 角色调用）。
//     dev 角色下 fs-safe 的 isPathAllowed 直接放行，等于"无确认框、无守卫、无记录的任意写盘"。
//   过滤只是第一道；tools/index.js 里另有 ctx.subAgent 硬拒绝兜底（含 execute_command 只读白名单）。
const BLOCKED_TOOLS = subagentPolicy.BLOCKED_TOOLS

// 工具循环的收口策略：与主 Agent 共用同一套「无步数上限、按进展收口」的判据。
// 子代理额外有 10 分钟墙钟上限（见 SUB_AGENT_TIMEOUT_MS），但**没有步数上限** ——
// 收口只发生在「连续多轮没拿到新信息」时（子代理是只读检索角色，原地打转是典型失败形态）。
const loopPolicy = require('./tool-loop-policy')
// 超大工具结果落盘（2026-10-24 补）：子代理原先没有任何削减机制，见下方 foldSubAgentResults 注释
const spill = require('./spill')

/**
 *  从工具结果里拼一段「已完成工作摘要」。两个用途：
 *  ① 模型全程没产出正文（原有兜底）；
 *  ② 超时 / 异常被中止，只能回传半成品（2026-09-21 新增）。
 *  取最后 n 条工具结果，单条截断到 500 字符。
 */
function summarizeToolResults(messages, n = 3) {
  return messages
    .filter(m => m.role === 'tool' && m.content)
    .slice(-n)
    .map(m => {
      try {
        const parsed = JSON.parse(m.content)
        return parsed.success !== false
          ? JSON.stringify(parsed).slice(0, 500)
          : parsed.error || String(m.content).slice(0, 500)
      } catch {
        return String(m.content).slice(0, 500)
      }
    })
}

/**
 *  被中止前「已经拿到的东西」：正文 + 工具产出摘要。
 *  没有它，超时的子代理对主 Agent 来说等于完全白跑 —— 只回一句"超时"。
 */
function buildPartialResult(messages, content) {
  const parts = []
  if (content && content.trim()) parts.push(content.trim())
  const digest = summarizeToolResults(messages, 5)
  if (digest.length > 0) parts.push(`（中止前的工具产出摘要）\n${digest.join('\n')}`)
  return parts.join('\n\n')
}

/**
 *  运行一个子 Agent 的完整 LLM + 工具循环。
 *  返回 Promise<{ success, result, error, duration, rounds }>
 */
function runSubAgentLoop({ subAgentId, task, description, convId, sender, parentController, profile }) {
  const startTime = Date.now()
  // 独立的 AbortController：SUB_AGENT_TIMEOUT_MS 墙钟超时 + 继承父级中断信号
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SUB_AGENT_TIMEOUT_MS)
  // 继承父级 AbortController 的中断信号
  if (parentController) {
    parentController.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  const key = profile.apiKey
  const baseUrl = profile.baseUrl || settings.DEFAULT_BASE_URL
  const model = profile.model || settings.DEFAULT_MODEL_ID

  // 精简的系统提示词：角色上下文 + 任务 + 检索纪律。
  // 子代理是「裸跑」的：它不继承主 Agent 的完整角色提示词（会让每轮 prefill 暴涨），
  // 但必须知道「仓库在哪 + 怎么检索」—— 否则它会在大仓库里 repo-wide 乱搜，
  // 一直跑到墙钟到点被 abort（2026-09-21 实测的失败形态）。
  // 检索纪律一段参照 opencode 的 explore 子代理提示词（packages/opencode/src/agent/prompt/explore.txt）。
  let roleContext = ''
  try {
    roleContext = typeof settings.buildSubAgentContext === 'function' ? settings.buildSubAgentContext() : ''
  } catch (e) {
    console.warn('[sub-agent] buildSubAgentContext failed:', e && e.message ? e.message : e)
  }
  const systemContent = [
    '你是一个子代理（Sub-Agent），专门执行一个独立子任务。你不继承主 Agent 的角色提示词，',
    '只按本提示词与任务描述行事，也拿不到主 Agent 的对话历史——任务里没写的背景就是没有。',
    `任务：${task}`,
    description ? `说明：${description}` : '',
    roleContext,
    '',
    '## 检索纪律',
    '- 先用 `glob_files` 按文件名模式定位候选，再用 `grep_code` 按内容正则缩小范围，',
    '  确定具体路径后才 `read_file` —— 不要一上来就读整个目录。',
    '- `list_directory` 看目录结构；`execute_command` 只放行**只读命令**',
    '  （`ls`/`cat`/`head`/`tail`/`wc`/`grep`/`rg`/`git log`/`git diff`/`git status` 等，',
    '  含 `> | ; & $ ` 等 shell 元字符的一律被拒）。',
    '  **子代理不能 `cd`**（会被拒）。要看某个仓库的 git 历史，一律写成 `git -C <仓库绝对路径> log --oneline -20` 这种形态。',
    '- 只读原则（**由应用强制执行，不是建议**）：不要创建、修改、删除任何文件。',
    '  `write_file` / `edit_file` / `delete_file` / `write_skill` / `write_memory` 都不会下发给你；',
    '  即使硬凑出工具名也会被直接拒绝。需要落盘的改动，写进你的最终回答交给主 Agent 去做。',
    '- 在给定范围内搜。范围不清楚时先用一次目录列表确认，再决定往哪搜。',
    '- 目标不明确时，宁可多换几个关键词，也不要把整个仓库倒一遍。',
    '',
    '## 输出',
    '- 最终回答里涉及的文件一律给**绝对路径**，便于主 Agent 直接使用。',
    '- 只讲发现与结论，不要复述检索过程，不要用 emoji。',
    '完成后请给出你的发现和结论作为最终回答。不要使用 spawn_sub_agent 或 get_sub_agent_results 工具。',
    `当前日期：${new Date().toISOString().slice(0, 10)}`,
  ].filter(Boolean).join('\n')

  // 过滤掉子 Agent 不可用的工具。
  // 名单与判定统一在 electron/tool-sets.js（不在本文件另写一份）：
  //   · BLOCKED_TOOLS（tools/subagent-policy.js）—— 写类 / 递归派生 / ask_user / update_todos；
  //   · 若该角色定义了工具白名单，这里会自动按它收窄（开源版无白名单，行为同旧版）。
  const availableTools = filterSubAgentTools(TOOLS_DEFINITION, {
    role: state.settings.role,
    blocked: BLOCKED_TOOLS,
  })

  // ⚠️ 这三个变量必须在 try 之外声明：超时 / 异常时 catch 要用它们回传「已完成的部分成果」。
  //    早期版本声明在 try 内，catch 拿不到 → 只能整段丢弃，主 Agent 白等一整轮（也看不到跑了多少轮）。
  let currentMessages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: task },
  ]
  let fullContent = ''
  let rounds = 0
  // 收口状态（无步数上限 · 按进展收口）：见 electron/tool-loop-policy.js
  const loopState = loopPolicy.newState()

  const promise = (async () => {
    try {
      for (let loop = 0; ; loop++) {
        if (controller.signal.aborted) break
        // 绝对刹车：防死循环的保险丝，正常任务碰不到（子代理另有 10 分钟墙钟上限）
        if (loop >= loopPolicy.ABSOLUTE_STEP_CEILING) {
          console.warn(`[sub-agent] 触达绝对刹车 ${loopPolicy.ABSOLUTE_STEP_CEILING} 轮，强制结束工具循环`)
          break
        }
        // 收口：连续多轮没拿到新信息 → 直接跳出，让下方把已有成果作为结论返回
        const decision = loopPolicy.decideRound(loopState, { loop })
        if (decision.action === 'stop') {
          console.warn(`[sub-agent] 收口：连续 ${loopState.stall} 轮未取得新信息，停止工具循环`)
          break
        }
        rounds = loop + 1

        const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
            'x-opencode-session': convId || crypto.randomUUID(),
          },
          body: JSON.stringify({
            model,
            messages: currentMessages,
            tools: availableTools,
            tool_choice: 'auto',
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: controller.signal,
        }, { maxRetries: 2 }) // 子 Agent 重试次数比主 Agent 少

        if (!response.ok) {
          const errText = await response.text().catch(() => 'Unknown error')
          throw new Error(`API error ${response.status}: ${errText}`)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let toolCalls = []
        let responseContent = ''
        let streamFinished = false

        // SSE 解析（与 chat.js 相同模式）
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (controller.signal.aborted) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.startsWith('data: ')) continue
            const data = trimmed.slice(6)
            if (data === '[DONE]') continue

            try {
              const chunk = JSON.parse(data)
              const delta = chunk.choices?.[0]?.delta
              const finishReason = chunk.choices?.[0]?.finish_reason

              if (delta?.content) {
                responseContent += delta.content
                fullContent += delta.content
              }

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index
                  if (!toolCalls[idx]) {
                    toolCalls[idx] = {
                      id: tc.id || `call_${idx}`,
                      type: 'function',
                      function: { name: '', arguments: '' },
                    }
                  }
                  if (tc.id) toolCalls[idx].id = tc.id
                  if (tc.function?.name) toolCalls[idx].function.name += tc.function.name
                  if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments
                }
              }

              if (finishReason === 'stop' || finishReason === 'tool_calls') {
                streamFinished = true
              }
            } catch {
              // skip parse errors
            }
          }
        }

        if (controller.signal.aborted) break

        // 文本形态工具调用还原：网关（典型 opencode zen 转发的 mimo 系）间歇性不走原生
        // function calling，把调用当正文吐出来。子 Agent 没有"结束本轮"的提示 UI，
        // 不还原的话它会直接以半截正文收尾、主 Agent 看到的是一段没干活的结果。
        // 还原不出来就保持原样（保持旧的 break 行为），不额外报错。
        if (toolCalls.length === 0 && looksLikeTextToolCall(responseContent)) {
          const parsed = parseTextToolCalls(responseContent)
          if (parsed.calls.length > 0) {
            const removed = responseContent.length - parsed.cleaned.length
            // fullContent 是逐 delta 累加的，这里按"被抹掉的部分在尾部"回退等长字符
            if (removed > 0) fullContent = fullContent.slice(0, Math.max(0, fullContent.length - removed))
            responseContent = parsed.cleaned
            parsed.calls.forEach((c, i) => {
              toolCalls.push({
                id: `txtcall_${Date.now().toString(36)}_${i}`,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
              })
            })
            console.warn(`[sub-agent] 已还原 ${parsed.calls.length} 个文本形态工具调用：${parsed.calls.map((c) => c.name).join('、')}`)
          }
        }

        // 添加 assistant 消息
        if (responseContent) {
          currentMessages.push({ role: 'assistant', content: responseContent })
        }

        // 无工具调用 → 循环结束
        if (toolCalls.length === 0) break
        // 构建带 tool_calls 的 assistant 消息
        const assistantMsg = { role: 'assistant', content: responseContent || null }
        assistantMsg.tool_calls = toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }))
        if (responseContent) currentMessages.pop()
        currentMessages.push(assistantMsg)

        // 逐个执行工具调用
        for (const tc of toolCalls) {
          if (controller.signal.aborted) break

          let result
          try {
            // 注意：用 callTool（内部惰性 require），不要用顶层解构的 executeToolCall —— 循环依赖下它是 undefined
            // subAgent:true 是给 handler 的硬标记：会话级状态类工具（如 update_todos）必须据此拒绝，
            // 否则子代理会写进主会话的状态里（convId 是主会话的）。
            result = await callTool(tc, { sender, convId, controller, subAgent: true })
          } catch (err) {
            result = JSON.stringify({ success: false, error: err.message })
          }
          currentMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            // 超大结果先落盘换成「首尾预览 + 路径」（spill），再由下方 fold 折叠更早的条数。
            // 顺序不能反：fold 折的是"本轮更早的条数"，spill 换进去的预览本身很短、不会命中阈值。
            content: spillResult(convId, tc, result),
          })
        }

        // 折叠本轮更早的工具结果（2026-10-24 补）
        foldSubAgentResults(currentMessages, profile.contextWindow)

        // 收口中间件：本轮有「此前没用过的 (工具名, 参数)」才算有进展。
        // 子代理是只读检索角色，原地打转（反复扫同一处）是它的典型失败形态。
        loopPolicy.noteRound(loopState, {
          calls: toolCalls.map((tc) => ({ name: tc.function.name, args: tc.function.arguments })),
        })
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1)
      // 如果模型没有产生文本输出，从最后的工具结果中提取摘要
      if (!fullContent) {
        const toolResults = summarizeToolResults(currentMessages)
        fullContent = toolResults.length > 0
          ? `（子代理通过工具完成任务，以下为工具产出摘要）\n${toolResults.join('\n')}`
          : '（子代理未产生任何输出）'
      }
      return { success: true, result: fullContent, duration, rounds }
    } catch (err) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1)
      // 超时 / 异常**不再整段丢弃**：把被中止前的正文与工具产出一起回传，
      // 主 Agent 至少能拿到半成品接着推进（旧行为是全程白等，只回一句"超时"）。
      const partial = buildPartialResult(currentMessages, fullContent)
      if (controller.signal.aborted && !parentController?.signal.aborted) {
        // 自身超时（返回真实 rounds，旧版本这里硬编码 0，事后无法复盘）
        return {
          success: false,
          error: `子代理超时（${SUB_AGENT_TIMEOUT_MS / 1000}秒）`,
          result: partial,
          duration,
          rounds,
        }
      }
      return { success: false, error: err.message || '子代理执行失败', result: partial, duration, rounds }
    } finally {
      clearTimeout(timeout)
    }
  })()

  return { promise, controller, task, description, convId, startedAt: startTime }
}

// ============================================================
//  工具处理器（注册到 TOOL_HANDLERS）
// ============================================================

/**
 *  spawn_sub_agent 工具处理器
 *  立即返回 { subAgentId, status: 'started' }，子 Agent 在后台异步运行。
 */
function handleSpawnSubAgent(args, ctx) {
  // 并行上限校验：同一会话最多同时运行 2 个子 Agent
  const runningCount = [...state.subAgents.values()].filter(
    s => s.convId === ctx.convId && s.status === 'running'
  ).length
  if (runningCount >= 2) {
    return JSON.stringify({ success: false, error: `已达到并行子代理上限（${runningCount}/2），请等待现有子代理完成后再派发。` })
  }

  const id = `sub_${++state.subAgentSeq}`
  const profile = getActiveProfile(ctx.profileId)
  const run = runSubAgentLoop({
    subAgentId: id,
    task: args.task,
    description: args.description || '',
    convId: ctx.convId,
    sender: ctx.event && ctx.event.sender,
    parentController: ctx.controller,
    profile,
  })

  state.subAgents.set(id, {
    convId: ctx.convId,
    task: args.task,
    description: args.description || '',
    status: 'running',
    promise: run.promise,
    controller: run.controller,
    startedAt: run.startedAt,
    completedAt: null,
    result: null,
  })

  // 通知渲染层
  if (ctx.event && ctx.event.sender) {
    try {
      ctx.event.sender.send('chat:subagent', {
        convId: ctx.convId,
        subAgentId: id,
        task: args.task,
        description: args.description || '',
        // 状态词必须与 state.subAgents 内部状态、以及完成事件用的词表一致：
        // 渲染层按 'running' 判断"执行中"，此前这里发 'started' 导致派发瞬间
        // 界面上 runningCount=0 而兜底分支谎报"已完成"。
        status: 'running',
        startedAt: run.startedAt,
      })
    } catch {
      // 渲染层不可用时静默
    }
  }

  return JSON.stringify({ success: true, subAgentId: id, status: 'started' })
}

/**
 *  get_sub_agent_results 工具处理器
 *  阻塞等待当前会话的所有子 Agent 完成，返回汇总结果。
 */
async function handleGetSubAgentResults(args, ctx) {
  const active = []
  for (const [id, sub] of state.subAgents.entries()) {
    if (sub.convId === ctx.convId && sub.status === 'running') {
      active.push({ id, sub })
    }
  }

  if (active.length === 0) {
    // 兜底：清理本会话所有非 running 的残留条目
    for (const [id, sub] of state.subAgents.entries()) {
      if (sub.convId === ctx.convId && sub.status !== 'running') {
        state.subAgents.delete(id)
      }
    }
    return JSON.stringify({
      success: true,
      results: [],
      note: '没有活跃的子代理。请先使用 spawn_sub_agent 派发子任务。',
    })
  }

  // 标记为等待中，禁用空闲计时器
  state.subAgentsPending.set(ctx.convId, true)

  try {
    const results = await Promise.all(active.map(async ({ id, sub }) => {
      try {
        const result = await sub.promise
        sub.status = result.success ? 'completed' : 'error'
        sub.result = result
        sub.completedAt = Date.now()

        // 通知渲染层
        if (ctx.event && ctx.event.sender) {
          try {
            ctx.event.sender.send('chat:subagent', {
              convId: ctx.convId,
              subAgentId: id,
              status: sub.status,
              result: result.success ? result.result : result.error,
              duration: result.duration,
              completedAt: sub.completedAt,
            })
          } catch {}
        }

        // 失败（超时/异常）时把子代理被中止前「已完成的部分成果」一并带上。
        // 否则主 Agent 只看到一句"超时"，那 10 分钟的等待就完全白费了。
        const partial = !result.success && result.result && String(result.result).trim()
          ? String(result.result).trim()
          : ''
        const resultText = result.success
          ? result.result
          : (partial
            ? `错误: ${result.error}\n（以下是该子代理被中止前已完成的部分成果，可能不完整，可作为线索参考）\n${partial}`
            : `错误: ${result.error}`)

        return {
          subAgentId: id,
          task: sub.task,
          description: sub.description,
          status: sub.status,
          result: resultText,
          duration: result.duration,
          rounds: result.rounds,
        }
      } catch (err) {
        sub.status = 'error'
        sub.completedAt = Date.now()
        return {
          subAgentId: id,
          task: sub.task,
          description: sub.description,
          status: 'error',
          result: `错误: ${err.message}`,
          duration: '0',
          rounds: 0,
        }
      }
    }))

    // 有子代理失败时补一句明确引导：让模型接着自己干，而不是把任务原样重派（会再撞一次超时）。
    // 旧版本只回结构化错误，模型只能靠自己临场反应 —— 表现为"卡 10 分钟后突然改口说自己来"。
    const payload = { success: true, results }
    const failed = results.filter(r => r.status !== 'completed')
    if (failed.length > 0) {
      payload.note = `有 ${failed.length} 个子代理未成功完成（${failed.map(r => r.subAgentId).join('、')}）。`
        + '请基于上面返回的部分成果继续推进，或改用主循环自己完成；'
        + '不要把这个子任务原样重新派发一次（大概率会再撞一次超时）。'
    }
    return JSON.stringify(payload)
  } finally {
    state.subAgentsPending.delete(ctx.convId)
    // 延迟清理已完成的子 Agent 条目，防止 Map 无限增长
    const completedIds = active.map(({ id }) => id)
    setTimeout(() => {
      for (const id of completedIds) {
        const sub = state.subAgents.get(id)
        if (sub && sub.status !== 'running') {
          state.subAgents.delete(id)
        }
      }
    }, 30_000)
  }
}

/**
 *  中止指定会话的所有子 Agent（由 chat.js 中断时调用）
 */
function abortSubAgentsForConversation(convId) {
  for (const [id, sub] of state.subAgents.entries()) {
    if (sub.convId === convId && sub.status === 'running') {
      sub.controller.abort()
      sub.status = 'aborted'
      sub.completedAt = Date.now()
    }
  }
}

module.exports = {
  handleSpawnSubAgent,
  handleGetSubAgentResults,
  abortSubAgentsForConversation,
  // 导出给测试断言用：子代理的工具黑名单是可回归的不变量（见 tests/sub-agent-tools.test.js）
  BLOCKED_TOOLS,
}
