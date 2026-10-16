// ============================================================
//  net-health.js 回归测试
//
//  只测纯函数（buildProbeUrl / needsOpencodeSession / classify）与初始状态 ——
//  它们决定了右上角状态点显示什么颜色，判错会直接把「网络正常」显示成「很差」。
//
//  net-health.js 顶层只 require('./state')（纯对象，不 require electron），
//  所以这里能在纯 node 下直接 require，不需要塞 require.cache 桩。
//
//  用例里的数字全部来自 2026-10-14 的真实实测：
//    · 5G 出口：3 次新建连接 median 2126ms / max 2475ms / jitter 349ms（判 good）
//    · 内网出口：小请求平时 0.6~0.8s，偶发 6.27s，握手段 tls 0.37~7.6s，偶发打满 20s 超时
//      （判 degraded / bad）
// ============================================================
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const NET_HEALTH = path.join(__dirname, '..', 'electron', 'net-health.js')
const nh = require('../electron/net-health')

test('buildProbeUrl：拼出 /models，去掉尾斜杠，拒绝非法输入', () => {
  assert.strictEqual(nh.buildProbeUrl('https://opencode.ai/zen/go/v1').href, 'https://opencode.ai/zen/go/v1/models')
  assert.strictEqual(nh.buildProbeUrl('https://api.deepseek.com/v1/').href, 'https://api.deepseek.com/v1/models')
  assert.strictEqual(nh.buildProbeUrl('http://127.0.0.1:8899/v1').href, 'http://127.0.0.1:8899/v1/models')
  assert.strictEqual(nh.buildProbeUrl(''), null)
  assert.strictEqual(nh.buildProbeUrl('   '), null)
  assert.strictEqual(nh.buildProbeUrl('not a url'), null)
  assert.strictEqual(nh.buildProbeUrl('ftp://example.com/v1'), null)
  assert.strictEqual(nh.buildProbeUrl(null), null)
  assert.strictEqual(nh.buildProbeUrl(undefined), null)
})

test('needsOpencodeSession：只给 opencode 域名加，仿冒域名不加', () => {
  assert.strictEqual(nh.needsOpencodeSession('opencode.ai'), true)
  assert.strictEqual(nh.needsOpencodeSession('x.opencode.ai'), true)
  assert.strictEqual(nh.needsOpencodeSession('opencode.ai.evil.com'), false)
  assert.strictEqual(nh.needsOpencodeSession('api.deepseek.com'), false)
  assert.strictEqual(nh.needsOpencodeSession(''), false)
  assert.strictEqual(nh.needsOpencodeSession(undefined), false)
})

test('classify：健康基线不得误报（5G 实测样本）', () => {
  // 每次都新建连接，健康基线的单次往返本就有 2s 左右 —— 阈值贴着基线会整片误报
  assert.strictEqual(nh.classify({ configured: true, samples: [2126, 2126, 2475], failures: 0 }), 'good')
  assert.strictEqual(nh.classify({ configured: true, samples: [1063, 951, 1031, 860, 935], failures: 0 }), 'good')
  assert.strictEqual(nh.classify({ configured: true, samples: [4900], failures: 0 }), 'good')
})

test('classify：内网实测特征（平时不慢、偶发卡死）要能报出来', () => {
  // IT 下采 10 次：9 次 0.6~0.8s、1 次 6.27s
  assert.strictEqual(nh.classify({ configured: true, samples: [680, 6270, 770], failures: 0 }), 'degraded')
  // 打满 6s 超时（提前收尾 = 2 次失败）
  assert.strictEqual(nh.classify({ configured: true, samples: [770], failures: 2 }), 'bad')
  assert.strictEqual(nh.classify({ configured: true, samples: [], failures: 3 }), 'bad')
  // 单次失败但拿到了样本
  assert.strictEqual(nh.classify({ configured: true, samples: [700, 800], failures: 1 }), 'degraded')
})

test('classify：阈值边界', () => {
  assert.strictEqual(nh.classify({ configured: true, samples: [9000], failures: 0 }), 'bad')
  assert.strictEqual(nh.classify({ configured: true, samples: [8900], failures: 0 }), 'degraded')
  assert.strictEqual(nh.classify({ configured: true, samples: [5000], failures: 0 }), 'degraded')
  // 抖动（max - median）：4000 - 1200 = 2800 >= 2500 → 报；3600 - 1200 = 2400 → 不报
  assert.strictEqual(nh.classify({ configured: true, samples: [1000, 1200, 4000], failures: 0 }), 'degraded')
  assert.strictEqual(nh.classify({ configured: true, samples: [1000, 1200, 3600], failures: 0 }), 'good')
})

test('classify：未配置 → unconfigured（优先于其它判定）', () => {
  assert.strictEqual(nh.classify({ configured: false, samples: [], failures: 0 }), 'unconfigured')
  assert.strictEqual(nh.classify({ configured: false, samples: [100], failures: 0 }), 'unconfigured')
  assert.strictEqual(nh.classify({ configured: false, samples: [], failures: 3 }), 'unconfigured')
})

