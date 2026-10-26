# AGENTS.md — Local AI（开源版）

给在**本仓库**里改代码的 AI 智能体（默认助手）看的工程约定。

> ⚠️ **本仓库是 Local AI 的开源版**，由企业版通过 `rules.mjs` 规则化裁剪生成。
> 因此：**不要试图恢复**登录、平台切换、企业知识库、代码仓库自动拉取、ERP/MES 业务工具 ——
> 它们是被**刻意**移除的。要加类似能力，按 `README.md` 的「二次开发接入点」新建模块。

## 项目是什么

Electron 33 + Vue 3.5（Composition API）+ Pinia + Vite 6 的桌面 AI 助手。
对接任意 OpenAI 兼容的 function calling 接口（Base URL / API Key / 模型名在设置页配置）。

## 进程模型（改代码前必读）

- `electron/main.js` —— 主进程入口，注册 IPC。
- `electron/state.js` —— **可变共享状态**，被主进程各模块 require 同一份单例。改这里等于改全局。
- `electron/chat.js` —— 主 Agent 的 LLM + 工具调用循环。
- `electron/sub-agent.js` —— 子 Agent 的**独立精简循环**（不继承主 Agent 完整提示词）。
- `electron/settings.js` —— 系统提示词拼装 + 路径常量 + 占位符替换，是**被依赖最多的模块**。

## 构建与验证命令

```bash
yarn dev            # vite 起开发（主进程 + 渲染进程）
yarn build          # vite build + electron-builder 打包
yarn build:web      # 只 vite build（前端产物，不打包）
yarn test           # node --test tests/*.test.js
```

**不要为了「验证」跑全量 `yarn build`** —— 用户打包时会自己查。改完代码的自检见下方「自检」一节。

## 自检（改完代码必做）

语法检查的单位是**目录**，不是「我改过的文件」：

```bash
# 整目录语法检查（用托管 node 的绝对路径，别在项目目录里跑裸 node/npx）
C:/Users/syf/.workbuddy/binaries/node/versions/22.22.2-3/node.exe --check <文件>
```

- 动过 `electron/` 或 `src/` 里任何 `.js` / `.ts` / `.vue` → 对整个目录跑一遍 `node --check`，
  别按「我认为哪些是代码」来挑。
- **默认不跑** `vue-tsc --noEmit` / `tsc --noEmit` 全项目类型检查，也不跑全量 build。
- 构建产物目录（`dist/`、`dist-electron/`、`release/`）参与过构建后也要扫一遍。

## 性能：同步 IO 的坑

`electron/tools/search.js` 头部记录：早期同步递归遍历目录**把 Electron 主进程阻塞了 163 秒**。

- 任何**新的递归扫描**必须用 **异步 IO + `setImmediate` 让出 + 时间预算**，不得同步递归。
- 读取已知路径的单个文件（`statSync` / `readFileSync`）不受此限，但不能用来递归。

## 循环依赖陷阱

加载链：`main.js → chat.js → tools/index.js → sub-agent.js`。
若子模块在**顶层** `require('./tools')` 并解构，那一刻模块还是空对象 `{}`，解构出来是 `undefined`。

**修法：不在顶层 require，改为调用时再取**；或用**函数内 `require()`** 打破循环（Node 有模块缓存，开销可忽略）。

## 系统提示词拼装

`settings.js` 的 `buildSystemPrompt(allowedDirs, userMessages)` 是所有注入的汇合点，
末尾依次追加：默认助手系统提示词（`harness/roles/dev/system-prompt.md`，内含「场景调度」段）→ Excel 提示 → 技能清单 → 项目级上下文（AGENTS.md）。
后两者包了 try/catch 的 Safe 包装：**注入失败必须降级为空串，不能让主流程挂掉**。新增注入段照此模式写。

## 角色机制（本开源版已移除）

**本版没有角色切换**：`settings.role` 恒为 `'dev'`，系统提示词只有 `harness/roles/dev/system-prompt.md` 一份，
所有技能库（`skills` / `skills-qa` / `skills-excel` / `skills-legal` / `skills-dev`）对助手**全部可见**，
由提示词的「场景调度」段引导它按用户意图 `read_skill` 加载。
产品 / 测试 / 法务 / Excel 的 `roles/*/system-prompt.md` 仅作**参考物料**保留，不再注入。

- **不要再引入**按角色收窄工具集（`DEV_TOOL_NAMES` 白名单已移除）或按 `role` 分支的提示词注入 —— 那正是本版刻意去掉的。
- 想恢复多角色，参考企业版（`buildRolePromptSection` + `getSkillDirs` + 前端角色选择器，三处配套）。

## 占位符（`resolvePlaceholders`）

`harness/` 物料里用 `{{TOKEN}}` 占位，由宿主替换为真实路径。开源版当前支持的占位符白名单
见 `oss/check.mjs` —— **新增占位符必须同时更新 `settings.js` 与该校验白名单**，否则校验会失败。

## 工具结果窗口化折叠（`chat.js`）—— 改之前务必读

- 事实原文类（`read_file` / `read_skill` / `read_memory`）在大窗口（≥256K）下**不折叠**；
  小窗口按 `FACT_TOOL_RESULT_WINDOW = 8`；其余工具窗口 `TOOL_RESULT_WINDOW = 3`。
- **两条硬约束**：① 只能改 `content`，`role:'tool'` 与 `tool_call_id` 必须原样保留（否则兼容接口 400）；
  ② 折叠只作用于**发给 API 的请求体**，续跑快照落盘前要用 `restoreToolResults` 还原原文。
