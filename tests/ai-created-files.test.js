// ============================================================
//  tests/ai-created-files.test.js —— 「这份文件是 AI 写出来的」记账
//  （electron/tools/ai-created.js，2026-10-10 新增）
//
//  需求：AI 自己生成的文件（它写来跑一次性校验的临时脚本…）删除时不该弹
//  「该文件从未提交到 git，删除后无法恢复」—— 那份东西本来就是 AI 造的。
//
//  纯 node 跑，不需要 stub electron：storePath() 里 require('electron') 失败 /
//  拿不到 app 时退化成纯内存记账，正好是测试要的形态。
// ============================================================
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const aiCreated = require('../electron/tools/ai-created')
const { parseOutputTargets } = require('../electron/tools/shell')

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// 每个用例一个独立的落盘位置 —— 否则用例之间会互相看到对方的记账（记录是模块级单例）
test.beforeEach(() => {
  aiCreated.__setStorePathForTest(path.join(tmpDir('ai-created-store-'), 'store.json'))
})

test('AI 新建的文件 → 认得；内容被外部改过之后 → 不再认得', () => {
  const dir = tmpDir('ai-created-')
  const f = path.join(dir, '_icon_check.cjs')
  fs.writeFileSync(f, 'console.log(1)\n')

  assert.strictEqual(aiCreated.isAiAuthored(f), false, '没记账前一律不认得')
  aiCreated.noteAiWrite(f, true)
  assert.strictEqual(aiCreated.isAiAuthored(f), true)

  // 用户手工改了内容（size 变）→ 账失效
  fs.writeFileSync(f, 'console.log(1)\nconsole.log(2)\n')
  assert.strictEqual(aiCreated.isAiAuthored(f), false)

  // 只有 mtime 变（内容长度一样）也算「被碰过」
  fs.writeFileSync(f, 'console.log(9)\n')
  aiCreated.noteAiWrite(f, false)
  assert.strictEqual(aiCreated.isAiAuthored(f), true, '已在册的文件被 AI 再写一次 → 刷新记账')
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(f, past, past)
  assert.strictEqual(aiCreated.isAiAuthored(f), false, 'mtime 对不上就不认')
})

test('用户已有的文件被 AI 改写，不会变成「AI 产物」', () => {
  const dir = tmpDir('ai-created-')
  const f = path.join(dir, 'user-note.txt')
  fs.writeFileSync(f, '这是用户自己写的\n')

  // isNew=false 且不在册 → 不记账（它的内容多半还是用户的）
  aiCreated.noteAiWrite(f, false)
  assert.strictEqual(aiCreated.isAiAuthored(f), false)
})

test('未记账 / 文件不存在 / 空路径 一律 false', () => {
  const dir = tmpDir('ai-created-')
  const f = path.join(dir, 'ghost.txt')
  assert.strictEqual(aiCreated.isAiAuthored(f), false)
  assert.strictEqual(aiCreated.isAiAuthored(''), false)
  assert.strictEqual(aiCreated.isAiAuthored(null), false)

  fs.writeFileSync(f, 'x')
  aiCreated.noteAiWrite(f, true)
  assert.strictEqual(aiCreated.isAiAuthored(f), true)
  fs.unlinkSync(f)
  assert.strictEqual(aiCreated.isAiAuthored(f), false, '文件没了 → 不认得')
})

test('forgetPath 之后不再认得（删除后撤账）', () => {
  const dir = tmpDir('ai-created-')
  const f = path.join(dir, 'a.txt')
  fs.writeFileSync(f, 'x')
  aiCreated.noteAiWrite(f, true)
  assert.strictEqual(aiCreated.isAiAuthored(f), true)
  aiCreated.forgetPath(f)
  assert.strictEqual(aiCreated.isAiAuthored(f), false)
})

test('落盘 + 重新加载（模拟重启）后仍然认得', () => {
  const store = path.join(tmpDir('ai-created-store-'), 'store.json')
  const dir = tmpDir('ai-created-')
  const f = path.join(dir, 'draft.py')

  aiCreated.__setStorePathForTest(store)
  fs.writeFileSync(f, 'print(1)\n')
  aiCreated.noteAiWrite(f, true)
  assert.ok(fs.existsSync(store), '记账要落盘（否则重启后又开始弹确认框）')

  // 模拟重启：清掉内存表，仍指向同一个 store 文件
  aiCreated.__setStorePathForTest(store)
  assert.strictEqual(aiCreated.isAiAuthored(f), true)

  // store 文件损坏 → 保守退回「不认得」，而不是抛错
  fs.writeFileSync(store, '{ 坏掉的 json')
  aiCreated.__setStorePathForTest(store)
  assert.strictEqual(aiCreated.isAiAuthored(f), false)
})

