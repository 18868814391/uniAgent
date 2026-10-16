// 工具循环收口策略（无最大步数 · 按进展收口）—— 纯函数单测
//
// 背景（2026-10-05 重构）：旧实现是「60 轮硬上限 + 跑满兜底逼答 + 40/45/50/55 轮提醒」。
// 步数与「有没有干成事」无关：长任务被平白截断，模型只能抢在提醒点前收敛。
// 现在内核 `for(;;)` 无步数上限，收口只依据**进展判据**（连续多轮没拿到新信息）。
//
// 这里锁住五条不变量：
//   1) 没有「步数上限」这类常量；只有绝对刹车（防死循环的保险丝，量级远大于任何正常任务）
//   2) 有进展（新签名 / 清单变化）→ stall 清零，绝不收口 —— 长任务不会被误伤
//   3) 停滞阶梯 warn(2) → wrapup(3) → stop(4)，且同级不重复刷提醒
//   4) 软预算点只报「已用轮数」，文案里不出现「共 N 轮 / 上限」这类会误导模型的措辞
//   5) decideRound 只读 state.stall 与 loop 的软预算点，不受任何步数影响
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const policy = require(path.join(__dirname, '..', 'electron', 'tool-loop-policy.js'))
const {
  ABSOLUTE_STEP_CEILING,
  SOFT_BUDGET_MARKS,
  STALL_WARN,
  STALL_WRAPUP,
  STALL_STOP,
  newState,
  sigOf,
  noteRound,
  isSoftMark,
  softBudgetText,
  stallWarnText,
  wrapupText,
  decideRound,
} = policy

// ============================================================
//  没有步数上限
// ============================================================

test('内核没有最大步数：只暴露绝对刹车，量级远大于正常任务', () => {
  assert.equal(typeof ABSOLUTE_STEP_CEILING, 'number')
  assert.ok(ABSOLUTE_STEP_CEILING >= 200, '绝对刹车应是「保险丝」量级，不是预算')
  // 旧实现的 60 轮硬上限必须不存在（也不该换个名字再回来）
  for (const k of Object.keys(policy)) {
    assert.doesNotMatch(k, /MAX_ROUNDS|LOOP_LIMIT|MAX_STEPS|MAX_ITERATIONS/i,
      `策略模块不该再导出步数上限常量：${k}`)
  }
})

test('软预算点：20 / 35 / 50，之后每 25 轮一次；负数与非法入参安全', () => {
  assert.deepEqual(SOFT_BUDGET_MARKS, [20, 35, 50])
  for (const n of [20, 35, 50, 75, 100]) assert.equal(isSoftMark(n), true, `${n} 应是提醒点`)
  for (const n of [0, 1, 19, 21, 34, 36, 49, 51, 74]) assert.equal(isSoftMark(n), false, `${n} 不该提醒`)
  for (const bad of [NaN, undefined, null, -1, Infinity]) assert.equal(isSoftMark(bad), false)
})

test('软预算文案只报已用轮数，不写「共 N 轮 / 上限」', () => {
  const t = softBudgetText(20)
  assert.match(t, /已用掉 20 轮/)
  assert.doesNotMatch(t, /共\s*\d+\s*轮|上限|还剩/, '没有硬上限就不该提「共几轮/还剩几轮」——那会让模型以为还有别的预算')
})

// ============================================================
//  进展判据：新签名 / 清单变化
// ============================================================

test('重复同一 (工具名, 参数) → stall 递增；换个参数立刻清零', () => {
  const st = newState()
  assert.equal(noteRound(st, { calls: [{ name: 'read_file', args: '{"path":"a.js"}' }] }), 0, '首次是新信息')
  assert.equal(noteRound(st, { calls: [{ name: 'read_file', args: '{"path":"a.js"}' }] }), 1, '同参数 → 停滞 1')
  assert.equal(noteRound(st, { calls: [{ name: 'read_file', args: '{"path":"a.js"}' }] }), 2, '同参数 → 停滞 2')
  // 换参数 = 新信息 → 清零
  assert.equal(noteRound(st, { calls: [{ name: 'read_file', args: '{"path":"b.js"}' }] }), 0)
})

