// ============================================================
//  tests/dev-guard.test.js —— 开发角色操作守卫（electron/tools/guard.js）
//
//  守卫的职责：项目（git 仓库）内的改动放行，系统级路径 / git 兜不住的删除 /
//  高风险命令才要求用户确认，毁机级命令直接拦截。
//
//  纯 node 跑，不需要 stub electron —— guard.js 只在真正弹框时才惰性
//  require('electron')，这里的用例只触碰纯判定函数。
//
//  ⚠️ 用例用到真实 git 仓库（在系统临时目录里 mkdtemp + git init）。
//     临时目录被 guard 视为「非系统级」（%LOCALAPPDATA%\Temp 是白名单例外），
//     否则这些断言会因为落在 AppData 下而全部判成 critical。
// ============================================================
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const guard = require('../electron/tools/guard')
const aiCreated = require('../electron/tools/ai-created')

// 记账表（tools/ai-created.js）是模块级单例：每个用例换一个临时落盘位置，
// 免得用例之间互相看到对方的记录。生产环境下它是 userData/ai-created-files.json。
test.beforeEach(() => {
  aiCreated.__setStorePathForTest(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-ai-store-')), 'store.json'))
})

const IS_WIN = process.platform === 'win32'
const HAS_GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makeRepo() {
  const dir = tmpDir('guard-repo-')
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  return dir
}

function commitAll(dir) {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=tester', 'commit', '-m', 'init'], {
    cwd: dir,
    stdio: 'ignore',
  })
}

// ------------------------------------------------------------
//  命令分级
// ------------------------------------------------------------
test('classifyCommand: 常规开发命令一律放行', () => {
  const allowed = [
    'yarn build',
    'yarn install',
    'npm install',
    'npm run build:web',
    'yarn add lodash',
    'pip install pandas',
    'git status --short',
    'git add -A',
    'git commit -m "fix bug"',
    'git diff HEAD',
    'git log --oneline -5',
    'node --check electron/chat.js',
    'grep -rn "foo" electron/',
    'rm out.txt',
    'ls -la',
    'python scripts/xl_clean.py',
  ]
  for (const cmd of allowed) {
    const r = guard.classifyCommand(cmd)
    assert.strictEqual(r.action, 'allow', `应放行：${cmd}（实际 ${r.action}：${r.reason || ''}）`)
  }
})

test('classifyCommand: 毁机级命令直接拦截（block，连确认都不给）', () => {
  const blocked = [
    'rm -rf /',
    'rm -rf /*',
    'rm -rf ~',
    'rm -rf $HOME',
    'rm -rf C:\\',
    'rm -rf /c',
    'sudo rm -rf /',
    'format C:',
    'mkfs.ext4 /dev/sda1',
    'diskpart',
    'dd if=/dev/zero of=/dev/sda',
    'shutdown /s /t 0',
    'reboot',
    'bcdedit /set testsigning on',
    'reg add HKLM\\Software\\Foo /v Bar /d 1',
    'vssadmin delete shadows /all',
    'sfc /scannow',
    'net user guest /delete',
    'chmod -R 777 /',
  ]
  for (const cmd of blocked) {
    const r = guard.classifyCommand(cmd)
    assert.strictEqual(r.action, 'block', `应拦截：${cmd}（实际 ${r.action}：${r.reason || ''}）`)
  }
})

test('classifyCommand: 会丢数据 / 动系统环境的命令需要确认（confirm）', () => {
  const cases = [
    ['rm -rf node_modules', '递归删除'],
    ['rm -rf build && yarn build', '链式命令里的递归删除'],
    ['rm build/*', '通配删除'],
    ['git reset --hard HEAD~1', 'reset --hard'],
    ['git checkout -- src/a.js', 'checkout --'],
    ['git checkout .', 'checkout .'],
    ['git clean -fd', 'clean'],
    ['git push -f origin main', 'force push'],
    ['git push --force origin main', 'force push'],
    ['git push origin --delete feature/x', '删远端分支'],
    ['git branch -D old', 'branch -D'],
    ['git rebase main', 'rebase'],
    ['git stash drop', 'stash drop'],
    ['git config --global user.email a@b.c', '全局 git 配置'],
    ['npm install -g typescript', '全局安装'],
    ['yarn global add serve', '全局安装'],
    ['winget install Git.Git', '系统包管理'],
    ['choco install python', '系统包管理'],
    ['brew install ffmpeg', '系统包管理'],
    ['setx PATH "C:\\x;%PATH%"', '环境变量'],
    ['reg add HKCU\\Software\\Foo /v Bar /d 1', '注册表（非 HKLM）'],
    ['netsh interface ip set dns "Ethernet" static 8.8.8.8', '网络配置'],
    ['schtasks /create /tn x /tr y /sc daily', '计划任务'],
    ['del /s /q C:\\tmp\\x', '递归删除（cmd）'],
    ['rmdir /s /q C:\\tmp\\x', '递归删除（cmd）'],
  ]
  for (const [cmd, why] of cases) {
    const r = guard.classifyCommand(cmd)
    assert.strictEqual(r.action, 'confirm', `应确认（${why}）：${cmd} → 实际 ${r.action}`)
  }
})

