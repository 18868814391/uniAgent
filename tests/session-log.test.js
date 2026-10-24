// ============================================================
//  tests\session-log.test.js —— 会话日志（electron/session-log.js）
//
//  这是「模型可见 ⟺ 已记录」的落点：每一轮的完整消息序列（含 assistant.tool_calls
//  与 tool 结果）都落盘；渲染层 history 只是它的一次投影。
//
//  锁住的不变量：
//   1) appendTurn 落的是**完整序列**，system 被丢掉、tool_calls 与 tool 结果保留
//   2) deriveMessages 只投影用户 / AI 的文本 —— 空 assistant（纯工具调用轮）不产生空泡
//   3) matchResumableTurn：只有「最后一轮没正常完成 + 调过工具 + history 与投影一致」才命中
//      （一致性的口径与 turn-snapshot 完全相同，避免两套映射漂移）
//   4) 正常完成的轮次不留续跑入口；日志超限丢最旧的轮次并记 truncated
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const ELECTRON_DIR = path.join(__dirname, '..', 'electron')
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-session-log-'))

const stub = (request, exports) => {
  const id = require.resolve(request, { paths: [ELECTRON_DIR] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}
stub('electron', { app: { getPath: () => userDataDir } })

const sessionLog = require(path.join(ELECTRON_DIR, 'session-log.js'))
const turnSnapshot = require(path.join(ELECTRON_DIR, 'turn-snapshot.js'))

const NUDGE = '请继续完成你刚才正在进行的任务。'

// 一轮真实的工具调用序列：user → assistant(tool_calls) → tool
function toolTurn(userText = '读一下 a.md', id = 'call_1') {
  return [
    { role: 'user', content: userText },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{"path":"a.md"}' } }],
    },
    { role: 'tool', tool_call_id: id, content: '{"success":true,"content":"FILE_CONTENT"}' },
    { role: 'assistant', content: 'a.md 里是 FILE_CONTENT。' },
  ]
}

test('appendTurn 落完整序列：tool_calls 与 tool 结果都在，system 被丢掉', () => {
  const convId = 'log-full'
  const ok = sessionLog.appendTurn(convId, {
    messages: [{ role: 'system', content: 'stale system' }, ...toolTurn()],
    endReason: 'aborted',
    abortedBy: 'user',
    inputHash: 'h1',
  })
  assert.equal(ok, true)

  const log = sessionLog.readLog(convId)
  assert.equal(log.v, sessionLog.LOG_VERSION)
  assert.equal(log.turns.length, 1)
  const turn = log.turns[0]
  assert.equal(turn.seq, 1)
  assert.equal(turn.endReason, 'aborted')
  assert.equal(turn.abortedBy, 'user')
  assert.equal(turn.inputHash, 'h1')
  // 4 条：user + assistant(tool_calls) + tool + assistant 文本
  assert.equal(turn.messages.length, 4)
  assert.ok(!turn.messages.some((m) => m.role === 'system'), 'system 不进日志（每轮按当前开关重建）')
  assert.equal(turn.messages[1].tool_calls[0].id, 'call_1')
  assert.match(turn.messages[2].content, /FILE_CONTENT/)
})

test('deriveMessages：只投影用户 / AI 文本，工具序列与空 assistant 都不出现', () => {
  const seq = [
    { role: 'user', content: '读一下 a.md' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'FILE_CONTENT' },
    { role: 'assistant', content: '读到了。' },
    { role: 'user', content: [{ type: 'text', text: '图片在这' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
  ]
  const derived = sessionLog.deriveMessages(seq)
  assert.deepEqual(derived, [
    { role: 'user', content: '读一下 a.md' },
    { role: 'assistant', content: '读到了。' },
    { role: 'user', content: '图片在这' },   // 多模态消息只留文字
  ])
  assert.ok(!derived.some((m) => m.content === ''), '不该出现空 content 的泡')
})

test('日志投影与渲染层 history 同口径：hashHistory 能对上（续跑一致性靠它）', () => {
  const convId = 'log-hash'
  sessionLog.appendTurn(convId, { messages: toolTurn(), endReason: 'aborted' })
  const log = sessionLog.readLog(convId)
  const derived = sessionLog.deriveMessages(log)
  assert.deepEqual(derived, [
    { role: 'user', content: '读一下 a.md' },
    { role: 'assistant', content: 'a.md 里是 FILE_CONTENT。' },
  ])
  // 与 turn-snapshot 的历史指纹同一实现 → 同一份 history 必须同指纹
  assert.equal(
    turnSnapshot.hashHistory(derived),
    turnSnapshot.hashHistory([
      { role: 'user', content: '读一下 a.md' },
      { role: 'assistant', content: 'a.md 里是 FILE_CONTENT。' },
    ]),
  )
})

test('matchResumableTurn：history 与投影一致 + 上一轮未完成 + 调过工具 → 命中', () => {
  const convId = 'log-match'
  sessionLog.appendTurn(convId, { messages: toolTurn(), endReason: 'aborted', abortedBy: 'user' })

  const history = [
    { role: 'user', content: '读一下 a.md' },
    { role: 'assistant', content: 'a.md 里是 FILE_CONTENT。' },
  ]
  const hit = sessionLog.matchResumableTurn(convId, {
    messages: [...history, { role: 'user', content: NUDGE }],
  })
  assert.ok(hit, '日志应能接上断点')
  assert.equal(hit.abortedBy, 'user')
  assert.equal(hit.turnSeq, 1)
  // 回放的是完整序列（含工具结果），不是投影
  assert.equal(hit.messages.filter((m) => m.role === 'tool').length, 1)

  // 渲染层把半截 assistant 补进历史也要容忍（与快照口径一致）
  assert.ok(
    sessionLog.matchResumableTurn(convId, {
      messages: [...history, { role: 'assistant', content: '我看一下…' }, { role: 'user', content: NUDGE }],
    }),
  )

  // 历史被改过 → 绝不命中（否则会回放到别的上下文里）
  assert.equal(
    sessionLog.matchResumableTurn(convId, {
      messages: [{ role: 'user', content: '换个问题' }, { role: 'user', content: NUDGE }],
    }),
    null,
  )
})

test('matchResumableTurn：正常完成的轮次不留续跑入口', () => {
  const convId = 'log-complete'
  sessionLog.appendTurn(convId, { messages: toolTurn(), endReason: 'complete' })
  const history = [
    { role: 'user', content: '读一下 a.md' },
    { role: 'assistant', content: 'a.md 里是 FILE_CONTENT。' },
  ]
  assert.equal(
    sessionLog.matchResumableTurn(convId, { messages: [...history, { role: 'user', content: NUDGE }] }),
    null,
  )
})

test('matchResumableTurn：最后一轮没调过工具（纯文本中断）不命中', () => {
  const convId = 'log-notext'
  sessionLog.appendTurn(convId, {
    messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '在的' }],
    endReason: 'aborted',
  })
  assert.equal(
    sessionLog.matchResumableTurn(convId, {
      messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '在的' }, { role: 'user', content: NUDGE }],
    }),
    null,
  )
})

