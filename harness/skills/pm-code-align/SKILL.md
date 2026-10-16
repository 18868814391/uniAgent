---
name: pm-code-align
description: 代码对齐技能。设计原型前读取本地已自动拉取的前后端正式分支仓库（仓库随运行平台变化：ERP / 其它系统），提取既有 UI 元素、字段定义与取数口径，确保新设计对齐已有系统。
---

# 代码对齐（pm-code-align）

设计原型、页面、表单、列表页之前，先读**本地已自动拉取的三个仓库**，让新设计与既有系统一致。

## 一、仓库在哪（随运行平台变化）

切到产品身份时应用会自动拉取下面三个仓库；**具体仓库名与分支随当前运行平台（ERP / 其它系统）不同**，以系统提示词里给出的这几个绝对路径为准：

- 前端（PC 端）：`{{CODE_REPO_DIR}}` —— 仓库 `{{CODE_REPO_DIR}}`，分支 `{{CODE_REPO_DIR}}`
- H5 端：`{{CODE_REPO_DIR}}` —— 仓库 `{{CODE_REPO_DIR}}`，分支 `{{CODE_REPO_DIR}}`。这是前端的**移动端 / H5 实现**，独立仓库、非前端仓库子目录；移动端 / H5 需求读这一份
- 后端：`{{CODE_REPO_DIR}}` —— 仓库 `{{CODE_REPO_DIR}}`，分支 `{{CODE_REPO_DIR}}`

## 二、检索纪律（直接决定快慢，必守）

你的授权目录下不止这三个仓库（还有 Excel 产物、PRD、其他仓库），`grep_code` / `glob_files` **不传 `path` 会扫整个授权目录**——几万个文件、十几秒且结果被截断。

1. **必须传 `path`**，指向具体仓库下的具体模块（如 `{{CODE_REPO_DIR}}/<模块目录>`、
   `{{CODE_REPO_DIR}}/src/views/<路由>`），不要停在仓库根、更不要留空。
2. **尽量传 `include`**：后端 `*.java` / `*.xml`，前端 `*.vue` / `*.ts`。
3. 能猜出文件名片段时先用 `glob_files` 定位（如 `pattern="**/*Collect*.java"` + `path={{CODE_REPO_DIR}}`），再 `read_file` 精读——比全库 grep 快一个数量级。
4. 按接口路径 / Controller 类名 / 方法名 / 表名 / 字段名这类代码原文检索；中文业务词命中率低、噪声大。
5. 返回里出现 `scan.incomplete` 时不要原样重试，缩小 `path` 或换更精确的关键词。

## 三、怎么对齐 UI（读前端）

1. **先探清页面目录结构，不要假定约定**：
   - ERP 前端（`your-frontend`）：`src/pages/` 下**两种约定并存**——`src/pages/<路由>/index.vue`（列表页/主页面）与平铺的 `src/pages/<路由>.vue`（详情页多为这种，如 `goodCenter/brandManage/brand/detail` → `src/pages/goodCenter/brandManage/brand/detail.vue`）。
   - 其它系统 前端（`your-frontend`）：页面在 `src/views/<模块>/<页面>.vue`。
   - 一律 `list_directory` 看清该路由目录下实际有哪些 `.vue`，只按某一种约定找会对部分页面误判"不存在"。
2. 用 `read_file` 读该 `.vue`，提取：页面布局、组件用法（表格/表单/弹窗/按钮）、字段与列定义、表单校验、交互与状态反馈、配色风格。
3. 新原型**复用这些既有 UI 元素与交互习惯**，产出里显式说明「对齐了哪个既有页面/组件」。

## 四、怎么对齐字段与取数（读前端接口 + 后端）

1. 前端接口定义：读前端仓库的 `src/api`（ERP）或 `src/api` / `src/apis`（MES）下的接口函数（`grep_code` 定位），确认 URL、method、参数、返回字段。
2. 后端实现：读 `{{CODE_REPO_DIR}}`，按调用链下钻 Controller → Service → Mapper 接口 → `*Mapper.xml` 的 SQL。
   - 后端按模块目录细分（如 `xxx-service/…`）；模块划分先 `list_directory` 看清再检索。
3. 从 SQL 与 Service 逻辑里提取：入参出参、字段来源与计算口径、状态枚举与流转、校验与唯一性约束。
4. **枚举/状态码禁止猜含义**：到前端仓库的常量/枚举文件或页面展示代码里找中文，找不到如实标「需 IT 确认」。

## 五、产物里的引用写法

- 对齐页面：`<前端仓库名>/src/views/xxx.vue`（MES）或 `your-frontend/src/pages/xxx/index.vue` / `src/pages/xxx.vue`（ERP）——写相对仓库根的路径，并在括号里补上绝对路径前缀 `{{CODE_REPO_DIR}}`，便于用户核对。
- 后端字段：`<后端仓库名>/.../XxxController#xxx`、`XxxServiceImpl#xxx`、`XxxMapper.xml`。
- 检索无果时多换关键词（业务对象名、菜单名、接口 url 片段），仍找不到就 `ask_user` 向用户确认入口。

## 六、仓库未就绪时

若 `{{CODE_REPO_DIR}}` / `{{CODE_REPO_DIR}}` / `{{CODE_REPO_DIR}}` 不存在或不是 git 仓库：提示用户「请在代码仓库浮窗点『立即拉取』或重新切换一次产品身份」，**不要**自己拼 `git clone`，也**不得**退回知识库脱敏副本冒充真实代码、或凭经验脑补字段口径。