test('初始快照是 unknown，且不暴露敏感字段', () => {
  const s = nh.snapshot()
  assert.strictEqual(s.state, 'unknown')
  assert.strictEqual(s.probeState, 'unknown')
  assert.strictEqual(s.chatFailure, null)
  assert.strictEqual(s.configured, false)
  // 快照里绝不能出现 apiKey（它会经 net-health:update 推到渲染层）
  assert.ok(!('apiKey' in s), 'snapshot 不应带 apiKey')
  assert.ok(!('key' in s), 'snapshot 不应带 key')
})

// ---------------------------------------------------------------
//  聊天失败证据（本次新增的通道）
//  起因：用户反馈「对话框已经报错 terminated（ECONNRESET），右上角还是绿的」。
//  查下来探针**其实被触发了**，是它判了 good —— 内网下小请求平时只要 0.7s，
//  真正死的是长连接。所以真实请求的失败必须能直接决定状态点颜色。
// ---------------------------------------------------------------

test('classifyChatFailure：用户实测的那条原文必须判 bad', () => {
  // 前端横幅上的原文就是 describeFetchError 拼出来的 `${message}（${cause.code}）`
  assert.strictEqual(nh.classifyChatFailure({ message: 'terminated（ECONNRESET）', code: 'ECONNRESET' }), 'bad')
  // 只给文案、没有 code 时也要能认出来
  assert.strictEqual(nh.classifyChatFailure({ message: 'terminated（ECONNRESET）' }), 'bad')
  assert.strictEqual(nh.classifyChatFailure({ message: 'terminated' }), 'bad')
  assert.strictEqual(nh.classifyChatFailure({ message: 'fetch failed', code: 'UND_ERR_CONNECT_TIMEOUT' }), 'bad')
})

test('classifyChatFailure：各类网络错误码都判 bad', () => {
  for (const code of [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
    'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
  ]) {
    assert.strictEqual(nh.classifyChatFailure({ message: '', code }), 'bad', `${code} 应判 bad`)
  }
})

test('classifyChatFailure：空闲超时只判轻一档（可能是模型想太久）', () => {
  assert.strictEqual(nh.classifyChatFailure({ message: '等待超时', kind: 'timeout' }), 'degraded')
  assert.strictEqual(nh.classifyChatFailure({ message: '', code: 'ECONNRESET', kind: 'timeout' }), 'degraded')
})

test('classifyChatFailure：非网络类失败一律不抬状态（关键：别乱染红）', () => {
  const notNetwork = [
    'HTTP 400: invalid request',
    'HTTP 401: Incorrect API key provided',
    'HTTP 403: model access is disabled',
    'HTTP 404: model not found',
    '该模型不支持图片，请换模型或取消勾选',
    'API Key 未设置，请在设置中配置 API Key',
    '',
  ]
  for (const m of notNetwork) {
    assert.strictEqual(nh.classifyChatFailure({ message: m }), null, `「${m}」不该判成网络失败`)
  }
  assert.strictEqual(nh.classifyChatFailure({}), null)
  assert.strictEqual(nh.classifyChatFailure(null), null)
})

test('effectiveState：真实失败压过探针的 good（本次需求的核心）', () => {
  const now = 1_000_000
  // 探针说正常，但 10 秒前刚有一次 ECONNRESET
  assert.strictEqual(
    nh.effectiveState({ probeState: 'good', failure: { level: 'bad', at: now - 10_000 }, now }),
    'bad',
  )
  // 空闲超时（degraded）不会把 good 抬成 bad
  assert.strictEqual(
    nh.effectiveState({ probeState: 'good', failure: { level: 'degraded', at: now - 10_000 }, now }),
    'degraded',
  )
})

test('effectiveState：只升不降 —— 探针更差时保持探针结论', () => {
  const now = 1_000_000
  assert.strictEqual(nh.effectiveState({ probeState: 'bad', failure: null, now }), 'bad')
  assert.strictEqual(nh.effectiveState({ probeState: 'good', failure: null, now }), 'good')
  // 探针 bad + 失败证据只是 degraded → 仍取更差的 bad
  assert.strictEqual(
    nh.effectiveState({ probeState: 'bad', failure: { level: 'degraded', at: now - 1000 }, now }),
    'bad',
  )
  assert.strictEqual(
    nh.effectiveState({ probeState: 'degraded', failure: { level: 'bad', at: now - 1000 }, now }),
    'bad',
  )
  // 探针还没出结论时，失败证据也要能立刻染色
  assert.strictEqual(
    nh.effectiveState({ probeState: 'unknown', failure: { level: 'bad', at: now - 1000 }, now }),
    'bad',
  )
  // 没配 Key（压根不会有聊天失败）时不被抬走
  assert.strictEqual(
    nh.effectiveState({ probeState: 'unconfigured', failure: { level: 'bad', at: now - 1000 }, now }),
    'unconfigured',
  )
})

