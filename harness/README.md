# Harness（角色物料库）

本目录是 Local AI 的**角色自包含物料库**：把每个角色的系统提示词、技能、约定收在一处，
可整体复制到别的应用使用。

> ⚠️ **开源版差异**：企业版里产品/测试角色读的是「切身份时自动拉取的内网代码仓库」，
> 开源版已移除该能力 —— 两个角色的提示词已改为读**你自己配置的代码目录**
> （占位符 `{{CODE_REPO_DIR}}`，未配置时为空）。企业专属的「仓库拉取 / 权限清单」类技能与内置的示例检索技能已移除。

## 目录结构

```
harness/
├── harness.json                     # 清单（roles / agents / skills / conventions / usage）
├── roles/<role>/system-prompt.md    # 各角色系统提示词（主进程读取注入）
├── agents/<role>/AGENTS.md          # 各角色定义（路由 / 边界 / 技能映射）
├── skills/pm-*/SKILL.md             # 产品角色技能
├── skills-qa/qa-*/SKILL.md          # 测试角色技能
├── skills-excel/xl-*/SKILL.md       # Excel专家技能
├── skills-legal/legal-*/SKILL.md    # 法务专家技能
├── skills-dev/dev-*/SKILL.md        # 开发角色技能
└── conventions/<role>/*.md          # 各角色约定（输出规范 / 边界 / 免责声明 …）
```

## 角色

| 角色 | 代号 | 定位 |
| --- | --- | --- |
| 产品 | 小策 | 需求澄清 / 原型设计 / PRD 成稿（对齐你自己仓库的既有 UI） |
| 测试 | 验测 | 白盒审查（为主）+ 黑盒走查（为辅）/ 测试报告 |
| Excel专家 | 表哥 | Excel 读写 / 清洗 / 公式 / 图表 / 批量 / 格式转换 |
| 法务专家 | 法务专家 | 条文检索（先本地后官网）/ 合同审查 / 条款抽取 / 风险标注 / 文书草拟 |
| 开发 | 小匠 | 改码工作流 + 工程自检 + git 纪律（绕过授权目录白名单，高风险） |

「通用角色」不需要物料库。

## 占位符

物料里的 `{{TOKEN}}` 由宿主在注入系统提示词前替换为真实路径（`electron/settings.js` 的 `resolvePlaceholders`）：

| 占位符 | 含义 |
| --- | --- |
| `{{CODE_REPO_DIR}}` | 本角色「代码仓库根目录」（开源版：解析为授权目录里的第一个仓库；未配置时为空串） |
| `{{PRODUCT_OUTPUT_DIR}}` | 产品角色产物输出目录 |
| `{{TEST_OUTPUT_DIR}}` | 测试角色产物输出目录 |
| `{{EXCEL_OUTPUT_DIR}}` | Excel专家产物输出目录 |
| `{{LEGAL_OUTPUT_DIR}}` | 法务专家产物输出目录 |
| `{{EXCEL_WORK_DIR}}` | 本轮会话临时工作目录（每轮自动创建/清理） |
| `{{HARNESS_ROOT}}` / `{{HARNESS_*_SKILLS_DIR}}` / `{{HARNESS_CONVENTIONS_DIR}}` | 本物料库各子目录绝对路径 |
| `{{BUILTIN_SKILLS_DIR}}` / `{{SKILLS_DIR}}` / `{{MEMORY_DIR}}` | 内置技能库 / 用户技能目录 / 记忆目录 |
| `{{PYTHON_CMD}}` | 本机可用的 Python 命令前缀（如 `py -3`） |

新增占位符时，要同步 `electron/settings.js` 的 `resolvePlaceholders` **和** `oss/check.mjs` 的白名单。

## 复制到其它应用

1. 拷贝整个 `harness/` 目录；
2. 按上表替换占位符（或实现自己的替换逻辑）；
3. 按 `harness.json` 的 `usage` 段读取各角色的 `systemPrompt` / `skillsDir` / `outputDir`。

角色技能库按角色挂载（见 `electron/tools/skills.js` 的 `getSkillDirs()`）：
只有当前角色对应的技能库会被列出，避免技能互相干扰。
