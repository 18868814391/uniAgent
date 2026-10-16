# Local AI（开源版）

> **这是 Local AI 的开源版本。** 基于 **Electron 33 + Vue 3.5 + Vite 6** 的桌面 AI 助手：
> 一个 AI 输入框 + 一套本机工具（文件读写、代码检索、命令执行、网页自动化、Excel/Word/PPT/PDF 处理、Skills/Memory），
> 对接任意 **OpenAI 兼容**接口。
>
> ⚠️ **企业相关内容与地址已移除**：登录、多事业部平台切换、企业代码知识库、代码仓库自动拉取、
> 企业后端/ERP 接口地址与密钥等，**在本开源版中已全部剔除**。
> 因此本版本**需要二次开发后才能进行全功能体验** —— 详见下文
> [「企业版移除了什么」](#企业版移除了什么) 与 [「二次开发接入点」](#二次开发接入点)。

---

## 快速开始

```bash
yarn install
yarn dev            # 开发模式（Vite dev server + Electron）
yarn build:web      # 只构建渲染层
yarn build          # 构建并打包（产物输出到 release/）
yarn test           # node:test 单测
```

首次运行后到 **设置 → API 配置** 填入任意 OpenAI 兼容服务的 `Base URL` / `API Key` / 模型名即可开始对话。
（默认预置 DeepSeek 官方配置示例，API Key 需自行填写。）

环境要求：Node.js 20+、yarn。Windows 上若要用 Excel/Word/PPT 处理能力，需要 Python 与相关依赖（设置页有「补全 Excel 环境」一键安装）。

---

## 功能特性

- **流式对话**：任意 OpenAI 兼容接口，逐字渲染；转发模型思考过程。
- **工具调用**：完整 Function Calling 支持，工具循环最多 60 轮，一轮内多个工具并发执行，结果按序回填。
- **文件操作**：`read_file` / `write_file` / `edit_file`（str_replace 精准编辑 + unified diff 回显）/ `list_directory` / `delete_file`，
  受**授权目录白名单**约束。
- **代码检索**：`grep_code`（正则/关键词，带时间预算与异步 IO）/ `glob_files`（按文件名定位）。
- **命令执行**：`execute_command`（Git Bash，300s 超时，超长输出落盘）。
- **联网搜索**：`search_web`（Bing → DuckDuckGo 兜底）。
- **网页自动化**：`browser_*` 原生工具驱动沙箱化测试窗口（打开/点击/输入/按键/执行 JS/等待/截图/读控制台/批量流程）。
- **看图能力（多模态）**：模型勾选「支持读图」后，`read_image`（本机图片）、`browser_read_images`（网页取图）可把图片真正交给模型。
- **Excel / Word / PPT / PDF**：内置技能 + 预置脚本（openpyxl / pandas / markitdown / pycel / python-docx / pptxgenjs / pypdf）。
- **Skill / Memory**：AI 可读写 `.md` 技能与记忆文件，并与应用内置技能库合并。
- **多会话 / 归档 / 上下文压缩 / 断点续跑 / 任务清单 / 子代理并行 / 任务提醒**：见「界面与机制」。
- **单一默认助手 + 场景技能**：本开源版**没有角色切换机制**。应用以一个「默认助手」身份工作（`harness/roles/dev/system-prompt.md`），
  同时具备通用对话、文件处理与开发改码能力；产品 / 测试 / 法务 / Excel 四类专业方法论以**技能**形式提供（`harness/skills*`），
  由默认助手按**用户意图**主动 `read_skill` 加载（说"审合同"→`legal-*`，说"写 PRD"→`pm-*`），不再需要先切角色。
- **法务检索**：国家法律法规数据库（flk.npc.gov.cn）接口检索 + 官方直链下载（`download_url`，域名白名单）。
- **主题系统**：20+ 套配色 + 自定义主色 + 字号档位。

### 界面与机制

- **工具调用明细**：聊天区工具汇总行可展开为逐条明细；`edit_file` / `write_file` 带「查看改动」（主进程算好的 unified diff）。
- **任务清单（`update_todos`）**：多步任务开工前先列 3~8 条结构化清单，**每轮请求末尾由主进程回显给模型**，界面同步展示进度。
- **并行子任务**：`spawn_sub_agent` 最多 2 个并行，`get_sub_agent_results` 汇总（最长 10 分钟；超时会带回部分成果）。
- **断点续跑**：中断/超时/报错时落「本轮消息序列」快照，「继续」直接回放已完成的工具结果，不重跑。
- **上下文压缩**：超模型窗口 60% 时压缩更早历史为摘要，保留最近 3 轮原文；摘要落 sidecar。
- **网络状态点**：顶栏小圆点反映「当前网络到模型服务」的好坏（抖动/超时数），非「Key 配没配」。
- **任务提醒**：长任务完成/异常/反问挂起时发**系统通知**（窗口不在前台时唯一可见的渠道）。
- **操作分级**：默认助手拥有全量文件读写权限 —— 项目内（git 仓库内）免确认、系统级路径弹确认框、毁机级命令硬拦截。

---

## 企业版移除了什么

为避免把企业信息带进开源版，下面这些在生成开源版时被**整块移除**（不是禁用，是从源码里删掉）：

| 移除项 | 说明 |
| --- | --- |
| 登录体系 | 账号密码 / 验证码 / 租户选择 / token 持久化 / 登录遮罩层（`electron/login.js`、`src/components/LoginOverlay.vue`） |
| 多平台与环境切换 | 企业 ERP / MES 多事业部平台、正式/测试/开发环境表与域名（`electron/platforms.js`） |
| 企业代码知识库 | 知识库 Git/zip 拉取、脱敏前后端副本（`electron/erp-kb.js`、内置 `erp-query` 技能） |
| 代码仓库自动拉取 | 切换角色时自动 clone/pull 企业前后端仓库（`electron/role-repos.js`、`src/components/RoleRepoSync.vue`） |
| ERP/MES 业务工具 | `query_erp` / `search_code` / `backend_code` / `open_erp` / `check_erp_permission` / `qa_page_permission`（`electron/tools/erp.js`） |
| 角色切换机制 | 顶栏角色选择器、`settings.role` 的角色分支、按角色收窄的工具集与技能可见性（前端 `src/App.vue` + `electron/settings.js`）；**四个专业角色的方法论以技能保留**，见下 |
| 角色权限分组 | 按登录人姓名匹配的角色切换白名单（`electron/userCheck.js`） |
| 法律法规库 Git 拉取 | 依赖企业部署密钥的法规库同步（`electron/legal-kb.js`）；**法务角色的官网检索能力保留** |
| 企业地址与密钥 | 所有内网域名、接口地址、仓库 token、发布/更新服务器地址、企业软件下载直链 |

**保留**的是与具体企业无关的全部能力：对话、文件、代码检索、命令、网页测试、文件格式处理、技能/记忆、
断点续跑、上下文压缩、子代理、任务清单、主题，以及产品 / 测试 / 法务 / Excel 的**完整方法论与技能**
（只是把「切角色加载」换成「按用户意图调度技能」，并把「读企业内网仓库」换成「读你自己配置的代码目录」）。

---

## 二次开发接入点

想让开源版变成「全功能」，按下表把自己系统的能力接进来即可。所有改动都集中在少数几个文件：

| 想接入的能力 | 建议改动位置 | 做法 |
| --- | --- | --- |
| 自己系统的业务数据查询 | 新建 `electron/tools/<你的系统>.js` + `electron/tool-schemas.js` + `electron/tools/index.js` | 照 `download_url` 的写法加一个工具；提示词段加在 `electron/settings.js` 的 `buildSystemPrompt` |
| 自己的代码/文档知识库 | 新建 `electron/<你的>kb.js`，在 `electron/main.js` 里 `registerIpc()` | 参考被移除的 `erp-kb.js` 结构（IPC 三件套：download / getStatus / delete） |
| 业务代码目录（产品/测试场景读代码） | `electron/settings.js` 的 `resolvePlaceholders` | 把 `{{CODE_REPO_DIR}}` 替换为你希望 AI 读的代码根目录（默认解析为「授权目录里的第一个 git 仓库」） |
| 登录 / 账号体系 | 新建 `electron/auth.js`，在 `main.js` 装配，前端加遮罩组件 | 需要自己设计；系统提示词里的用户上下文段在 `settings.js` 的 `buildSystemPrompt` |
| 自动更新 | `electron-builder.yml` 的 `publish` | 开源版默认**不配置**发布源；填上你自己的 generic 服务器或 GitHub Releases 地址 |
| 技能与场景 | `harness/` | 系统提示词 / 技能 / 约定都在这里，可整体增删；技能库由 `electron/tools/skills.js` 的 `getSkillDirs()` 全量挂载，新增技能目录要在那里登记 |
| 恢复「多角色切换」 | `electron/settings.js` 的 `buildRolePromptSection()` + `electron/tools/skills.js` 的 `getSkillDirs()` + `src/App.vue` 的角色选择器 | 企业版 `localAi` 是完整参考实现（三处配套即可）；企业版已移除，需从企业版仓库取回 |

---

## 架构速览

三进程布局（Electron 主进程 / preload / 渲染进程）：

```
electron/
  main.js            主进程装配（生命周期 + 各域 IPC 注册 + 自动更新）
  state.js           全局共享可变状态（settings / 会话运行槽 / 任务清单 …）
  settings.js        配置持久化 / 目录解析 / 模型 profile / 系统提示词拼装
  chat.js            LLM + 工具调用循环（并发执行、工具结果折叠、轮次预算、重复调用检测）
  sub-agent.js       子代理独立循环
  context.js         上下文压缩 / token 估算
  conversations.js   会话存储 / 归档导出
  tools/             工具实现（schema 在 tool-schemas.js，handler 按域拆分）
  browser-test.js    网页测试驱动（沙箱化 BrowserWindow）
  preload.js         contextBridge 暴露 window.electronAPI
src/                 Vue 3 渲染层（App.vue / components / stores）
harness/             物料库（默认助手提示词 + 各场景技能 + 约定）
skills/              应用内置技能库（xlsx / docx / pptx / pdf / claude-api 等）
tests/               node:test 单测（node tests/xxx.test.js）
oss/                 本开源版的说明与校验脚本（不属于上游共享代码）
```

---

## 与上游（企业版）保持同步

本仓库由企业版通过**规则化裁剪**生成，并与企业版保持同步（企业业务相关部分除外）。
同步说明见 [`oss/README.md`](oss/README.md)，本地自检：

```bash
node oss/check.mjs      # 扫描本仓库是否残留企业标识 / 未知占位符
```

## 与企业版「并存安装」（应用身份）

本开源版与上游企业版是**两个独立应用**，可以同时装在同一台机器上、互不干扰。靠的是这组标识互不相同：

| 标识 | 上游企业版 | 本开源版 | 作用 |
| --- | --- | --- | --- |
| `appId`（= Windows AUMID） | `com.localai.desktop` | `com.localai.open` | 任务栏图标分组、系统通知归属、卸载项 |
| `productName` | `Local AI` | `Local AI Open` | 开始菜单 / 桌面快捷方式、安装目录 |
| 安装包文件名 | `local-ai-<v>-Setup.exe` | `local-ai-open-<v>-Setup.exe` | 下载与安装互不冲突 |
| `userData` 目录 | `%APPDATA%\Local AI` | `%APPDATA%\Local AI Open` | 配置 / 会话 / 归档 —— **不共用** |

> ⚠️ **二次开发务必改掉这组标识**，否则会与上游（或你自己的其它版本）共用配置目录、合并任务栏图标、通知串台。
> 要改的只有两处：`electron/main.js` 的 `app.setName` / `app.setPath('userData')` / `setAppUserModelId`，
> 与 `electron-builder.yml` 的 `appId` / `productName`。`node oss/check.mjs` 会检查这组标识是否仍被正确隔离。
>
> 三者关系：`app.setName` 只决定「默认」userData 目录名，所以**必须同时显式 `setPath('userData')`**，
> 否则仍会落到企业版目录；`setAppUserModelId` 必须与 `appId` 一致，否则打包版可能**完全不弹系统通知**。

### 代码签名与「能否并存」无关

代码签名只影响 Windows SmartScreen 的警告，**不决定能否同时安装** —— 两个应用可以共用同一张证书，
也可以各用不同证书。本开源版**默认不签名**（保持仓库不含任何凭据）。要签名，推荐用环境变量而非提交证书：

```bash
# Windows（cmd）
set CSC_LINK=path\to\your.pfx
set CSC_KEY_PASSWORD=your-password
yarn build
```

也可在 `electron-builder.yml` 的 `win.signtoolOptions` 里显式配置（注意本文件不能出现两个 `win:` 键，要填就并进已有的 `win:` 段）。

## 许可证

二次开发前请确认你所在组织对上游代码的授权范围（本仓库为企业版的裁剪产物）。
