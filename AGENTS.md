# AGENTS.md — Local AI（开源版）

给在**本仓库**里改代码的 AI 智能体（开发角色「小匠」）看的工程约定。

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
末尾依次追加：角色系统提示词 → Excel 提示 → 技能清单 → 项目级上下文（AGENTS.md）。
后两者包了 try/catch 的 Safe 包装：**注入失败必须降级为空串，不能让主流程挂掉**。新增注入段照此模式写。

## 占位符（`resolvePlaceholders`）

`harness/` 物料里用 `{{TOKEN}}` 占位，由宿主替换为真实路径。开源版当前支持的占位符白名单
见 `oss/check.mjs` —— **新增占位符必须同时更新 `settings.js` 与该校验白名单**，否则校验会失败。

## 工具结果窗口化折叠（`chat.js`）—— 改之前务必读

- 事实原文类（`read_file` / `read_skill` / `read_memory`）在大窗口（≥256K）下**不折叠**；
  小窗口按 `FACT_TOOL_RESULT_WINDOW = 8`；其余工具窗口 `TOOL_RESULT_WINDOW = 3`。
- **两条硬约束**：① 只能改 `content`，`role:'tool'` 与 `tool_call_id` 必须原样保留（否则兼容接口 400）；
  ② 折叠只作用于**发给 API 的请求体**，续跑快照落盘前要用 `restoreToolResults` 还原原文。
- 改这块之前先跑 `tests/tool-result-window.test.js`。

## 工具循环的轮次预算与重复调用检测（`chat.js`）

- `TOOL_LOOP_LIMIT = 60`（一轮 = 一次 LLM 往返）；轮次耗尽后**强制再发一次不带工具**的请求逼它回答。
- 轮次预算提醒：第 40/45/50/55 轮各注入一条 `【轮次提醒】` user 消息（位置在所有 `tool` 消息之后）。
- 重复调用检测：同一 `(工具名, 参数)` 连续第 2 次照常执行但附警告，第 3 次起直接拦下。
- 改动前跑 `tests/tool-loop-budget.test.js`。

## 测试

`tests/` 下是 node 直跑的单测（`node tests/xxx.test.js`）。判定失败归属的标准动作：
**单独重跑一次**确认稳定复现，再用 HEAD 版本（`git show HEAD:<file>`）跑同一检查对照，拿证据说话。

## 与上游同步

本仓库由企业版用规则化裁剪生成（企业业务相关部分不参与同步）。
**改本仓库代码时注意**：改动若落在「共享文件」上，下次同步会被上游覆盖 —— 这类改动应当回到
企业版的 `oss-sync/rules.mjs` 里加规则。详见 `oss/README.md`。

## 禁忌

- 不做没被要求的优化：不顺手重构、不改无关格式、不「顺便」升级依赖。
- 改完代码不主动 `git commit` / `git push`。
- **不要重新引入被移除的企业能力**（登录 / 平台切换 / 企业知识库 / 代码自动拉取 / ERP 工具）。