- 改这块之前先跑 `tests/tool-result-window.test.js`。

## 工具循环的收口与重复调用检测（`chat.js` + `tool-loop-policy.js`）

- **没有轮数硬上限**：`for (;;)`；收口只依据「进展」——连续多轮没拿到新信息（本轮调用的
  `(工具名, 参数)` 以前全用过、清单也没变）才逐级升级 `warn(2)` → `wrapup(3)` → `stop(4)`，
  `stop` 时跳出循环交给「不带工具的兜底请求」；另有 `ABSOLUTE_STEP_CEILING = 400` 的绝对刹车。
- 软预算提醒：第 20/35/50… 轮注入一条 `【进度提醒】` user 消息，**只报已用轮数、不提上限**。
  注入位置在所有 `tool` 消息之后，不能插进 `assistant(tool_calls) → tool*` 中间（否则接口 400）。
- 重复调用检测：同一 `(工具名, 参数)` 连续第 2 次照常执行但附警告，第 3 次起直接拦下。
- 改动前跑 `tests/tool-loop-policy.test.js` 与 `tests/tool-loop-budget.test.js`。

## 工具集与写盘诊断（2026-10-24，从企业版 b161689 同步）

- **`electron/tool-sets.js`** —— 「子代理能不能拿这个工具」的唯一出处（纯常量 + 纯函数，
  **不 require 任何项目内模块**，所以 `sub-agent.js` 能安全地在顶层取它，不加剧循环依赖）。
  ⚠️ **这不是"角色白名单又回来了"**：`DEV_TOOL_NAMES` 在开源版**刻意是 `null`（= 不收窄）**，
  见上文「角色机制」—— 按角色收窄工具集仍是本版刻意去掉的东西。抽这个模块只是为了让
  `sub-agent.js` 不再自己写一份过滤逻辑；判据等价于旧版的 `filter(!BLOCKED_TOOLS)`。
  将来真要加白名单，只把 `DEV_TOOL_NAMES` 赋成 `Set` 即可（调用方无需改）。
- **`electron/tools/quick-diag.js`** —— 写盘后顺手跑的单文件语法/编译检查
  （`node --check` / `JSON.parse` / 项目内 `@vue/compiler-sfc` / `esbuild` / `py_compile`）。
  **只在有错时**给 `result.diagnostics`；异常、超时（3s）、工具链缺失一律静默跳过 ——
  它绝不能把一次成功的写盘变成失败，也不能慢到让每次编辑都卡一下。
  接入点是 `tools/index.js` 的 `write_file` / `edit_file` handler（这两个已改成 async）。
- **收口闸门第三条判据**（`todo-gate.js`）：正文声称"测试/编译通过、已验证"但本次运行
  0 条 `exitCode=0` 的校验命令 → 回推一次。判据挂在**正文承诺**上，不挂在"有写盘"上
  （改 `.md` / 配置不需要跑校验，挂在写盘上会变成噪音）。改动前跑 `tests/todo-gate.test.js`
  与 `tests/todo-final-gate.test.js`（后者是端到端接线测试，用 stub 跑完整 chat 循环）。

## 测试

`tests/` 下是 node 直跑的单测（`node tests/xxx.test.js`）。判定失败归属的标准动作：
**单独重跑一次**确认稳定复现，再用 HEAD 版本（`git show HEAD:<file>`）跑同一检查对照，拿证据说话。

## 与上游同步

本仓库由企业版用规则化裁剪生成（企业业务相关部分不参与同步）。
**改本仓库代码时注意**：改动若落在「共享文件」上，下次同步会被上游覆盖。
同步工具（`oss-sync/`）位于**企业版私有仓库内**（`localAi/oss-sync/`），不随本仓库发布 ——
要变更同步行为，找维护者改该目录的 `rules.mjs`。详见 `oss/README.md`。

## 应用身份（改之前先看）

本开源版与上游企业版是**两个独立应用**，必须能同时安装。身份由这几处决定，**改一处就要同步另一处**：

| 位置 | 值 |
| --- | --- |
| `electron/main.js` | `app.setName('Local AI Open')` + `app.setPath('userData', …)` + `setAppUserModelId('com.localai.open')` |
| `electron-builder.yml` | `appId: com.localai.open` + `productName: Local AI Open` |

- `userData` **必须显式 `setPath`**，否则会与企业版共用 `%APPDATA%` 目录（配置 / 会话互相覆盖）。
- AUMID 必须与 `electron-builder.yml` 的 `appId` 一致，否则打包版可能**完全不弹系统通知**。
- 代码签名与「能否并存」无关（只影响 SmartScreen）；签名请用 `CSC_LINK` / `CSC_KEY_PASSWORD` 环境变量，不要提交证书。
- 同步机制：这几处由同步工具的 `rules.mjs`「应用身份隔离」规则组生成。**在本仓库直接改会被下次同步覆盖**，
  要改就找维护者在同步工具里加规则。

## 禁忌

- 不做没被要求的优化：不顺手重构、不改无关格式、不「顺便」升级依赖。
- 改完代码不主动 `git commit` / `git push`。
- **不要重新引入被移除的企业能力**（登录 / 平台切换 / 企业知识库 / 代码自动拉取 / ERP 工具）。
- **不要重新引入角色切换机制**（顶栏角色选择器、按 `role` 分支的提示词与工具集、按角色挂载技能库）——
  本版刻意改为「单一默认助手 + 按用户意图调度的场景技能」，见上文「角色机制」。