test('路径大小写 / 相对写法归一（Windows）', () => {
  const dir = tmpDir('ai-created-')
  const f = path.join(dir, 'Case.txt')
  fs.writeFileSync(f, 'x')
  aiCreated.noteAiWrite(f, true)
  if (process.platform === 'win32') {
    assert.strictEqual(aiCreated.isAiAuthored(path.join(dir, 'case.txt')), true)
    assert.strictEqual(aiCreated.isAiAuthored(f.toUpperCase()), true)
  } else {
    assert.strictEqual(aiCreated.isAiAuthored(f), true)
  }
})

// ------------------------------------------------------------
//  目录树判定（isAiDraftTree）—— 给 `rm -rf <目录>` 那条豁免用
// ------------------------------------------------------------
test('isAiDraftTree: 树内全是 AI 草稿 → true；混进一个外部文件 → false', () => {
  const root = path.join(tmpDir('ai-tree-'), '.tmpchk')
  fs.mkdirSync(path.join(root, 'nested'), { recursive: true })
  const a = path.join(root, 'check.cjs')
  const b = path.join(root, 'chk.cjs')
  const c = path.join(root, 'nested', 'deep.py')
  for (const f of [a, b, c]) {
    fs.writeFileSync(f, 'x')
    aiCreated.noteAiWrite(f, true)
  }
  assert.strictEqual(aiCreated.isAiDraftTree(root), true)

  // 混进一个不在账的文件（用户放的、或 AI 覆盖式改写的）→ 整棵树不再豁免
  fs.writeFileSync(path.join(root, 'user-note.txt'), 'y')
  assert.strictEqual(aiCreated.isAiDraftTree(root), false)

  // 那个文件在账之后又恢复（证明否决权确实来自未记账的那一个）
  aiCreated.noteAiWrite(path.join(root, 'user-note.txt'), true)
  assert.strictEqual(aiCreated.isAiDraftTree(root), true)
})

test('isAiDraftTree: 空目录 / 不存在的路径 / 文件路径 / 空参数 一律 false', () => {
  const base = tmpDir('ai-tree-')
  const empty = path.join(base, 'empty')
  fs.mkdirSync(empty)
  assert.strictEqual(aiCreated.isAiDraftTree(empty), false, '空目录可能是用户自己建的 → 不豁免')
  assert.strictEqual(aiCreated.isAiDraftTree(path.join(base, 'nope')), false)
  assert.strictEqual(aiCreated.isAiDraftTree(''), false)
  assert.strictEqual(aiCreated.isAiDraftTree(null), false)

  const f = path.join(base, 'a.txt')
  fs.writeFileSync(f, 'x')
  aiCreated.noteAiWrite(f, true)
  assert.strictEqual(aiCreated.isAiDraftTree(f), false, '传文件进来不算目录树')
})

test('isAiDraftTree: 树内文件被外部改过 → 不再豁免', () => {
  const root = path.join(tmpDir('ai-tree-'), '.drafts')
  fs.mkdirSync(root)
  const f = path.join(root, 'gen.py')
  fs.writeFileSync(f, 'print(1)\n')
  aiCreated.noteAiWrite(f, true)
  assert.strictEqual(aiCreated.isAiDraftTree(root), true)

  fs.writeFileSync(f, 'print(1)\nprint(2)\n') // 用户手工追加了一行
  assert.strictEqual(aiCreated.isAiDraftTree(root), false)
})

// ------------------------------------------------------------
//  命令里的重定向 / tee 目标解析（shell.js）
//  模型常用 `cat > x.py << 'EOF'` 生成脚本，那种文件也是 AI 产物 —— 要能认出来。
// ------------------------------------------------------------
test('parseOutputTargets: 认出重定向与 tee 的字面量目标', () => {
  const cwd = 'C:\\work'
  const cmd = "cat > _icon_check.cjs << 'EOF'\nconsole.log(1)\nEOF\npython gen.py >> out.log 2>&1 && tee -a notes.md\n"
  assert.deepStrictEqual(parseOutputTargets(cmd, cwd), [
    path.resolve(cwd, '_icon_check.cjs'),
    path.resolve(cwd, 'out.log'),
    path.resolve(cwd, 'notes.md'),
  ])
})

test('parseOutputTargets: 变量 / 通配 / /dev/null / 2>&1 一律不认', () => {
  const cwd = 'C:\\work'
  assert.deepStrictEqual(parseOutputTargets('echo hi > /dev/null', cwd), [])
  assert.deepStrictEqual(parseOutputTargets('cat a > $DST', cwd), [])
  assert.deepStrictEqual(parseOutputTargets('ls > *.log', cwd), [])
  assert.deepStrictEqual(parseOutputTargets('cmd 2>&1', cwd), [])
  assert.deepStrictEqual(parseOutputTargets('echo "a > b"', cwd), [])
  assert.deepStrictEqual(parseOutputTargets('a->b', cwd), [])
  assert.deepStrictEqual(parseOutputTargets('', cwd), [])
})
