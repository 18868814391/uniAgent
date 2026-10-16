---
name: xl-transform
description: "数据变换。当用户提到'汇总/统计/分组/透视/pivot/合并/merge/筛选/排序/拼接/关联'时触发。处理分组聚合、透视表、多表合并、排序筛选、数据透视等。"
---

# xl-transform（数据变换）

## 适用

- 按某列分组统计（求和、计数、平均值等）
- 生成透视表（行列交叉汇总）
- 多个 Sheet 或文件的数据合并/拼接
- 按条件筛选数据
- 多表关联（类似 VLOOKUP / SQL JOIN）

## 步骤

1. **先读取**：用 `xl-read`（`xl_summarize.py`）确认源表结构与关键列名，再组命令。
2. **确认方案**：合并/覆盖/批量等场景按约定确认后再执行；写操作前先备份原文件。
3. **跑预置 CLI**（首选，见下）；CLI 覆盖不了（>2 文件拼多 sheet、复杂聚合重命名等）才自写 pandas。
4. **验证 + 交付**：读输出核对行数/列数，给用户前 10 行 markdown 预览 + 绝对路径。

## 首选：直接跑预置脚本 `xl_transform.py`

```bash
{{PYTHON_CMD}} {{BUILTIN_SKILLS_DIR}}/xlsx/scripts/xl_transform.py <输入> <输出> <操作> [选项]
```

输出扩展名决定格式（.xlsx/.csv/.tsv）。**输出不能与输入同名**。默认第一个 sheet（`--sheet` 指定）。

### 操作速查

| 用户诉求 | 操作 + 参数示例 |
| --- | --- |
| 分组汇总 | `groupby --group-by 部门,月份 --agg 金额=sum,笔数=count`（函数：sum/mean/median/min/max/count/nunique/first/last/std） |
| 透视表 | `pivot --index 部门 --columns 月份 --values 金额 --aggfunc sum --fill 0 --margins` |
| 条件筛选 | `filter --query "金额 > 10000 and 状态 == '已审核'"` |
| 排序 | `sort --by 日期:asc,金额:desc` |
| 两表关联 | `merge --right 附表.xlsx --on 订单号 --how left`（默认 inner；on 可多列逗号分隔） |
| 同构多文件/多 sheet 拼接 | `concat --right 文件A.xlsx,文件B.csv --right-sheet Sheet1`（--right 可重复、支持 * 通配） |

### 规则与坑（汇报口径）

- **query 语法**：字符串值必须带引号（`'已审核'`）；日期比较建议先转字符串（`"日期 >= '2024-01-01'"`）；列名含空格/特殊字符用反引号包住（`` `列 名` ``）。query 报错会提示这些规则，照提示修正即可。
- **groupby 聚合列命名**：`<原列>_<函数>`（如 `金额_sum`）；未给 `--agg` 时输出每组行数 `count`。
- **pivot**：`--index` 目前单列；`--margins` 加合计行列（`--margins-name 合计` 改名）。
- 返回 JSON 含 `rows/cols/operations/preview`（前 5 行），据此整理中文摘要，不要原样贴 JSON。

### 示例

```bash
# 按部门汇总销售额，转 csv
{{PYTHON_CMD}} {{BUILTIN_SKILLS_DIR}}/xlsx/scripts/xl_transform.py 订单.xlsx 部门汇总.csv groupby \
    --group-by 部门 --agg 销售额=sum,订单数=count

# 主表关联价格附表后筛选高价值订单
{{PYTHON_CMD}} {{BUILTIN_SKILLS_DIR}}/xlsx/scripts/xl_transform.py 订单.xlsx 结果.xlsx merge \
    --right 价格表.xlsx --on SKU --how left
```

## 超出 CLI 的场景（自写脚本兜底）

- >2 个文件/多 sheet 的合并、复杂聚合+自定义列名、`crosstab`、拼接前逐表清洗等：

```python
import pandas as pd, glob
dfs = [pd.read_excel(f) for f in glob.glob('data_*.xlsx')]
result = pd.concat(dfs, ignore_index=True)

# 多 sheet 横向拼接
with pd.ExcelFile('input.xlsx') as xl:
    result = pd.concat([pd.read_excel(xl, sheet_name=s) for s in xl.sheet_names], ignore_index=True)

# 自定义命名聚合
res = df.groupby('部门').agg(合计金额=('金额', 'sum'), 笔数=('金额', 'count')).reset_index()
result.to_excel('输出_merged.xlsx', index=False)
```

- 关联/透视后如果还带公式或原格式需求，注意 pandas 写出**不保留原样式/公式**；需要保留的走 openpyxl（内置 `xlsx` 技能 gotcha）。

## 输出要求

变换完成后输出：
- 操作描述（按什么分组、合并了哪些表、how 类型等）
- 结果数据概况（行数、列数）+ 前 10 行 markdown 预览
- 输出文件路径（**绝对路径**）