test('一轮里只要有一个新签名就算有进展（混杂场景）', () => {
  const st = newState()
  noteRound(st, { calls: [{ name: 'read_file', args: '{"path":"a.js"}' }] })
  const stall = noteRound(st, {
    calls: [
      { name: 'read_file', args: '{"path":"a.js"}' },   // 旧
      { name: 'grep_code', args: '{"pattern":"foo"}' }, // 新
    ],
  })
  assert.equal(stall, 0, '只要有一个新调用就不算停滞')
})

test('不同工具同参数 / 同工具不同参数，都不会被误判成重复', () => {
  const st = newState()
  for (let i = 0; i < 10; i++) {
    assert.equal(noteRound(st, { calls: [{ name: 'read_file', args: `{"path":"f${i}.js"}` }] }), 0)
  }
  assert.equal(noteRound(st, { calls: [{ name: 'grep_code', args: '{"path":"f0.js"}' }] }), 0)
})

test('任务清单变化也算有进展（长任务靠推进清单维持 stall=0）', () => {
  const st = newState()
  const sig1 = '【任务清单】共 3 项，已完成 0 项'
  const sig2 = '【任务清单】共 3 项，已完成 1 项'
  // 首轮只建立基线，不算「变化」
  assert.equal(noteRound(st, { calls: [{ name: 'read_file', args: 'a' }], todoSignature: sig1 }), 0)
  // 同样的工具+参数（无新签名），但清单推进了 → 仍有进展
  assert.equal(noteRound(st, { calls: [{ name: 'read_file', args: 'a' }], todoSignature: sig2 }), 0,
    '清单推进必须算进展 —— 否则长任务会被自己的「原地验证」误收口')
  // 工具、清单都没变 → 才计停滞
  assert.equal(noteRound(st, { calls: [{ name: 'read_file', args: 'a' }], todoSignature: sig2 }), 1)
})

test('只统计本轮发出的调用：被拦下的重复调用不会制造新签名', () => {
  const st = newState()
  noteRound(st, { calls: [{ name: 'read_file', args: 'a' }] })
  // 同一个调用再来两次（现实中第 3 次会被重复调用检测拦下，但签名仍是旧的）
  assert.equal(noteRound(st, { calls: [{ name: 'read_file', args: 'a' }] }), 1)
  assert.equal(noteRound(st, { calls: [{ name: 'read_file', args: 'a' }] }), 2)
})

test('sigOf：参数为对象/字符串/空值都稳定，且工具名不同则签名不同', () => {
  assert.equal(sigOf('read_file', { path: 'a.js' }), sigOf('read_file', '{"path":"a.js"}'))
  assert.notEqual(sigOf('read_file', 'a'), sigOf('grep_code', 'a'))
  assert.equal(sigOf('t', null), sigOf('t', undefined))
})

test('seen 集合有上限，超限清空重来（只影响计数，不影响正确性）', () => {
  const st = newState()
  for (let i = 0; i < policy.SEEN_SIG_CAP + 10; i++) {
    noteRound(st, { calls: [{ name: 'read_file', args: `f${i}` }] })
  }
  assert.ok(st.seen.size <= policy.SEEN_SIG_CAP + 1, 'seen 不该无限增长')
})

// ============================================================
//  收口阶梯
// ============================================================

