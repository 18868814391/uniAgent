# 开源版说明（oss/）

本目录是开源版特有的、**不参与企业版同步**的本地文件。

## 这个仓库与企业版的关系

本仓库是内部企业版的**规则化裁剪产物**：

```
企业版仓库（内部）                   本仓库（开源版）
  electron/ … 全部业务代码   ──裁剪──▶  electron/ … 去掉企业模块后的功能代码
  oss-sync/rules.mjs（规则） ──应用──▶  （无，规则本身含内网信息，不发布）
```

- **上游**：内部企业版仓库（`git remote` 里的 `upstream`）。
- **同步方式**：由企业版侧的生成器重跑规则后覆写本仓库文件，**不要在本仓库手工改指纹外的共享代码** —— 下次同步会被覆盖。
- **可以放心改的**：`oss/`（本目录）、`README.md`、`AGENTS.md`、`harness/roles/{product,qa}/system-prompt.md`、`harness/agents/{qa,pm}/AGENTS.md`。这些在同步规则里是「整文件替换」或本地保留项。
- **企业版改了共享文件会怎样**：企业版的生成器会**报错中止**并指出哪条规则失效，由维护者修规则后重新生成 —— 不会静默产出半成品。

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
