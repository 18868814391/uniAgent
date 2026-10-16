---
name: xl-format
description: "格式化与样式。当用户提到'格式/样式/美化/条件格式/数据验证/边框/颜色/列宽/行高/冻结/打印/页眉页脚'时触发。"
---

# xl-format（格式化）

## 适用

- 美化表格（字体、边框、填充、对齐）
- 设置条件格式（高亮、数据条、色阶）
- 数据验证（下拉列表、数值范围、日期范围）
- 列宽/行高调整、冻结窗格
- 打印布局（页眉页脚、分页符、缩放）

## 步骤

1. **先读取**：用 `xl-read` 确认列结构/表头行位置。
2. **首选：跑预置脚本 `xl_format.py`**（覆盖常规美化：表头/边框/对齐/列宽/冻结/筛选/斑马纹/数字格式）。
3. **CLI 覆盖不了的**（条件格式 / 数据验证 / 打印设置 / 复杂自定义样式）→ 自写 openpyxl 脚本兜底（模板见下）。
4. 完成后提示：格式类产物**数据可能相同、版式需打开确认**；含图表/公式的文件提醒先人工打开重算一次。

## 首选：常规美化 `xl_format.py`

```bash
{{PYTHON_CMD}} {{BUILTIN_SKILLS_DIR}}/xlsx/scripts/xl_format.py <输入.xlsx> <输出.xlsx> [选项]
```

基于 openpyxl **在原工作簿上另存**，保留原数据/公式/既有格式；**输出不能与输入同名**；
输入为 csv/tsv 时先 `xl_convert.py` 转 xlsx。

| 诉求 | 参数 | 默认 |
| --- | --- | --- |
| 表头底色/字色/加粗 | `--header-fill 70AD47 --header-color FFFFFF [--no-header-bold]` | 4472C4 / FFFFFF / 加粗 |
| 表头在其它行 | `--header-row 2` | 第 1 行 |
| 表头换行 | `--wrap-header` | 关 |
| 冻结首行 | `--freeze A2`（`--no-freeze` 关） | A2 |
| 自动筛选 | `--autofilter` / `--no-autofilter` | 开 |
| 自适应列宽 | `--auto-width 40`（`--no-auto-width` 关） | 开，上限 50 |
| 手工列宽 | `--col-width 姓名=18,金额=14`（列=字母或表头名） | — |
| 细边框 | `--thin-border` / `--no-thin-border` | 开 |
| 斑马纹 | `--banded [--banded-fill D9E2F3]` | 关 |
| 数字格式 | `--number-format 金额=#,##0.00,占比=0.0%` | — |
| 数据对齐 | `--align-data center\|left\|right` | 不强制 |

```bash
{{PYTHON_CMD}} {{BUILTIN_SKILLS_DIR}}/xlsx/scripts/xl_format.py 数据.xlsx 数据_美化.xlsx \
    --number-format 金额=#,##0.00 --col-width 备注=40 --align-data center --banded
```

返回 JSON：`sheet/rows/cols/operations`（每步样式动作）。

## 高级格式化：自写 openpyxl 模板（CLI 未覆盖时用）

> openpyxl gotcha（合并单元格只写左上角、`data_only=True` 破坏性、`.xlsm` 需 `keep_vba=True`）以内置 `xlsx` 技能为准。

### 条件格式

```python
from openpyxl import load_workbook
from openpyxl.formatting.rule import CellIsRule, DataBarRule, ColorScaleRule
from openpyxl.styles import Font, PatternFill

wb = load_workbook('input.xlsx')   # 不要 data_only，避免破坏公式
ws = wb.active

# 高亮大于 10000 的金额
ws.conditional_formatting.add(
    'B2:B1000',
    CellIsRule(operator='greaterThan', formula=['10000'],
               font=Font(bold=True, color='FF0000'),
               fill=PatternFill(start_color='FFF2CC', fill_type='solid'))
)
# 数据条 / 三色色阶（红-黄-绿）
ws.conditional_formatting.add('C2:C1000',
    DataBarRule(start_type='min', end_type='max', color='4472C4'))
ws.conditional_formatting.add('D2:D1000',
    ColorScaleRule(start_type='min', start_color='F8696B',
                   mid_type='percentile', mid_value=50, mid_color='FFEB84',
                   end_type='max', end_color='63BE7B'))
wb.save('output.xlsx')
```

### 数据验证（下拉列表 / 数值范围）

```python
from openpyxl.worksheet.datavalidation import DataValidation

dv = DataValidation(type='list', formula1='"已审核,待审核,已驳回"', allow_blank=True)
dv.error, dv.errorTitle = '请从列表中选择', '输入无效'
ws.add_data_validation(dv); dv.add('E2:E1000')

dv2 = DataValidation(type='decimal', operator='between', formula1='0', formula2='100')
ws.add_data_validation(dv2); dv2.add('F2:F1000')
```

### 打印设置（横版 / 一页宽 / 页眉页脚）

```python
ws.page_setup.orientation = 'landscape'
ws.page_setup.paperSize = ws.PAPERSIZE_A4
ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 0   # 缩放一页宽、高度不限
ws.page_margins.left = ws.page_margins.right = 0.5
ws.oddHeader.center.text = '月度经营报表'
ws.oddFooter.center.text = '第 &P 页 / 共 &N 页'
```

## 输出要求

- 列出做了哪些样式动作 + 输出文件**绝对路径**
- 涉及行高/复杂版式时提醒用户打开确认效果（格式正确性无法像数据那样程序化断言）
