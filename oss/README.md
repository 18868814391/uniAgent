# 开源版说明（oss/）

本目录是开源版特有的、**不参与企业版同步**的本地文件。

## 这个仓库与企业版的关系

本仓库是内部企业版的**规则化裁剪产物**：

```
企业版仓库（内部，私有）             本仓库（开源版）
  electron/ … 全部业务代码   ──裁剪──▶  electron/ … 去掉企业模块后的功能代码

同步工具（位于企业版私有仓库 localAi/oss-sync/，不随本仓库发布）
  rules.mjs（裁剪规则）      ──应用──▶  （规则含内网信息，只进私有仓库）
  regen.mjs（生成器）                    同步一条命令：node regen.mjs
```

- **同步工具位置**：**在企业版私有仓库里**（`localAi/oss-sync/`），不随本仓库发布。
  `rules.mjs` / `validate.mjs` 里必然出现内网域名、仓库名等企业字面量，因此只进私有仓库；
  引擎已强制跳过该目录（`readTree` 的 skip），它不会被拷进本仓库，也不会进安装包
  （`electron-builder.yml` 的 `files` 是白名单，不含该目录）。
- **同步方式**：维护者在该目录跑 `node regen.mjs`，读取企业版 HEAD 重跑规则后覆写本仓库文件。
  **不要在本仓库手工改共享代码** —— 下次同步会被覆盖。
- **可以放心改的**：`oss/`（本目录）、`README.md`、`AGENTS.md`、`harness/roles/{product,qa}/system-prompt.md`、`harness/agents/{qa,pm}/AGENTS.md`。这些在同步规则里是「整文件替换」或本地保留项。
- **企业版改了共享文件会怎样**：生成器会**报错中止**并指出哪条规则失效，由维护者修规则后重新生成 —— 不会静默产出半成品。维护者也可先跑 `node regen.mjs --changes` 看「上次同步以来上游改了什么、哪些需要人工确认」。

## 运行

```bash
yarn install
yarn dev            # 开发
yarn build          # 打包（Electron）
node oss/check.mjs  # 自检：企业模块是否清干净、占位符是否都注册过
```

## 二次开发接入点

企业版内置、开源版**已移除**的能力，以及如果想补回来该改哪里：

| 能力 | 企业版实现 | 开源版现状 / 接入点 |
| --- | --- | --- |
| 登录与多事业部 | `electron/login.js` + `src/components/LoginOverlay.vue` | 已移除，无登录态；`src/stores/app.js` 的 `checkLogin()` 是空壳，接你自己的鉴权即可 |
| 运行平台与环境（多系统域名） | `electron/platforms.js` | 已移除；`electron/settings.js` 里环境/平台字段一并删除 |
| 角色代码仓库自动拉取 | `electron/role-repos.js` + `RoleRepoSync.vue` | 已移除；产品/测试角色改读 `{{CODE_REPO_DIR}}`（= 授权目录里的第一个 git 仓库，见 `settings.js` 的 `getCodeRepoDir()`） |
| ERP / MES 业务接口工具 | `electron/tools/erp.js`（`query_erp` / `search_code` / `backend_code` / `open_erp` / `check_erp_permission`） | 已整块移除；若要接自己的业务后端，在 `electron/tools/` 下新建模块 + 在 `tools/index.js` 注册 + 在 `tool-schemas.js` 加 schema |
| 企业知识库（代码索引 / 法规库） | `electron/erp-kb.js` / `electron/legal-kb.js` | 已移除，含知识库目录与更新 IPC |
| 角色权限分组 | `electron/userCheck.js` | 已移除；`stores/app.js` 的 `canSwitchRole()` 恒为 `true` |
| 试用模型下发 | 服务端 | 已移除；`stores/app.js` 的 `applyTrialProfile()` 是空实现，保留同名接口便于二次开发 |
| 自动更新 | `electron-builder.yml` 的 `publish.url` | 已改为占位 `https://example.com/…`，**发布前必须改成你自己的地址** |

> 移除只在**代码层面**清干净；占位符 `{{CODE_REPO_DIR}}` 等仍由 `electron/settings.js` 的
> `resolvePlaceholders()` 在运行时替换 —— 产品 / 测试角色的提示词里已声明「代码目录由用户提供」。
