// 网络状态点气泡的可见性规则
//
// 为什么要有这个测试：这块逻辑改过一次需求 —— 原本气泡 12 秒后自动收起，
// 用户反馈「网络还差着它自己就没了」，改成**警告态不自动收起、只有用户手动关才消失**。
// 而"会不会自己关"这种东西光看代码很容易漏（定时器删没删干净、外面点一下会不会关），
// 所以这里既锁可见性规则，也直接断言**文件里不存在任何自动收起机制**。
//
// 被测代码从 NetStatusDot.vue 的标记区间取出（见该文件「>>> 可抽取纯逻辑 开始/结束」）：
// .vue 在 Node 侧测不了（本仓库 Node 侧 CJS、src 侧 ESM），所以沿用 ChatView.vue 的同款约定。
// 标记被挪走/改名时本文件会**大声失败**，不会静默跳过变成"假绿"。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const FILE = path.join(__dirname, '..', 'src', 'components', 'NetStatusDot.vue')
const START = '// >>> 可抽取纯逻辑 开始'
const END = '// <<< 可抽取纯逻辑 结束'

const src = fs.readFileSync(FILE, 'utf-8')

function loadHelpers() {
  const i = src.indexOf(START)
  const j = src.indexOf(END)
  assert.ok(i >= 0, `NetStatusDot.vue 里找不到开始标记「${START}」—— 标记被挪走或改名了，请同步本测试`)
  assert.ok(j > i, `NetStatusDot.vue 里找不到结束标记「${END}」或位置不对，请同步本测试`)
  const block = src.slice(i, j)
  // 区间内只允许纯逻辑：出现 ref/computed/store/watch 说明有人把有状态代码放进来了
  assert.ok(
    !/\bref\(|\bcomputed\(|\bstore\.|\bwatch\(/.test(block),
    '可抽取区间里出现了 ref/computed/store/watch —— 那部分必须留在区间之外'
  )
  // eslint-disable-next-line no-new-func
  return new Function(block + '\n; return { isWarningLevel, computeBubbleVisible }')()
}

const { isWarningLevel, computeBubbleVisible } = loadHelpers()

// 便捷构造：默认「没手动开、没悬停、没关过、没被钉住」
const vis = (level, extra = {}) =>
  computeBubbleVisible({
    level,
    dismissedLevel: '',
    manualOpen: false,
    hoverOpen: false,
    alertLatched: false,
    ...extra,
  })

test('isWarningLevel：只有黄/红算警告态', () => {
  assert.strictEqual(isWarningLevel('degraded'), true)
  assert.strictEqual(isWarningLevel('bad'), true)
  assert.strictEqual(isWarningLevel('good'), false)
  assert.strictEqual(isWarningLevel('unconfigured'), false)
  assert.strictEqual(isWarningLevel('unknown'), false)
})

test('警告态默认就显示（不需要悬停、不需要点）', () => {
  assert.strictEqual(vis('degraded'), true)
  assert.strictEqual(vis('bad'), true)
})

test('警告态被用户手动关掉后隐藏，且悬停也不弹出来', () => {
  assert.strictEqual(vis('bad', { dismissedLevel: 'bad' }), false)
  assert.strictEqual(vis('bad', { dismissedLevel: 'bad', hoverOpen: true }), false)
  assert.strictEqual(vis('degraded', { dismissedLevel: 'degraded', hoverOpen: true }), false)
})

test('关掉的是「另一档」时仍然显示（bad→degraded 属于新情况，值得再提醒）', () => {
  assert.strictEqual(vis('degraded', { dismissedLevel: 'bad' }), true)
  assert.strictEqual(vis('bad', { dismissedLevel: 'degraded' }), true)
})

test('关掉后点一下状态点（manualOpen）能重新打开', () => {
  assert.strictEqual(vis('bad', { dismissedLevel: 'bad', manualOpen: true }), true)
})

test('manualOpen 在任何档都强制显示', () => {
  for (const lv of ['good', 'degraded', 'bad', 'unconfigured', 'unknown']) {
    assert.strictEqual(vis(lv, { manualOpen: true }), true, `${lv} 应可手动打开`)
  }
})

test('非警告态：默认隐藏，悬停才显示', () => {
  for (const lv of ['good', 'unconfigured', 'unknown']) {
    assert.strictEqual(vis(lv), false, `${lv} 不该自动弹`)
    assert.strictEqual(vis(lv, { hoverOpen: true }), true, `${lv} 悬停应可看`)
  }
})

test('恢复正常后清掉「关过」的记忆，下次再坏还会弹（模拟 watch 的行为）', () => {
  // 关掉 bad
  assert.strictEqual(vis('bad', { dismissedLevel: 'bad' }), false)
  // 网络恢复 → 组件的 watch 把 dismissedLevel 清空
  let dismissed = 'bad'
  if ('good' !== 'degraded' && 'good' !== 'bad') dismissed = ''
  assert.strictEqual(dismissed, '', '恢复态应清空记忆')
  // 再次掉到 bad → 必须重新自动弹
  assert.strictEqual(vis('bad', { dismissedLevel: dismissed }), true)
})

// ---- 异常一旦弹出就必须用户手动关（用户明确要求：「异常解除了也不要收起弹窗」）----
// 原来的 bug：气泡可见性完全由「当前 level」驱动，探针下个周期测回 good → level 变绿
// → isWarningLevel 变 false → 掉回 hoverOpen → 鼠标不在上面就收起。
// 修法：黄/红出现时置位 alertLatched 钉住气泡，此后 level 怎么变都不收起，
// 解除只归 dismiss()。

test('被钉住后，即使恢复正常态（good）也不收起', () => {
  assert.strictEqual(vis('good', { alertLatched: true }), true, '异常解除不得自动收起气泡')
  assert.strictEqual(vis('unknown', { alertLatched: true }), true)
  assert.strictEqual(vis('unconfigured', { alertLatched: true }), true)
})

test('钉住优先于「关过」的记忆（手动关掉后才不再显示）', () => {
  // 钉住时即使这一档被标记过关过也仍显示
  assert.strictEqual(vis('good', { alertLatched: true, dismissedLevel: 'good' }), true)
  // 手动关掉（dismiss 会同时复位 alertLatched）→ 恢复正常态不再显示
  assert.strictEqual(vis('good', { alertLatched: false, dismissedLevel: 'good' }), false)
})

test('钉住不是「永久常驻」：dismiss 复位后恢复正常态即收起', () => {
  // dismiss() 之后 alertLatched=false，且未悬停 → 绿点不该还挂着气泡
  assert.strictEqual(vis('good', { alertLatched: false }), false)
  // 但悬停仍可主动看
  assert.strictEqual(vis('good', { alertLatched: false, hoverOpen: true }), true)
})

test('alertLatched 的复位点只有 dismiss() 一个（防止有人加回"自动解除"）', () => {
  // 只允许 dismiss() 里出现 `alertLatched.value = false`；
  // 置位（= true）只允许出现在 level 监听里。数量对不上说明有人加了自动解除路径。
  const code = src.replace(/\/\/[^\n]*/g, '')
  const resets = code.match(/alertLatched\.value\s*=\s*false/g) || []
  const sets = code.match(/alertLatched\.value\s*=\s*true/g) || []
  assert.strictEqual(resets.length, 1, `alertLatched 复位点应只有 1 处（dismiss），实际 ${resets.length} 处`)
  assert.strictEqual(sets.length, 1, `alertLatched 置位点应只有 1 处（level 监听），实际 ${sets.length} 处`)
})

test('level 监听带 immediate，且不把钉住位和恢复记忆混在一起清掉', () => {
  // 没有 immediate：挂载时就已经是黄/红的情况不会被钉住，之后探针回绿照样自动收起。
  const watchBlock = src.slice(src.lastIndexOf('watch('))
  assert.ok(/immediate:\s*true/.test(watchBlock), 'level 监听缺 immediate:true，挂载即警告态时钉不住')
  // 恢复分支里只清 dismissedLevel，不许顺手复位 alertLatched
  const elseBranch = (watchBlock.match(/else\s*\{[\s\S]*?\}/) || [])[0]
  assert.ok(elseBranch, '找不到 level 监听的「恢复正常」分支')
  assert.ok(
    !/alertLatched/.test(elseBranch),
    '恢复分支里出现了 alertLatched —— 那就是"异常解除自动收起"，用户明确不要'
  )
})

// ---- 悬停可达性（用户反馈：鼠标往气泡里挪，气泡就在指尖前消失，里面的「重新检测」点不到）----
// 原因是 hover 绑在圆点按钮上，而气泡在 12px 空隙之下；离开按钮即触发 mouseleave。
// 修法：hover 挂到 .net-status 容器（含气泡，否则不会在移入气泡时触发 mouseleave）+
// 用 .net-bubble::after 把 12px 空隙也算进容器。两条都在这里钉死。

const tpl = src.slice(src.indexOf('<template>'), src.indexOf('</template>'))
const style = src.slice(src.indexOf('<style'), src.indexOf('</style>'))

test('悬停判定挂在 .net-status 容器上，不在圆点按钮上', () => {
  const wrapTag = (tpl.match(/<div class="net-status"[^>]*>/) || [])[0]
  assert.ok(wrapTag, '找不到 .net-status 容器标签')
  assert.ok(
    /@mouseenter/.test(wrapTag) && /@mouseleave/.test(wrapTag),
    '悬停必须绑在 .net-status 容器上：挂在圆点上时，鼠标一离开圆点（还没到气泡）就会收起气泡'
  )

  const dotTag = (tpl.match(/<button[\s\S]*?>/) || [])[0]
  assert.ok(/class="status-dot"/.test(dotTag), '找不到圆点按钮标签')
  assert.ok(
    !/@mouseenter|@mouseleave/.test(dotTag),
    '圆点按钮上不该再有悬停绑定 —— 它和气泡之间隔着空隙，绑定在这里就是气泡"点不到"的根因'
  )
})

test('气泡用 ::after 桥接与圆点之间的空隙，且高度盖得住', () => {
  const after = (style.match(/\.net-bubble::after\s*\{[^}]*\}/) || [])[0]
  assert.ok(
    after,
    '缺少 .net-bubble::after：那 12px 空隙不算容器区域，鼠标经过时会触发 mouseleave，气泡照样消失'
  )
  const bridge = Number((after.match(/height:\s*(\d+)px/) || [])[1])
  // 间距从 .net-bubble 的 top: calc(100% + Npx) 里取，改了间距这条会跟着失败，不会静默失效
  const gap = Number((style.match(/\.net-bubble\s*\{[^}]*top:\s*calc\(100%\s*\+\s*(\d+)px\)/) || [])[1])
  assert.ok(!Number.isNaN(gap), '未能从 .net-bubble 解析出它与圆点的垂直间距')
  assert.ok(
    bridge >= gap,
    `桥接高度 ${bridge}px 盖不住 ${gap}px 的空隙，鼠标会在空隙里掉出去`
  )
})

test('组件里不存在任何「自动收起」机制（这是本次需求的硬要求）', () => {
  // 先剥掉 // 行注释再断言：注释里为了说明"踩过哪些坑"会提到这些名字，那不是实现。
  // 断言必须只盯代码 —— 否则删了实现却留下注释会假绿，而写了注释说明反而假红（本测试第一版就这样误报过）。
  const code = src.replace(/\/\/[^\n]*/g, '')
  assert.ok(!/setTimeout|setInterval/.test(code), 'NetStatusDot.vue 里不该再有任何定时器')
  assert.ok(!/AUTO_HIDE|scheduleAutoHide|clearHideTimer|hideTimer/.test(code), '自动收起的旧代码没删干净')
  assert.ok(
    !/onDocumentClick|document\.addEventListener/.test(code),
    '外部点击不该关掉气泡：否则你在别处点一下就消失，正好是这个提示最该在的时候'
  )
})
