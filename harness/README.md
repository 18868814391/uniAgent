# Harness（物料库）

本目录是 Local AI Open 的**物料库**：把助手的系统提示词、专业技能、约定收在一处，可整体复制到别的应用使用。

> ⚠️ **开源版与企业版最大的差异：没有「角色」这个运行时概念。**
>
> - 企业版有 6 个可切换角色（通用 / 产品 / 测试 / Excel专家 / 法务专家 / 开发），靠顶栏的「角色选择器」切换，
>   每个角色有各自的系统提示词与技能库可见性。
> - 开源版**只有一个默认助手**（`roles/dev/system-prompt.md`），它同时具备通用对话、文件处理与开发改码能力；
>   产品 / 测试 / 法务 / Excel 四类专业方法论降级为**技能**，由默认助手在提示词的「场景调度」段按**用户意图**
>   主动 `read_skill` 加载 —— 用户说"审合同"就加载 `legal-*`，说"写 PRD"就加载 `pm-*`，不再需要先切角色。
> - 所有技能库对默认助手**全部可见**（`electron/tools/skills.js` 的 `getSkillDirs()` 已改为全量挂载）。
> - `roles/{product,qa,excel,legal}/system-prompt.md` 作为**参考物料保留**（方法论仍在），但开源版不再注入它们 ——
>   对应的专业能力请走 `skills-*` 目录里的技能。

## 目录结构

```
harness/
├── harness.json                     # 清单（roles / agents / skills / conventions / usage）
├── roles/dev/system-prompt.md       # **默认助手**系统提示词（主进程读取注入，唯一生效的角色提示词）
├── roles/<other>/system-prompt.md   # 参考物料（开源版不注入）
├── agents/<topic>/AGENTS.md         # 各场景定义（路由 / 边界 / 技能映射）
├── skills-dev/dev-*/SKILL.md        # 开发场景技能
├── skills/pm-*/SKILL.md             # 产品场景技能
├── skills-qa/qa-*/SKILL.md          # 测试场景技能
├── skills-excel/xl-*/SKILL.md       # Excel 场景技能
├── skills-legal/legal-*/SKILL.md    # 法务场景技能
└── conventions/<topic>/*.md         # 各场景约定（输出规范 / 边界 / 免责声明 …）
```

## 场景与代号

| 场景 | 代号 | 触发方式（用户提到…） | 定位 |
| --- | --- | --- | --- |
| 默认助手 | — | 始终生效 | 通用对话 + 文件处理 + 改码；**全量文件读写权限** |
| 产品 | 小策 | PRD / 原型 / 页面设计 / 对齐既有 UI | 需求澄清 / 原型设计 / PRD 成稿 |
| 测试 | 验测 | 测试 / 用例 / 白盒审查 / 黑盒走查 / 测试报告 | 白盒审查（为主）+ 黑盒走查（为辅）/ 报告 |
| Excel | 表哥 | xlsx / csv / 表格 / 清洗 / 公式 / 图表 | Excel 读写 / 清洗 / 公式 / 图表 / 批量 / 格式转换 |
| 法务 | 法务专家 | 合同审查 / 条款抽取 / 风险标注 / 条文检索 | 条文检索 / 合同审查 / 条款抽取 / 风险标注 / 文书草拟 |
| 开发 | 小匠 | 改代码 / 修 bug / 重构 / 加功能 | 改码工作流 + 工程自检 + git 纪律 |

## 占位符

物料里的 `{{TOKEN}}` 由宿主在注入系统提示词前替换为真实路径（`electron/settings.js` 的 `resolvePlaceholders`）：

| 占位符 | 含义 |
| --- | --- |
| `{{CODE_REPO_DIR}}` | 产品 / 测试场景要读的「代码仓库根目录」（开源版：解析为授权目录里的第一个 git 仓库；未配置时为空串） |
| `{{PRODUCT_OUTPUT_DIR}}` | 产品场景产物输出目录 |
| `{{TEST_OUTPUT_DIR}}` | 测试场景产物输出目录 |
| `{{EXCEL_OUTPUT_DIR}}` | Excel 场景产物输出目录 |
| `{{LEGAL_OUTPUT_DIR}}` | 法务场景产物输出目录 |
| `{{EXCEL_WORK_DIR}}` | 本轮会话临时工作目录（每轮自动创建/清理） |
| `{{HARNESS_ROOT}}` / `{{HARNESS_*_SKILLS_DIR}}` / `{{HARNESS_CONVENTIONS_DIR}}` | 本物料库各子目录绝对路径 |
| `{{BUILTIN_SKILLS_DIR}}` / `{{SKILLS_DIR}}` / `{{MEMORY_DIR}}` | 内置技能库 / 用户技能目录 / 记忆目录 |
| `{{PYTHON_CMD}}` | 本机可用的 Python 命令前缀（如 `py -3`） |

新增占位符时，要同步 `electron/settings.js` 的 `resolvePlaceholders` **和** `oss/check.mjs` 的白名单。

## 复制到其它应用

1. 拷贝整个 `harness/` 目录；
2. 按上表替换占位符（或实现自己的替换逻辑）；
3. 读取 `roles/dev/system-prompt.md` 作为系统提示词；技能库按 `skills*` 目录全量挂载（或按 `harness.json` 的 `skills` 分组自行决定可见性）。

> 想恢复「多角色切换」？企业版 `localAi` 是完整参考实现：`electron/settings.js` 的 `buildRolePromptSection()`
> + `electron/tools/skills.js` 的 `getSkillDirs()` + 前端 `src/App.vue` 的角色选择器，三处配套即可。