test('classifyCommand: 命令里的 "rm -rf" 纯文本不算删除命令', () => {
  // 只有以 rm 开头的子命令段才判定为删除 —— 否则 commit message 里提一句就会被误拦
  const r = guard.classifyCommand('git commit -m "docs: 说明 rm -rf 的危害"')
  assert.strictEqual(r.action, 'allow')
})

test('classifyCommand: 空命令放行（交给工具层报参数错误）', () => {
  assert.strictEqual(guard.classifyCommand('').action, 'allow')
  assert.strictEqual(guard.classifyCommand('   ').action, 'allow')
})

// ------------------------------------------------------------
//  路径分级
// ------------------------------------------------------------
test('classifyPath: 系统目录 / 盘根 / 用户敏感配置 → critical', { skip: !IS_WIN }, () => {
  const home = process.env.USERPROFILE
  const cases = [
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    'C:\\Windows\\notepad.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    process.env.SystemDrive + '\\',
    home,
    process.env.APPDATA,
    path.join(process.env.APPDATA, 'local-ai', 'settings.json'),
    path.join(home, '.ssh', 'id_rsa'),
    path.join(home, '.gitconfig'),
    path.join(home, '.npmrc'),
    path.join(home, '.bashrc'),
  ]
  for (const c of cases) {
    assert.strictEqual(guard.isCriticalPath(c), true, `应判系统级：${c}`)
  }
})

test('classifyPath: 临时目录不算系统级（os.tmpdir 就在 AppData 下）', () => {
  const dir = tmpDir('guard-loose-')
  assert.strictEqual(guard.isCriticalPath(dir), false, `临时目录不该判成系统级：${dir}`)
  assert.strictEqual(guard.classifyPath(path.join(dir, 'a.txt')).tier, 'loose')
})

test('classifyPath: 普通目录（非 git 仓库）→ loose', () => {
  const dir = tmpDir('guard-loose2-')
  const f = path.join(dir, 'note.txt')
  fs.writeFileSync(f, 'hello')
  const info = guard.classifyPath(f)
  assert.strictEqual(info.tier, 'loose')
  assert.strictEqual(info.gitRoot, null)
})

// ------------------------------------------------------------
//  文件类工具的确认策略
// ------------------------------------------------------------
test('git 仓库内：写 / 改 / 删干净文件都免打扰', { skip: !HAS_GIT }, () => {
  const repo = makeRepo()
  const srcDir = path.join(repo, 'src')
  fs.mkdirSync(srcDir, { recursive: true })
  const tracked = path.join(srcDir, 'a.js')
  fs.writeFileSync(tracked, 'const a = 1\n')
  commitAll(repo)

  assert.strictEqual(guard.classifyPath(tracked).tier, 'project')
  assert.strictEqual(guard.evaluateToolCall('edit_file', { path: tracked }).action, 'allow')
  assert.strictEqual(guard.evaluateToolCall('write_file', { path: tracked }).action, 'allow')
  assert.strictEqual(guard.evaluateToolCall('delete_file', { path: tracked }).action, 'allow')

  // 新建文件不破坏任何已有内容 → 免问
  const fresh = path.join(srcDir, 'new.js')
  assert.strictEqual(guard.evaluateToolCall('write_file', { path: fresh }).action, 'allow')
  // 但删一个从未提交过的文件 = 真没了 → 要问
  assert.strictEqual(guard.evaluateToolCall('delete_file', { path: fresh }).action, 'confirm')

  // 已跟踪但带未提交改动 → 删了改动就丢了 → 要问；改仍然免问
  fs.writeFileSync(tracked, 'const a = 2\n')
  assert.strictEqual(guard.evaluateToolCall('delete_file', { path: tracked }).action, 'confirm')
  assert.strictEqual(guard.evaluateToolCall('edit_file', { path: tracked }).action, 'allow')
})

test('非 git 目录：覆盖 / 删除要确认，新建与精准编辑免问', () => {
  const dir = tmpDir('guard-loose3-')
  const f = path.join(dir, 'note.txt')
  fs.writeFileSync(f, 'hello')

  assert.strictEqual(guard.evaluateToolCall('delete_file', { path: f }).action, 'confirm')
  assert.strictEqual(guard.evaluateToolCall('write_file', { path: f }).action, 'confirm')
  assert.strictEqual(guard.evaluateToolCall('edit_file', { path: f }).action, 'allow')
  assert.strictEqual(guard.evaluateToolCall('write_file', { path: path.join(dir, 'brand-new.txt') }).action, 'allow')
})

