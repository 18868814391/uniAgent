---
name: xl-clean
description: "数据清洗。当用户提到'去重/清洗/空值/缺失/异常值/数据有问题/整理一下/修正'时触发。处理去重、空值填充、类型转换、异常值处理、正则提取等。"
---

# xl-clean（数据清洗）

## 适用

- 数据有重复行需要去重
- 空值/缺失值需要填充或删除
- 列类型不对（日期当字符串、数字当文本等）
- 数据有异常值需要处理
- 需要从混合文本中提取特定信息（正则）

## 步骤

1. **先读取**：用 `xl-read`（`xl_summarize.py`）分析文件结构，了解数据现状，再决定清洗参数。
2. **确认方案**：向用户说明要做什么清洗、影响多少行，确认后执行。
3. **备份原文件**：`cp 原文件 原文件.bak`（破坏性清洗必做）。
4. **跑预置 CLI**（首选，见下）；只有 CLI 覆盖不了的逻辑才自写 pandas 脚本。
5. **验证结果**：读取清洗后文件，对比行数/空值变化，输出摘要。

## 首选：直接跑预置脚本 `xl_clean.py`（不要自写基础清洗代码）

```bash
{{PYTHON_CMD}} {{BUILTIN_SKILLS_DIR}}/xlsx/scripts/xl_clean.py <输入> <输出> [选项]
```

输出扩展名决定格式（.xlsx/.csv/.tsv）；csv 自动带 UTF-8 BOM。**输出不能与输入同名。**

### 参数速查（按流水线执行顺序，多个可用就用多个）

| 诉求 | 参数 | 示例 |
| --- | --- | --- |
| 去重 | `--drop-duplicates [--subset 列] [--keep first\|last]` | `--drop-duplicates --subset 订单号` |
| 删空值行 | `--dropna all\|any [--dropna-subset 列]` | `--dropna all`（全空行）/ `--dropna any --dropna-subset 金额` |
| 空值填充 | `--fill-na 值`（全列）/ `--fill 列=值`（按列） | `--fill 金额=0,备注=无` |
| 前值填充 | `--ffill 列1,列2` | `--ffill 日期` |
| 类型转换 | `--cast 列=int\|float\|str\|bool\|date\|datetime` | `--cast 金额=float,日期=date` |
| 去首尾空格 | `--strip 列1,列2`（`*`=全部文本列） | `--strip *` |
| 正则提取新列 | `--extract 新列=源列:正则`（无捕获组自动整体匹配） | `--extract 手机号=备注:1[3-9]\d{9}` |
| 删除列 | `--drop-cols 列1,列2` | `--drop-cols 内部备注` |
| 数值截断 | `--clip 列=min,max`（inf/-inf 不限） | `--clip 百分比=0,100` |
| 重命名 | `--rename 旧列=新列` | `--rename 名称=客户名称` |

流水线固定顺序：rename → cast → strip → extract → drop-cols → dropna → ffill → fill → clip → 去重。
列表值用 **ASCII 逗号**分隔；正则里不要含 `=` 或 `:`。

### 示例组合

```bash
# 去重 + 删全空行 + 金额转数字 + 空值补 0
{{PYTHON_CMD}} {{BUILTIN_SKILLS_DIR}}/xlsx/scripts/xl_clean.py 订单.xlsx 订单_cleaned.xlsx \
    --drop-duplicates --dropna all --cast 金额=float --fill-na 0
```

脚本返回 JSON：`rows/cols/operations`（每步影响）/`nulls_per_column`，据此给用户中文摘要。

## 超出 CLI 的场景（自写脚本兜底，遵守内置 `xlsx` 技能 gotcha）

- 需**先看数据再定口径**的复杂逻辑（如 IQR 异常值过滤、依赖业务规则的清洗、列内多规则分桶）：

```python
import pandas as pd
df = pd.read_excel('input.xlsx')            # 编码兜底见内置 xlsx 技能/xl_utils.read_csv_safe
before = len(df)
# IQR 过滤示例
q1, q3 = df['金额'].quantile([0.25, 0.75])
iqr = q3 - q1
df = df[(df['金额'] >= q1 - 1.5*iqr) & (df['金额'] <= q3 + 1.5*iqr)]
print(f'IQR 过滤：移除 {before - len(df)} 行')
df.to_excel('输出_cleaned.xlsx', index=False)
```

- 大文件（> 5 万行）读写策略见 `excel-conventions.md`「大文件处理」：`pd.read_excel` **没有 chunksize**，大 CSV 用 `pd.read_csv(..., chunksize=10000)`，大 xlsx 用 `load_workbook(read_only=True)` 或 `nrows` 采样。

## 输出要求

清洗完成后输出摘要：
- 每项操作的影响（去重移除 X 行、空值填充 X 个、类型转换 X 列等）
- 清洗后数据概况（总行数、总列数、各列非空率）
- 输出文件路径（**绝对路径**）
