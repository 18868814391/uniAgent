---
name: pm-field-logic
description: 字段逻辑精确描述技能。描述一个字段的来源与口径时，必须落到具体前端页面与后端 Controller/Service/Mapper 源码（仓库随运行平台变化：ERP / 其它系统），不允许凭经验臆测。
---

# 字段逻辑（pm-field-logic）

## 一、每条字段描述都要能指到代码

写「来源」时给到**能直接核对的位置**，而不是泛泛的"来自后端接口"：

- 前端展示：`<前端仓库>/{{CODE_REPO_DIR}}/xxx.vue`（MES 用 `src/views/`）或 `<ERP 前端仓库>/src/pages/xxx/index.vue` / `src/pages/xxx.vue`（ERP）的
  `el-table-column prop="supplierName"` 之类，绝对路径前缀是 `{{CODE_REPO_DIR}}`。
- 前端接口定义：`<前端仓库>/src/api/xxx.ts` 接口 `xxx/page` 返回字段 `supplierName`。
- 后端实现：`<后端仓库>/.../XxxController#xxx` / `XxxServiceImpl#xxx` / `XxxMapper.xml` 的字段与 SQL
  （前端仓库在后端仓库 `{{CODE_REPO_DIR}}` 里读）。

## 二、代码来源（随运行平台变化）

- 前端 PC：`{{CODE_REPO_DIR}}` —— 仓库 `{{CODE_REPO_DIR}}`，分支 `{{CODE_REPO_DIR}}`
- H5 端：`{{CODE_REPO_DIR}}` —— 仓库 `{{CODE_REPO_DIR}}`，分支 `{{CODE_REPO_DIR}}`。这是前端的移动端 / H5 实现（独立仓库）；
  移动端 / H5 的字段口径看这里，PC 端页面仍看前端仓库
- 后端：`{{CODE_REPO_DIR}}` —— 仓库 `{{CODE_REPO_DIR}}`，分支 `{{CODE_REPO_DIR}}`

三者都在切换到产品身份时由应用自动拉取，**切平台会换成另一套仓库**，请以系统提示词里给出的绝对路径为准。

取代码的方式：

1. 前端页面 / 接口：在 `{{CODE_REPO_DIR}}` 下用 `grep_code` 找 `.vue` / `src/api/*.ts`，再 `read_file` 读。
2. 后端实体 / XML：在 `{{CODE_REPO_DIR}}` 下用 `grep_code` 找 Controller / Service / Mapper 接口与 `*Mapper.xml`，
   再 `read_file` 逐层读实现。**必须带 `path`（如 `{{CODE_REPO_DIR}}/<模块目录>`）与 `include`（`*.java` / `*.xml`）**，
   否则会退化成全授权目录扫描，十几秒且结果被截断。
   - 后端按模块目录细分（如 `xxx-service/…`）；模块划分先 `list_directory` 看清再检索。
3. **枚举防猜**：解释枚举 / 状态码前先在前端仓库的常量 / 枚举文件或页面展示里找中文含义，找不到如实标「需 IT 确认」，不凭数字脑补。

## 三、字段描述模板（逐项写清）

| 项 | 要求 |
| --- | --- |
| 字段名 | 代码里的原始名（含大小写） |
| 展示名 | 页面上的中文标签 |
| 类型 | string / number / enum / date … |
| 来源 | 具体页面文件 / 接口 / 后端方法 / SQL 字段 |
| 格式 | 单位、精度、日期格式、千分位 |
| 空值 | 空串 / null / 0 的业务含义 |
| 校验·规则 | 必填、长度、唯一、联动、可编辑性 |
| 权限 | 哪个权限码控制可见 / 可编辑（ERP 用 权限码；MES 用页面路由权限） |
| 联动口径 | 依赖哪些字段、变化时如何影响其他字段 |

## 四、边界

- 禁止凭方法名、命名习惯或一般经验脑补实现细节并写入产物——能读到的（`{{CODE_REPO_DIR}}` 里的
  Controller/Service/Mapper XML 实现、前端代码、注释）就读到确认；读不到的如实标「需 IT 确认」。
- 若 `{{CODE_REPO_DIR}}`、`{{CODE_REPO_DIR}}` 或 `{{CODE_REPO_DIR}}` 不存在 / 不是 git 仓库：
  提示用户「请在代码仓库浮窗点『立即拉取』或重新切换一次产品身份」，不得臆造字段来源与口径，
  也不得退回知识库脱敏副本冒充真实代码。