test('系统级路径：读随意，写 / 改 / 删一律确认', { skip: !IS_WIN }, () => {
  const winFile = 'C:\\Windows\\notepad.exe'
  assert.strictEqual(guard.evaluateToolCall('read_file', { path: winFile }).action, 'allow')
  assert.strictEqual(guard.evaluateToolCall('edit_file', { path: winFile }).action, 'confirm')
  assert.strictEqual(guard.evaluateToolCall('write_file', { path: winFile }).action, 'confirm')
  assert.strictEqual(guard.evaluateToolCall('delete_file', { path: winFile }).action, 'confirm')

  const rc = path.join(process.env.USERPROFILE, '.bashrc')
  assert.strictEqual(guard.evaluateToolCall('write_file', { path: rc }).action, 'confirm')
  assert.strictEqual(guard.evaluateToolCall('edit_file', { path: rc }).action, 'confirm')
})

test('evaluateToolCall: 命令走命令分级，无关工具不受影响', () => {
  assert.strictEqual(guard.evaluateToolCall('execute_command', { command: 'yarn build' }).action, 'allow')
  assert.strictEqual(guard.evaluateToolCall('execute_command', { command: 'git reset --hard' }).action, 'confirm')
  assert.strictEqual(guard.evaluateToolCall('execute_command', { command: 'rm -rf /' }).action, 'block')
  assert.strictEqual(guard.evaluateToolCall('execute_command', { command: '' }).action, 'allow')

  assert.strictEqual(guard.evaluateToolCall('grep_code', { pattern: 'foo' }).action, 'allow')
  assert.strictEqual(guard.evaluateToolCall('list_directory', { path: 'C:\\Windows' }).action, 'allow')
  assert.strictEqual(guard.evaluateToolCall('write_file', {}).action, 'allow')
  assert.strictEqual(guard.evaluateToolCall('write_file', null).action, 'allow')
})

// ------------------------------------------------------------
//  AI 自己写出来的文件（2026-10-10）—— 删它 / 覆盖它不该弹确认框
// ------------------------------------------------------------
test('AI 写出来的文件：删除免确认；被手工改过之后恢复确认', { skip: !HAS_GIT }, () => {
  const repo = makeRepo()
  const draft = path.join(repo, '_icon_check.cjs')
  fs.writeFileSync(draft, 'console.log(1)\n')
  aiCreated.noteAiWrite(draft, true) // 等价于 AI 用 write_file 新建了这个校验脚本

  // 它确实「从未提交到 git」—— 但那是 AI 自己造的草稿，删了不心疼
  assert.strictEqual(guard.evaluateToolCall('delete_file', { path: draft }).action, 'allow')

  // 用户手工改过（size / mtime 变）→ 账失效 → 回到原来那套确认逻辑
  fs.writeFileSync(draft, 'console.log(1)\nconsole.log(2)\n')
  assert.strictEqual(guard.evaluateToolCall('delete_file', { path: draft }).action, 'confirm')
})

test('AI 写出来的散装文件（不在任何 git 仓库内）：删除与覆盖都免确认', () => {
  const dir = tmpDir('guard-ai-loose-')
  const mine = path.join(dir, 'scratch.txt')
  fs.writeFileSync(mine, 'x')
  aiCreated.noteAiWrite(mine, true)
  assert.strictEqual(guard.evaluateToolCall('delete_file', { path: mine }).action, 'allow')
  assert.strictEqual(guard.evaluateToolCall('write_file', { path: mine }).action, 'allow')

  // 对照：没记过账的散装文件照旧要问（行为不能放宽）
  const yours = path.join(dir, 'user-note.txt')
  fs.writeFileSync(yours, 'x')
  assert.strictEqual(guard.evaluateToolCall('delete_file', { path: yours }).action, 'confirm')
  assert.strictEqual(guard.evaluateToolCall('write_file', { path: yours }).action, 'confirm')
})

// ------------------------------------------------------------
//  rm 豁免：`rm -rf <AI 草稿目录>` 不该弹框（2026-10-11）
//
//  场景来自真实截图：AI 建了 .tmpchk/ 放两个一次性校验脚本，清理时敲
//  `cd <repo> && rm -rf .tmpchk` —— 命令里带 `-r`，此前一律弹确认框。
//  记账表里那两个文件都在，属于「AI 自己造的草稿」，与 delete_file 的
//  豁免口径对齐。
// ------------------------------------------------------------
function makeAiDraftDir(name, files) {
  const root = path.join(tmpDir('guard-draft-'), name)
  fs.mkdirSync(root, { recursive: true })
  for (const rel of files) {
    const f = path.join(root, rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, 'x')
    aiCreated.noteAiWrite(f, true)
  }
  return root
}

