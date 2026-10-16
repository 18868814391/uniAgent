---
name: xl-formula
description: "公式编写与纠错。当用户提到'公式/函数/VLOOKUP/SUMIF/计算/怎么算/公式报错/#NAME/#REF/#VALUE'时触发。编写、修复、优化 Excel 公式。"
---

# xl-formula（公式编写）

## 适用

- 需要在 Excel 中写入公式（非 Python 计算结果）
- 修复现有公式错误（#NAME?、#REF!、#VALUE!、#DIV/0!）
- 优化复杂公式性能
- 用 openpyxl 写入公式单元格

## 核心原则

1. **用公式，不用硬编码结果**。写 `=SUM(B2:B100)` 而非 Python 算出的数字。
2. **pycel 兼容性优先**。openpyxl 写入的公式由 pycel 校验，不兼容的函数会变 `#NAME?`。**兼容性权威规则只维护在内置 `xlsx` 技能**（`read_skill('xlsx')` → "Choosing formulas that survive verification" 段），本技能不重复维护，防止多份漂移。
   速记：Excel 2007 时代函数（SUM/IF/VLOOKUP/INDEX/MATCH/SUMIFS/COUNTIFS/IFERROR 等）直接可用；`TEXTJOIN/CONCAT/IFS/SWITCH/MAXIFS/MINIFS` 需 `_xlfn.` 前缀；`XLOOKUP/XMATCH/SORT/FILTER/UNIQUE/SEQUENCE` pycel 不支持——要么装 LibreOffice 走 recalc `--cache`，要么在 Python 中先算好再写值。
3. **写入后必须校验**。命令见下方 "recalc（必须）"，默认 `--check` 不写盘、公式保留。

## openpyxl 写入公式

```python
from openpyxl import load_workbook

wb = load_workbook('input.xlsx')
ws = wb.active

# 单元格写入公式
ws['B10'] = '=SUM(B2:B9)'
ws['C10'] = '=IF(B10>0,"有数据","无数据")'

# 跨 Sheet 引用（Sheet 名有空格要加引号）
ws['D10'] = "=SUM('Sheet 2'!D2:D9)"

# SUMIFS 示例
ws['E10'] = '=SUMIFS(F2:F99, B2:B99, "销售部", D2:D99, ">="&DATE(2024,1,1))'

wb.save('output.xlsx')
```

## 公式纠错流程

1. 读取文件（默认模式拿公式字符串，`data_only=True` 拿缓存值）
2. 定位出错单元格，检查公式文本
3. 常见错误对照：
   - `#NAME?` → 函数名不兼容（需 `_xlfn.` 前缀或替换为兼容函数）
   - `#REF!` → 引用的单元格/Sheet 不存在
   - `#VALUE!` → 参数类型错误（文本当数字用）
   - `#DIV/0!` → 除数为零（加 `IFERROR` 保护）
   - `#N/A` → VLOOKUP 找不到匹配值（加 `IFERROR` 保护）
4. 修复后用 recalc 验证（见下）

## recalc（校验，必须）

公式写入后必须运行内置校验脚本。**recalc.py 的三种模式（`--check`/`--bake`/`--cache`）、适用场景与返回 JSON 的完整字段，以内置 `xlsx` 技能为准**（`read_skill('xlsx')` → "Recalculate or validate" 段），本技能只给默认用法：

```bash
# 默认 --check：pycel 内存校验、不写盘、公式保留 —— 交付给用户继续编辑的公式文件一律用它
{{PYTHON_CMD}} {{BUILTIN_SKILLS_DIR}}/xlsx/scripts/recalc.py output.xlsx
```

- 看返回 JSON 的 `status`：`success` 通过；`errors_found` 有错误需修复后重跑；含 `error` 键表示运行失败（文件未校验）。`errors_found` 的退出码是 0，别把"正常退出"当"没问题"。
- `--bake`（值覆盖公式、公式会丢）仅给之后只会被程序消费的快照用；`--cache`（保公式 + 写缓存值）需 LibreOffice。两者细节与坑（如 `#N/A` 文本升格）都在内置 xlsx 技能中，勿凭记忆猜测。
- 提示找不到 recalc.py 时，先 `read_skill('xlsx')` 确认内置技能路径，并检查 pycel 是否安装（`{{PYTHON_CMD}} -c "import pycel"`）。
- recalc.py 自带求值超时熔断（默认 30s），大公式文件报 "timed out" 时传第 2 个位置参数调大：`{{PYTHON_CMD}} {{BUILTIN_SKILLS_DIR}}/xlsx/scripts/recalc.py output.xlsx 120`（与 execute_command 进程超时上限 300s 是两码事）。