test('多轮追加：seq 递增，fullSequence 按轮次拼接', () => {
  const convId = 'log-multi'
  sessionLog.appendTurn(convId, { messages: toolTurn('第一轮', 'c1'), endReason: 'complete' })
  sessionLog.appendTurn(convId, { messages: toolTurn('第二轮', 'c2'), endReason: 'complete' })
  const log = sessionLog.readLog(convId)
  assert.deepEqual(log.turns.map((t) => t.seq), [1, 2])
  const seq = sessionLog.fullSequence(log)
  assert.equal(seq[0].content, '第一轮')
  assert.equal(seq.filter((m) => m.role === 'tool').length, 2)
})

test('日志超限：丢最旧的轮次并记 truncated（丢这件事必须是显式的）', () => {
  const convId = 'log-trim'
  // 每轮塞一条大消息，让总字节超 MAX_LOG_BYTES 不现实（64MB），改判 MAX_TURNS
  const filler = 'x'.repeat(200)
  for (let i = 0; i < sessionLog.MAX_TURNS + 3; i++) {
    sessionLog.appendTurn(convId, {
      messages: [{ role: 'user', content: `${i}-${filler}` }, { role: 'assistant', content: `ok ${i}` }],
      endReason: 'complete',
    })
  }
  const log = sessionLog.readLog(convId)
  assert.equal(log.turns.length, sessionLog.MAX_TURNS)
  assert.equal(log.truncated, 3)
  assert.match(log.turns[0].messages[0].content, /^3-/, '保留的应是最近的轮次')
})

test('读不存在 / 损坏的日志一律返回 null（调用方自然退回普通流程）', () => {
  assert.equal(sessionLog.readLog(''), null)
  assert.equal(sessionLog.readLog('never-existed'), null)

  const convId = 'log-corrupt'
  fs.mkdirSync(path.dirname(sessionLog.getLogPath(convId)), { recursive: true })
  fs.writeFileSync(sessionLog.getLogPath(convId), '{not json', 'utf-8')
  assert.equal(sessionLog.readLog(convId), null)
  assert.equal(sessionLog.matchResumableTurn(convId, { messages: [{ role: 'user', content: NUDGE }] }), null)

  // 版本不符同样忽略
  fs.writeFileSync(sessionLog.getLogPath(convId), JSON.stringify({ v: 999, turns: [] }), 'utf-8')
  assert.equal(sessionLog.readLog(convId), null)
})

test('clearLog 删掉日志文件；空 messages 不写盘', () => {
  const convId = 'log-clear'
  assert.equal(sessionLog.appendTurn(convId, { messages: [] }), false, '空序列没有落盘价值')
  assert.equal(fs.existsSync(sessionLog.getLogPath(convId)), false)

  sessionLog.appendTurn(convId, { messages: toolTurn(), endReason: 'aborted' })
  assert.equal(fs.existsSync(sessionLog.getLogPath(convId)), true)
  assert.equal(sessionLog.clearLog(convId), true)
  assert.equal(fs.existsSync(sessionLog.getLogPath(convId)), false)
  assert.equal(sessionLog.clearLog(convId), false)
})
