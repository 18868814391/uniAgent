// A4/A5 browser_flow —— 批量执行骨架 + YAML 固化/回放 回归测试
//
// A4：把一串已经确定的步骤交给主进程顺序执行（20 步从 40+ 次 LLM 往返降到 1~2 次），
//     失败即停，并回传失败那一步的上下文＋当前快照。
// A5：跑通的流程固化成 YAML，回归期零 LLM 回放。固化时必须把 "ref=N" 反解成稳定选择器
//     —— ref 只是当次快照的句柄，写进文件下次必然失效。
//
// 这里锁住五条不变量：
//   1) buildFlowYaml → parseFlowYaml 往返一致（含引号、真实换行、反斜杠路径）
//   2) safeSlug 清洗非法字符、限制长度、空值回退
//   3) loadFlow 能从固化目录读回流程；文件不存在时报错
//   4) runFlow 参数校验（空 steps、超过 100 步）
//   5) runFlow 遇到未知 action 立即失败并停止，不再触碰浏览器（保护：不在坏输入上乱点）
//
// browser-test.js 加载即 require('electron') 与 ./settings，故先塞 require.cache。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TARGET = path.join(__dirname, '..', 'electron', 'browser-test.js')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-flow-'))

const stub = (request, exports) => {
  const id = require.resolve(request, { paths: [path.dirname(TARGET)] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

stub('electron', {
  app: { getPath: () => path.join(TMP, 'userdata') },
  BrowserWindow: class {},
})
stub('./settings', {
  getBrowserDownloadsDir: () => path.join(TMP, 'downloads'),
  getTestOutputDir: () => path.join(TMP, 'test-output'),
})

delete require.cache[require.resolve(TARGET)]
const bt = require(TARGET)

test('safeSlug：清洗非法字符、限制长度、空值回退', () => {
  assert.equal(bt.safeSlug('入库单 审核/流程'), '入库单-审核-流程')
  assert.equal(bt.safeSlug('a*b?c'), 'a-b-c')
  assert.equal(bt.safeSlug('  前后空格  '), '前后空格')
  assert.ok(bt.safeSlug('   ').startsWith('flow-'), '纯空白应回退到时间戳名')
  assert.ok(bt.safeSlug('').startsWith('flow-'))
  assert.ok(bt.safeSlug('x'.repeat(200)).length <= 60)
})

test('buildFlowYaml → parseFlowYaml 往返一致（引号 / 换行 / 反斜杠路径）', () => {
  const steps = [
    { action: 'click', target: 'text=编辑 >> nth=56' },
    { action: 'type', target: 'ref=1', value: '含"引号"与\n换行' },
    { action: 'type', target: 'ref=2', value: 'C:\\path\\to\\file' },
    { action: 'wait', value: 1500, note: '等接口返回' },
    { action: 'type', target: 'ref=3', value: '字面\\n不是换行' },
    { action: 'press', value: 'Enter' },
  ]
  const yaml = bt.buildFlowYaml({ slug: 'demo', name: '演示 流程', url: 'http://x/y' }, steps)
  const p = bt.parseFlowYaml(yaml)

  assert.equal(p.name, '演示 流程')
  assert.equal(p.url, 'http://x/y')
  assert.equal(p.steps.length, 6)
  assert.equal(p.steps[0].target, 'text=编辑 >> nth=56')
  assert.equal(p.steps[1].value, '含"引号"与\n换行')
  assert.equal(p.steps[2].value, 'C:\\path\\to\\file', '反斜杠路径不能被吃成转义')
  assert.equal(p.steps[3].value, 1500, '数字应还原成 number')
  assert.equal(p.steps[3].note, '等接口返回')
  assert.equal(p.steps[4].value, '字面\\n不是换行', '字面反斜杠+n 不能被误读成换行')
  assert.equal(p.steps[5].value, 'Enter')
  assert.equal(p.steps[0].action, 'click')
})

test('parseFlowYaml：忽略注释与空行，容忍 JSON 输入', () => {
  const yaml = ['# 这是注释', '', '  ', 'name: "流程"', 'steps:', '  - action: sleep', '    value: 300'].join('\n')
  const p = bt.parseFlowYaml(yaml)
  assert.equal(p.name, '流程')
  assert.equal(p.steps.length, 1)
  assert.equal(p.steps[0].value, 300)

  const json = JSON.stringify({ name: 'from-json', steps: [{ action: 'click', target: '#a' }] })
  const pj = bt.parseFlowYaml(json)
  // 解析器只认 YAML 子集；JSON 由 loadFlow 走 JSON.parse 分支
  assert.ok(Array.isArray(pj.steps))
})

test('loadFlow：能从固化目录读回流程；不存在时明确报错', () => {
  const dir = path.join(TMP, 'test-output', 'work', '入库审核')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, '入库审核.flow.yaml'),
    bt.buildFlowYaml({ slug: '入库审核', name: '入库单审核', url: 'http://erp/x' }, [
      { action: 'click', target: 'text=查询' },
      { action: 'assertText', target: 'text=查询', value: '成功' },
    ]),
    'utf8',
  )

  const lf = bt.loadFlow('入库审核')
  assert.equal(lf.name, '入库单审核')
  assert.equal(lf.steps.length, 2)
  assert.equal(lf.steps[0].target, 'text=查询')
  assert.equal(lf.steps[1].value, '成功')
  assert.ok(lf.file.endsWith('入库审核.flow.yaml'))

  assert.throws(() => bt.loadFlow('根本不存在'), /流程文件不存在/)
  assert.throws(() => bt.loadFlow(''), /需要 flow 名称/)
})

test('runFlow：空 steps / 无参 / 超 100 步 都被拒绝', async () => {
  await assert.rejects(() => bt.runFlow({}), /需要 steps 数组/)
  await assert.rejects(() => bt.runFlow({ steps: [] }), /需要 steps 数组/)
  await assert.rejects(
    () => bt.runFlow({ steps: new Array(101).fill({ action: 'sleep', value: 0 }) }),
    /最多 100 步/,
  )
})

test('runFlow：未知 action 立即失败并停止，不执行后续步骤', async () => {
  const out = await bt.runFlow({
    steps: [
      { action: 'bogusThing' },
      { action: 'click', target: 'text=查询' }, // 绝不能被执行（没有浏览器，会炸）
    ],
  })
  assert.equal(out.success, false)
  assert.equal(out.executed, 1, '失败即停，只应执行到出错那一步')
  assert.equal(out.failedAt.index, 0)
  assert.match(out.failedAt.error, /未知 action/)
  assert.equal(out.passed, 0)
  assert.equal(out.failed, 1)
  assert.ok(Array.isArray(out.steps) && out.steps.length === 1)
})

test('runFlow：stopOnFail=false 时继续跑完，逐条回报', async () => {
  const out = await bt.runFlow({
    stopOnFail: false,
    steps: [{ action: 'nope' }, { action: 'alsoNope' }],
  })
  assert.equal(out.executed, 2)
  assert.equal(out.failed, 2)
  assert.equal(out.success, false)
  assert.equal(out.steps.length, 2)
  assert.equal(out.steps[0].ok, false)
})

test('FLOW_ACTIONS 覆盖 schema 里承诺的动作', () => {
  const expected = [
    'goto', 'click', 'type', 'press', 'wait', 'sleep',
    'assertText', 'assertValue', 'assertVisible', 'assertUrl', 'assertEval',
  ]
  assert.deepEqual(bt.FLOW_ACTIONS.slice().sort(), expected.slice().sort())
})

test('INJECT_SRC 内部 JS 可编译（node --check 覆盖不到模板字符串内部）', () => {
  assert.doesNotThrow(() => new Function(bt.INJECT_SRC))
})