test('classifyCommand: rm -rf 一个「全是 AI 草稿」的目录 → 放行', () => {
  const primary = makeAiDraftDir('.tmpchk', ['check.cjs', 'chk.cjs'])
  const nested = makeAiDraftDir('drafts', ['a/b.py', 'c.js'])
  const cwd = path.resolve(primary, '..')

  // 绝对路径（正斜杠 / 反斜杠两种写法）
  const fwd = primary.replace(/\\/g, '/')
  assert.strictEqual(guard.classifyCommand(`rm -rf "${fwd}"`).action, 'allow')
  assert.strictEqual(guard.classifyCommand(`rm -rf ${primary}`).action, 'allow')
  // 带 cd 前缀（截图里的写法）：相对路径要按命令行里的目录解析
  assert.strictEqual(guard.classifyCommand(`cd ${cwd} && rm -rf .tmpchk`).action, 'allow')
  // 嵌套子目录 / Git Bash 的 MSYS 写法
  assert.strictEqual(guard.classifyCommand(`rm -rf ${nested.replace(/\\/g, '/')}`).action, 'allow')
  const msys = '/' + primary[0].toLowerCase() + primary.slice(2).replace(/\\/g, '/')
  assert.strictEqual(guard.classifyCommand(`rm -rf ${msys}`).action, 'allow')
})

test('classifyCommand: 任一条件不成立就退回确认框', () => {
  const draft = makeAiDraftDir('.tmpchk', ['check.cjs'])
  const cwd = path.resolve(draft, '..')

  // ① 目录里混进一个不在账的文件（用户的资产）
  const mixed = makeAiDraftDir('.mixed', ['mine.py'])
  fs.writeFileSync(path.join(mixed, 'user-note.txt'), 'y')
  assert.strictEqual(guard.classifyCommand(`rm -rf "${mixed.replace(/\\/g, '/')}"`).action, 'confirm')

  // ② 空目录：可能是用户自己建的，认不出来 → 不豁免
  const empty = path.join(tmpDir('guard-draft-'), 'empty')
  fs.mkdirSync(empty)
  assert.strictEqual(guard.classifyCommand(`rm -rf "${empty.replace(/\\/g, '/')}"`).action, 'confirm')

  // ③ 目录不在任何记账里（git 仓库里的 node_modules 之类）
  const plain = path.join(tmpDir('guard-draft-'), 'node_modules')
  fs.mkdirSync(plain)
  fs.writeFileSync(path.join(plain, 'x.js'), 'x')
  assert.strictEqual(guard.classifyCommand(`rm -rf "${plain.replace(/\\/g, '/')}"`).action, 'confirm')

  // ④ 目标带通配符 → 看不出真实范围
  assert.strictEqual(guard.classifyCommand(`cd "${cwd}" && rm -rf .tmp*`).action, 'confirm')

  // ⑤ 目标带变量
  assert.strictEqual(guard.classifyCommand('rm -rf "$TMPDIR"').action, 'confirm')

  // ⑥ 路径解析不到（相对路径 + 命令里没有 cd → 按 home 解析 → 不存在）
  assert.strictEqual(guard.classifyCommand(`rm -rf ${draft.replace(/\\/g, '/')}`).action, 'allow', '绝对路径不受 cd 影响')
  assert.strictEqual(guard.classifyCommand('rm -rf definitely-not-a-real-dir-xyz').action, 'confirm')

  // ⑦ 混着来：一个是草稿目录、一个是真目标 → 整条命令照旧确认
  const other = path.join(tmpDir('guard-draft-'), 'real')
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(other, 'keep.txt'), 'x')
  const cmd = `rm -rf "${draft.replace(/\\/g, '/')}" "${other.replace(/\\/g, '/')}"`
  assert.strictEqual(guard.classifyCommand(cmd).action, 'confirm')

  // ⑧ 非递归的 rm 不受这条影响（快捷删除本来就放行，不含 -r/通配时压根不进 sweeping 分支）
  assert.strictEqual(guard.classifyCommand('rm -f a.txt b.txt').action, 'allow')

  // 对照：草稿文件被用户改过 → 树判定失效 → 照旧确认
  const stale = makeAiDraftDir('.stale', ['gen.py'])
  assert.strictEqual(guard.classifyCommand(`rm -rf "${stale.replace(/\\/g, '/')}"`).action, 'allow')
  fs.writeFileSync(path.join(stale, 'gen.py'), 'user edited\n')
  assert.strictEqual(guard.classifyCommand(`rm -rf "${stale.replace(/\\/g, '/')}"`).action, 'confirm')
})