test('effectiveState：失败证据**不过期** —— 用户没关它就不会自己消失', () => {
  const now = 1_700_000_000_000
  // 一年前的失败：只要没被手动清掉，仍然压着探针的 good。
  // （第一版在这里设了 120s TTL，结果「网络异常」气泡过两分钟自己消失了，被用户抓出来。）
  assert.strictEqual(
    nh.effectiveState({ probeState: 'good', failure: { level: 'bad', at: now - 365 * 86400_000 }, now }),
    'bad',
  )
  // 时钟大幅回拨（at 落在未来 > 1s）视为脏数据丢弃，避免一个错时间戳把圆点永久染红
  assert.strictEqual(nh.effectiveState({ probeState: 'good', failure: { level: 'bad', at: now + 60_000 }, now }), 'good')
  assert.strictEqual(nh.effectiveState({ probeState: 'good', failure: { level: 'bad', at: now + 500 }, now }), 'bad')
  // ttlMs 只是留给测试的注入口，生产路径不传（= 不过期）
  assert.strictEqual(nh.effectiveState({ probeState: 'good', failure: { level: 'bad', at: now - 5000 }, now, ttlMs: 1000 }), 'good')
  assert.strictEqual(nh.effectiveState({ probeState: 'good', failure: { level: 'bad', at: now - 500 }, now, ttlMs: 1000 }), 'bad')
})

test('noteChatNetworkFailure：非网络失败不落证据，网络失败立刻带上证据', () => {
  nh.clearChatFailure()
  // 非网络类：什么都不该变
  const s1 = nh.noteChatNetworkFailure({ message: 'HTTP 400: bad request', kind: 'error' })
  assert.strictEqual(s1.chatFailure, null)
  // 网络类：立刻带上证据
  const s2 = nh.noteChatNetworkFailure({ message: 'terminated（ECONNRESET）', code: 'ECONNRESET', kind: 'error' })
  assert.ok(s2.chatFailure, '应记下失败证据')
  assert.strictEqual(s2.chatFailure.level, 'bad')
  assert.ok(String(s2.chatFailure.message).includes('ECONNRESET'))
  // 取 worse-of：只要探针结论不是更差，就该是 bad
  assert.strictEqual(nh.effectiveState({ probeState: 'good', failure: s2.chatFailure }), 'bad')
})

test('clearChatFailure：唯一让警告退出的方式（用户关气泡 / 重新检测说好了）', () => {
  nh.noteChatNetworkFailure({ message: 'terminated（ECONNRESET）', code: 'ECONNRESET' })
  assert.ok(nh.snapshot().chatFailure, '上报后应有证据')
  const cleared = nh.clearChatFailure()
  assert.strictEqual(cleared.chatFailure, null, 'clear 后证据必须消失')
  // 幂等：没有证据时再清一次不该炸
  assert.strictEqual(nh.clearChatFailure().chatFailure, null)
})

test('代码级断言：net-health.js 里不得再有「按时间自动失效」的机制', () => {
  // 这是用户明确要求过的行为（"只有手动关闭了才会消失"）。谁把 TTL 加回来，这里就红。
  const src = fs.readFileSync(NET_HEALTH, 'utf-8')
  assert.ok(
    !/CHAT_FAILURE_TTL_MS|failureFresh/.test(src),
    '失败证据的过期机制被加回来了 —— 气泡会再次自己消失，用户已经因此报过一次 bug',
  )
})

test('导出的常量与接口齐备', () => {
  for (const k of [
    'registerIpc', 'start', 'stop', 'runProbe', 'snapshot',
    'noteChatNetworkFailure', 'clearChatFailure',
    'buildProbeUrl', 'needsOpencodeSession', 'classify', 'classifyChatFailure', 'effectiveState', 'CONST',
  ]) {
    assert.ok(nh[k] !== undefined, `缺少导出 ${k}`)
  }
  assert.strictEqual(nh.CONST.SAMPLES, 3)
  assert.strictEqual(nh.CONST.EARLY_ABORT_FAILURES, 2)
  // 阈值必须满足 degraded < bad，否则中间那一档永远不可达
  assert.ok(nh.CONST.DEGRADED_MAX_MS < nh.CONST.BAD_MAX_MS)
  // 异常时探测应更频繁（更快发现恢复）
  assert.ok(nh.CONST.INTERVAL_BAD_MS < nh.CONST.INTERVAL_GOOD_MS)
  // 失败证据**不设过期**（用户要求：只有手动关才消失）—— 常量不该存在
  assert.ok(!('CHAT_FAILURE_TTL_MS' in nh.CONST), 'CHAT_FAILURE_TTL_MS 又回来了？它会害气泡自己消失')
  // 失败后要很快补探，别让气泡里的数字是上一轮的
  assert.ok(nh.CONST.PROBE_AFTER_FAILURE_MS < nh.CONST.INTERVAL_GOOD_MS)
})
