---
name: xl-convert
description: "格式转换。当用户提到'转换/导出/csv/json/markdown/转成/另存为'时触发。处理 xlsx↔csv↔json↔markdown 互转。"
---

# xl-convert（格式转换）

## 适用

- Excel 转 CSV / JSON / Markdown
- CSV / TSV 转 Excel
- JSON 转 Excel（见下"JSON → xlsx"）
- Markdown 表格转 Excel（见下）
- 多 Sheet 转多个文件

## 转换速查（直接跑预置脚本，不要自写转换代码）

统一入口：

```bash
{{PYTHON_CMD}} {{BUILTIN_SKILLS_DIR}}/xlsx/scripts/xl_convert.py "<输入>" "<输出>" [--sheet 名称] [--md-limit N]
```

输出文件扩展名决定目标格式：

| 方向 | 命令 |
| --- | --- |
| xlsx → csv（多 sheet 自动展开为 `<名>_<sheet>.csv`） | `xl_convert.py 数据.xlsx 数据.csv` |
| xlsx → json / markdown | `xl_convert.py 数据.xlsx 数据.json` / `... 数据.md` |
| 只转某一个 sheet | 加 `--sheet 订单表`（输出不展开，用你给的文件名） |
| csv / tsv → xlsx | `xl_convert.py 数据.csv 数据.xlsx` |
| xlsx → xlsx（多 sheet 合并写到一个文件） | `xl_convert.py 数据.xlsx 合并.xlsx` |

## 行为口径（汇报时说明给用户）

- **编码**：CSV 输出带 UTF-8 BOM（`utf-8-sig`，Excel 打开不乱码）；CSV 读取自动兜底 `utf-8-sig → gbk → gb18030`，中文 GBK 老文件可直接读。
- **JSON**：records 数组、`ensure_ascii=False`（中文不转义）、日期/NaN 转字符串。
- **Markdown**：手写表格生成，**不依赖 tabulate**；默认最多 50 行，用 `--md-limit 0` 不限、`--md-limit 200` 调大。
- **多 sheet**：目标为 csv/json/md 且未指定 `--sheet` 时，每个 sheet 写一个文件（文件名带 sheet 名）；目标为 xlsx 时所有 sheet 合并写进同一个文件。
- 单表输入（csv/tsv）总是写到你给的输出路径。

## JSON → xlsx / Markdown 表格 → xlsx

这两种没有对应 CLI（需要先把外部数据变成 DataFrame），按下面模板自写小脚本（写入文件后执行）：

```python
import json, io
import pandas as pd

# JSON → DataFrame → xlsx
with open('input.json', 'r', encoding='utf-8') as f:
    df = pd.DataFrame(json.load(f))
df.to_excel('output.xlsx', index=False)

# Markdown 表格文本 → DataFrame → xlsx
md_text = "| 姓名 | 部门 |\n| --- | --- |\n| 张三 | 销售部 |"
df = pd.read_csv(io.StringIO(md_text), sep='|', skipinitialspace=True)
df.columns = [str(c).strip() for c in df.columns]
# 删掉解析产生的空名列与全空列（首尾分隔符导致的）
df = df.drop(columns=[c for c in df.columns if c == '' or df[c].isna().all()])
df.to_excel('output.xlsx', index=False)
```

## 边界

- 转换涉及 xlsx 的**公式单元格**时，转换结果只会带当前缓存值/公式字符串，不等同于 recalc（校验/重算用内置 `xlsx` 技能的 recalc.py）。
- 需要逐单元格格式（合并单元格、样式、条件格式）的转换不属于本技能范围，走 `xl-format`。

## 输出要求

转换完成后输出：
- 转换方向（xlsx → csv 等）与涉及的 sheet
- 每个输出文件的路径与行数（脚本已打印，照抄即可，必须用绝对路径）
- 编码格式（csv = UTF-8 BOM；json = UTF-8）
