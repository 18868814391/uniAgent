---
name: xlsx
description: "Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .xltx, .csv, or .tsv file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadsheet from scratch or from other data sources; or convert between tabular file formats. Trigger especially when the user references a spreadsheet file by name or path — even casually (like \"the xlsx in my downloads\") — and wants something done to it or produced from it. Also trigger for cleaning or restructuring messy tabular data files (malformed rows, misplaced headers, junk data) into proper spreadsheets. The deliverable must be a spreadsheet file. Do NOT trigger when the primary deliverable is a Word document, HTML report, standalone Python script, database pipeline, or Google Sheets API integration, even if tabular data is involved."
license: Proprietary. LICENSE.txt has complete terms
---

# XLSX creation, editing, and analysis

| Task | Approach |
|---|---|
| **Create** or **edit** with formulas/formatting | `openpyxl` — see gotchas below |
| **Bulk data** in or out | `pandas` (`read_excel`, `to_excel`) |
| **Quick look** at a sheet | `markitdown file.xlsx` — `## SheetName` per sheet; reads `.xlsm` too. No cell coordinates, so don't plan edits from it |
| **Read** a model (formulas *and* values) | two `load_workbook` passes — see gotchas |

> `openpyxl`, `pandas`, and `markitdown` are preinstalled — do not run `pip install` first; write the script and import directly. Only if an import fails (or the `markitdown` command is missing): `pip install` the missing package.

> Script paths below are relative to this skill's directory.

## Requirements for every output

- **Professional font** (Arial, Times New Roman) throughout, unless the user says otherwise.
- **Zero formula errors.** Never ship while `recalc.py` reports `errors_found`. If you think an error predates you, prove it: load the *original* with `data_only=True` and look at that cell. An error you introduced looks exactly like one you inherited.
- **Use formulas, never hardcoded results.** Write `sheet['B10'] = '=SUM(B2:B9)'`, not the Python-computed total. The sheet must recalculate when its inputs change.
- **Follow the user's spec literally.** Exact tab names, exact column headers, and the formula they spelled out. A redesign that computes something else fails, however elegant.
- **Document every assumption and hardcoded number** where the reader will see it — a cell comment, or an adjacent cell at a table's end. Cite a real source when one exists (`Source: Company 10-K, FY2024, Page 45, Revenue Note, [SEC EDGAR URL]`); when the number came from the user, say so plainly.
- **A workbook *you create* for someone to fill in** needs a short legend naming which cells to edit, and one example row of realistic values showing the expected format. Never add such a row to a file you were asked to edit.
- **Editing an existing file: match its conventions exactly.** They override every guideline here. Find its designated input cells first — a distinct font color, fill, or shading marks them — write only there, and leave every existing formula untouched.

## Recalculate or validate (do this whenever the file contains formulas)

openpyxl writes formulas as strings with **no cached values**. Until something
recalculates them, every formula cell reads back as `None` to anything reading
cached values — `pandas`, `load_workbook(data_only=True)`, and most previewers.
Excel/WPS themselves recompute on open, so a formula-only file is fine for
humans; the gap only matters for software that reads cached values.

`recalc.py` has **three modes** (default `--check`: the file is **never**
modified — formulas always survive):

```bash
{{PYTHON_CMD}} scripts/recalc.py output.xlsx [timeout_seconds]   # --check 内存校验，不写盘（默认）
{{PYTHON_CMD}} scripts/recalc.py output.xlsx --bake              # 静态快照：值覆盖公式（公式会丢）
{{PYTHON_CMD}} scripts/recalc.py output.xlsx --cache             # 保公式 + 写缓存值（需 LibreOffice）
```

- **`--check`（默认）** — pycel 在内存中求值全部公式并报告错误，**不落盘**。
  交付给用户继续编辑的公式文件用它验证即可：公式原样保留，Excel/WPS 打开
  自动重算出值。校验公式逻辑是否正确也用它。
- **`--bake`** — pycel 求值后用计算值覆盖公式并保存。这是**一次性静态快照**：
  保存后文件不再含公式，无法再联动更新。只在产物之后只会被程序
  （pandas / `data_only` 读取）消费、不会再被编辑时使用。
- **`--cache`** — 通过 LibreOffice 写缓存值但**保留公式**（唯一"公式 + 缓存值"
  两全的路径）。LibreOffice 是**可选**安装（约 300MB，设置页单独安装，不会抢占
  文件关联）；未安装时该模式直接报错并提示改用 `--bake` / `--check`。
  注意一个 LO 语义边界：内容**恰好等于**错误串（如文本 `#N/A`、`#DIV/0!`）的
  单元格，LO 保存时会把它升格为公式错误（打开即显示 `#N/A`）——如果源数据里
  这类"错误串文本"是业务数据，`--cache` 前先改写它们；仅*包含*这些字样的长文本
  （如 `说明：#N/A 请检查`）不受影响，不会被误报。