test('停滞阶梯：warn(2) → wrapup(3) → stop(4)，同级不重复刷提醒', () => {
  const st = newState()
  const repeat = () => noteRound(st, { calls: [{ name: 'read_file', args: 'same' }] })
  noteRound(st, { calls: [{ name: 'read_file', args: 'same' }] })  // stall 0（首次）
  repeat() // stall 1
  assert.equal(decideRound(st, { loop: 1 }).action, 'none', '停滞 1 轮还不提醒')

  repeat() // stall 2
  const w = decideRound(st, { loop: 2 })
  assert.equal(w.action, 'warn')
  assert.match(w.text, /没有取得任何新信息/)
  assert.equal(decideRound(st, { loop: 2 }).action, 'none', '同一停滞阶段只提醒一次')

  repeat() // stall 3
  const u = decideRound(st, { loop: 3 })
  assert.equal(u.action, 'wrapup')
  assert.match(u.text, /停止调用工具|立即停止调用工具/)
  assert.equal(decideRound(st, { loop: 3 }).action, 'none', '收口指令也只发一次')

  repeat() // stall 4
  assert.equal(decideRound(st, { loop: 4 }).action, 'stop', '第 4 轮停滞 → 内核跳出')

  repeat() // stall 5
  assert.equal(decideRound(st, { loop: 5 }).action, 'stop', '之后一直是 stop')
})

test('停滞计数只用于动作判定，与 loop 步数无关', () => {
  const a = newState()
  a.stall = 3
  const b = newState()
  b.stall = 3
  // 同样的 stall、不同的 loop（且 loop 不在软预算点上）→ 同样的动作
  assert.deepEqual(decideRound(a, { loop: 7 }), decideRound(b, { loop: 199 }))
})

test('有进展后重新计数：warn 过的阶段可以再次提醒（新的一轮停滞）', () => {
  const st = newState()
  noteRound(st, { calls: [{ name: 't', args: 'a' }] })
  noteRound(st, { calls: [{ name: 't', args: 'a' }] })  // stall 1
  noteRound(st, { calls: [{ name: 't', args: 'a' }] })  // stall 2
  assert.equal(decideRound(st, { loop: 2 }).action, 'warn')
  // 拿到新信息 → 清零
  assert.equal(noteRound(st, { calls: [{ name: 't', args: 'b' }] }), 0)
  // 再停滞到 2 → 应该再次提醒（不是「一轮对话只提醒一次」）
  noteRound(st, { calls: [{ name: 't', args: 'b' }] })
  noteRound(st, { calls: [{ name: 't', args: 'b' }] })
  assert.equal(decideRound(st, { loop: 9 }).action, 'warn')
})

test('软预算点在无停滞时触发；停滞提醒优先于软预算', () => {
  const st = newState()
  noteRound(st, { calls: [{ name: 'read_file', args: 'f1' }] })
  const s = decideRound(st, { loop: 20 })
  assert.equal(s.action, 'warn')
  assert.match(s.text, /进度提醒/)
  assert.equal(decideRound(st, { loop: 20 }).action, 'none', '同一软预算点只提醒一次')

  const st2 = newState()
  st2.stall = STALL_WARN
  const d = decideRound(st2, { loop: 20 })
  assert.match(d.text, /进展提醒/, '停滞提醒必须优先于软预算（它更紧急）')
})

test('decideRound 对空/异常 state 安全', () => {
  assert.doesNotThrow(() => decideRound(null, { loop: 0 }))
  assert.doesNotThrow(() => decideRound({}, { loop: 20 }))
  assert.deepEqual(decideRound(undefined, {}).action, 'none')
})

// ============================================================
//  文案
// ============================================================

test('三段文案都给出「怎么走出来」，不只是抱怨', () => {
  assert.match(stallWarnText(STALL_WARN), /换一个完全不同的思路|信息已经足够/)
  assert.match(wrapupText(STALL_WRAPUP), /已完成什么|还差什么/)
  assert.match(softBudgetText(20), /最终回答/)
})

test('阈值常量关系正确（阶梯单调递增）', () => {
  assert.ok(STALL_WARN < STALL_WRAPUP && STALL_WRAPUP < STALL_STOP)
})
