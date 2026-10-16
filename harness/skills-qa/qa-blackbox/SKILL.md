---
name: qa-blackbox
description: 黑盒引导式测试。仅当用户明确打开页面并引导时启用 browser_* 工具（browser_snapshot 看一次 + browser_flow 批量执行），由用户指引下一步，AI 执行并记录步骤与结果；绝不主动打开页面、不擅自截图。
---

# qa-blackbox（黑盒引导式测试）

## 启用条件（严格）

只有满足以下之一才进入黑盒流程：

- 用户**明确要求**打开某个页面并测试；
- 用户**已打开**测试浏览器/ERP 页面并请你操作。

**不满足时不要用 browser_* 工具**：用户只说「测试某功能」且没给代码路径 → 应走白盒；用户只说「打开 ERP」没说测什么 → 打开页面后交给用户，不主动点击寻找目标。

## 工具用法要点

- **页面感知优先 `browser_snapshot()`**：返回可交互元素紧凑清单，每项带 `ref`（不再返回 CSS 选择器）；同时给 `total`（全部候选数，判断是否被截断）与 `duplicates`（重名统计，如 `{"编辑":400}`）。比 `browser_get_page` 省得多。
- **批量执行优先 `browser_flow()`**：把一串已确定的步骤**一次**交给它（`steps: [{action, target, value}]`），顺序执行 + 断言，失败即停并回传失败那步的上下文与当前快照。20 步只花 1 次往返，而"每步快照 + 每步点击"要 40+ 次。
  - action：`click` / `type` / `press` / `wait` / `goto` / `sleep` / `assertText` / `assertValue` / `assertVisible` / `assertUrl` / `assertEval`
- 只有单步操作才用 `browser_click(target)` / `browser_type(target, text)` / `browser_press(key)`；`target` 优先用 snapshot 给的 `ref`（如 `ref=23`），也支持 CSS 或 `text=文本`。
- **同名元素（表格行内的「编辑/删除」）必须用 `ref`，或写 `text=编辑 >> nth=57`（0 起）** —— 裸 `text=编辑` 永远只命中第一个，点错了也发现不了。
- 动态内容先 `browser_wait_for(selector 或 condition)` 再操作。
- 需要读正文/结果时用 `browser_get_page()`。
- 需要看控制台错误用 `browser_console_logs()`。
- **`browser_screenshot` 默认禁用**（你无法看图）；仅当用户明确要截图时调用一次。
- 跑通的流程用 `browser_flow({ saveAs: '流程名' })` 固化成 YAML；之后 `browser_flow({ flow: '流程名' })` **零模型**回放（回归期直接重跑，不再消耗往返）。

## 流程

1. 用户明确目标后，打开页面（或复用已打开的），`browser_snapshot` 确认页面状态，向用户简述你看到了什么。
2. **把用户指引的步骤写成 `browser_flow` 一次执行**；不要每步都重新快照 —— 那是往返次数与上下文膨胀的主要来源。每步记录：`步骤 | 操作 | 页面结果`。
3. 遇到不确定的目标元素，用 `ask_user` 请用户确认或纠正方向，不盲点。
4. 失败时看 `browser_flow` 回传的 `failedAt` + `snapshot`（那就是失败时刻的页面状态，不必再补一次快照）→ 修正后重跑。
5. 操作中出现报错/异常 → 记 `browser_console_logs()` 证据。
6. 结束或用户喊停 → 汇总步骤回放与结果，如需正式留档用 `qa-report` 输出黑盒测试记录；跑通的流程建议 `saveAs` 固化，便于回归重跑。

## 输出

- 对话内给出步骤回放摘要；如需留档，写 `{{TEST_OUTPUT_DIR}}/<任务slug>-黑盒测试记录.md`（步骤回放 + 结果 + 问题清单）。