返回 JSON：`mode`（实际执行的模式）、`file_modified`（是否改写了文件，
`--check` 恒为 `false`）、`status`（`success` | `errors_found`）、
`total_formulas`、`total_errors`、`error_summary`（每个错误类型最多 100 个
单元格，`locations_truncated` 表示截断数量——以 `total_errors` 为准）、
`unresolved_formulas`（check/bake 下 pycel 求值失败、保持原样的公式清单）。
**JSON 含 `error` 键而非 `status` 表示本次运行失败**（文件未校验/未改写），
只有这种失败非零退出——`errors_found` 退出 0，不要把正常退出当作没问题。

**绿色重算只证明公式能*计算*，不证明*正确*。** 范围偏差或引用错误行会生成无错误但数值错误的文件。先写 2-3 个公式验证数值正确，再扩展到完整网格。

**链接到其他文件的工作簿会丢失链接**，如果用 openpyxl 重保存再重算。这类公式如 `='[1]Returns Analysis'!$B$2`——`[1]` 是外部引用索引，指向磁盘上的*另一个文件*。该文件通常不在这里，所以单元格的缓存值是唯一数据。openpyxl 保存时剥离该值，LibreOffice 尝试解析失败写入 `#NAME?` 并删除所有链接。`recalc.py` 在写盘模式（`--bake`/`--cache`）下检测到这种情况会拒绝运行——在保存前复制这些单元格的值（`--force` 覆盖并接受损失）。`--check` 不写盘、不受影响。

## Choosing formulas that survive verification

pycel 实现了大多数 Excel 函数，但不支持 XLOOKUP、XMATCH 等 Office 365 新函数。这些函数在 `--check`/`--bake` 下会落入 `unresolved_formulas` 报告；要用它们，只能装 LibreOffice 走 `--cache`（写缓存值时同时保留公式），或在 Python 中完成排序/筛选/去重后再写入单元格。

- **优先使用 Excel-2007 时代函数** — `SUMIFS`、`INDEX`、`MATCH`、`IFERROR`、`SUMPRODUCT` — 无需前缀。
- **六个 post-2007 函数可用，但需要 `_xlfn.` 前缀**，因为 openpyxl 将公式原样写入 XML，Excel 存储 post-2007 名称时带前缀（UI 隐藏）：`_xlfn.TEXTJOIN`、`_xlfn.CONCAT`、`_xlfn.IFS`、`_xlfn.SWITCH`、`_xlfn.MAXIFS`、`_xlfn.MINIFS`。不带前缀会得到 `#NAME?`。
- **XLOOKUP、XMATCH、SORT、FILTER、UNIQUE、SEQUENCE**：pycel 不支持这些函数。要用它们只能装 LibreOffice 走 `--cache`，或在 Python 中完成排序/筛选/去重后再写入单元格。
- pycel 无法解析的公式会保持原样——快速识别方法是查看 `#NAME?` 错误。

## openpyxl gotchas

- **Reading a model takes two loads.** `data_only=True` yields cached values with the formulas gone; the default yields formula strings with no values. One pass cannot give you both.
- **`data_only=True` is destructive if you save.** That workbook has no formulas left, so saving replaces every one with a literal — permanently.
- **`data_only=True` on a file openpyxl just wrote returns `None` everywhere** — that is normal; write cached values only when software will read them: `--cache` keeps formulas (needs LibreOffice) or `--bake` bakes static values. (A formula whose result is `""` also reads back as `None`.)
- **Merged cells: write the top-left anchor only.** Every other cell in the range is a `MergedCell` whose `.value` is read-only.
- **`.xlsm` loses its macros unless you pass `keep_vba=True`** to `load_workbook`.
- **A sheet name containing a space must be quoted** in a cross-sheet reference: `='Assumptions Inputs'!$B$5`. Unquoted, it evaluates to `#VALUE!`.

## Financial models

Unless the user says otherwise, or the existing file already does something else.

**Color:** blue text (`0,0,255`) for hardcoded inputs and scenario levers · black for formulas ·
green (`0,128,0`) for links to another sheet · red (`255,0,0`) for links to another file ·
yellow fill (`255,255,0`) for key assumptions and cells the user should fill in.

**Numbers:** currency `$#,##0`, with the unit named in the header (`Revenue ($mm)`) · zeros
render as `-`, including in percentages (`$#,##0;($#,##0);-`) · negatives in parentheses ·
percentages `0.0%`, **stored as fractions** (`0.15` renders `15.0%`; storing `15` renders
`1500.0%`) · valuation multiples `0.0x` · years as text (`"2024"`, never `2,024`).

**Structure:** every assumption in its own labeled cell, referenced by the formulas that use it
(`=B5*(1+$B$6)`, never `=B5*1.05`) · formulas consistent across every projection period, since a
lone edited cell mid-row is the commonest silent error · guard denominators that can be zero.

## Dependencies

`openpyxl`、`pandas`、`markitdown`、`pycel`（pip，预安装——仅在导入失败或命令缺失时安装）· LibreOffice（`soffice`，**可选**，约 300MB，设置页单独安装、不抢文件关联——仅 `--cache` 写缓存值保公式、Word/PPT 转 PDF 时需要；`--check`/`--bake` 不需要它）
