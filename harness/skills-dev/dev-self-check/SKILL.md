---
name: dev-self-check
description: 改完代码的自检清单——语法检查按目录跑、eslint/SFC 编译校验、分语言命令速查；默认不跑全项目类型检查与全量 build。
---
# dev-self-check（工程自检）

每次改动文件后在交付前执行。两条铁律：

1. **语法检查的单位是「目录」，不是「我改过的文件」**。只要动过某目录下任何一个源码文件，就对整个目录跑语法检查——「我只改了文案/注释」不是豁免理由：文案可能嵌在模板字符串里，一个裸反引号就能让整个应用起不来。
2. **默认不跑全项目类型检查（vue-tsc --noEmit / tsc --noEmit）和全量 build**——耗时长且用户打包时会自己查。自检只做秒级到分钟级的项目：语法 + lint + 单文件编译。

## 分语言命令

**JavaScript / Node（CommonJS）**
```bash
# 首选：find 递归全目录（Git Bash 自带 find，不受 shell 选项影响）
find <目录> -name '*.js' -print0 | xargs -0 -n1 node --check
# 失败会打印到 stderr，管道整体退出码非 0；要逐条看清失败文件就改成：
#   find <目录> -name '*.js' -exec sh -c 'node --check "$1" || echo "FAIL: $1"' _ {} \;

# 没有 find 时退回 globstar —— 必须先开启，否则 ** 会退化成 *（只覆盖一层）：
shopt -s globstar nullglob
for f in <目录>/**/*.js; do node --check "$f" || echo "FAIL: $f"; done
```
- ⚠️ **`**` 在 Git Bash 里默认不递归**（`shopt globstar` 默认 `off`，`**` 等同 `*`）。实测 `electron/**/*.js` 只展开出 `electron/tools/*.js`，`electron/` 下一层的源码会被整片漏掉 —— 别再写不带 `shopt -s globstar` 的 `**` 通配。
- 目录为空 / 无匹配时，未开 `nullglob` 会把字面量 `<目录>/**/*.js` 当成文件名喂给 `node --check`，输出一堆假 FAIL；`-name '*.js'` 的 find 写法不存在这个问题。
- 注意：嵌入模板字符串的文案里，反引号是代码不是 Markdown；单引号字符串里才安全。
- 本项目现成脚本：WorkBuddy 侧技能 `localai-electron-feature` 自带 `scripts/check-syntax.cjs`（无参数即扫整个 `electron/`，也可传 `dist-electron` 等目录），比手写循环更省事。

**Vue 3 SFC**
- `npx eslint --fix <改动的文件>`（只跑改动文件）
- 用 `@vue/compiler-sfc` 做秒级编译校验：`parse` + `compileScript` + `compileTemplate`，任一报错即修。

**TypeScript（不跑全项目）**
- 只对改动文件跑单文件转译或确认类型引入正确；类型整体一致性交给用户的打包流程。

**Python**
```bash
python -m py_compile <改动的 .py 文件...>
```
- 长脚本一律先写成 `.py` 文件再执行，禁止 inline `python -c`（Windows 引号/转义易炸）。

**Java**
- 环境可用时 `mvn -q compile`（限当前模块）；不可用时至少人工确认 import / 类名 / 方法签名一致。

## 失败处理

- 失败就照实报失败，**不许含糊带过**。
- 怀疑是改动前就存在的问题：用 HEAD 版本跑同一检查做对照，给出证据再下「与本次改动无关」的结论。
- 构建产物目录（`dist*/`、`release/`）参与过构建后也要扫一遍语法（这类目录常被 .gitignore 遮住，容易漏）。
