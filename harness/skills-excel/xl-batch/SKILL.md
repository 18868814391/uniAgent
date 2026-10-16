---
name: xl-batch
description: "批量处理。当用户提到'批量/多个文件/模板/合并所有/拆分/按部门拆/按月拆/生成报表/填充模板'时触发。处理多文件合并、模板填充、按维度拆分等批量操作。"
---

# xl-batch（批量处理）

## 适用

- 多个同结构 Excel 文件合并为一个
- 按某列维度拆分为多个文件（如按部门拆分）
- 模板填充（从模板 + 数据源生成多份报表）
- 定期报告批量生成

## 常用批量操作

### 多文件合并

```python
import pandas as pd
import glob, os

files = glob.glob('data/*.xlsx')  # 所有 xlsx 文件
print(f'共 {len(files)} 个文件待合并')

dfs = []
for f in files:
    df = pd.read_excel(f)
    df['_来源文件'] = os.path.basename(f)  # 标记来源
    dfs.append(df)
    print(f'  {os.path.basename(f)}: {len(df)} 行')

result = pd.concat(dfs, ignore_index=True)
print(f'\n合并完成：共 {len(result)} 行')

result.to_excel('合并结果.xlsx', index=False)
```

### 按维度拆分

```python
import pandas as pd
import os

df = pd.read_excel('input.xlsx')
split_col = '部门'  # 按此列拆分

os.makedirs('拆分结果', exist_ok=True)

for name, group in df.groupby(split_col):
    safe_name = str(name).replace('/', '_').replace('\\', '_')
    path = f'拆分结果/{safe_name}.xlsx'
    group.drop(columns=[split_col]).to_excel(path, index=False)
    print(f'{name}: {len(group)} 行 → {path}')

print(f'\n共拆分为 {len(df[split_col].unique())} 个文件')
```

### 模板填充

```python
import pandas as pd
from openpyxl import load_workbook

# 读取模板和数据
wb = load_workbook('template.xlsx')
ws = wb.active
data = pd.read_excel('data.xlsx')

# 找到模板中的占位符位置（如 {{姓名}}、{{金额}}）
# 假设数据从第 3 行开始填充，模板格式在前 2 行
START_ROW = 3

for i, (_, row) in enumerate(data.iterrows()):
    r = START_ROW + i
    ws.cell(row=r, column=1, value=row['姓名'])
    ws.cell(row=r, column=2, value=row['部门'])
    ws.cell(row=r, column=3, value=row['金额'])
    # 复制模板行的格式
    for col in range(1, 4):
        ws.cell(row=r, column=col).font = ws.cell(row=START_ROW-1, column=col).font
        ws.cell(row=r, column=col).border = ws.cell(row=START_ROW-1, column=col).border

wb.save('填充结果.xlsx')
print(f'已填充 {len(data)} 行数据')
```

### 多文件汇总报表

```python
import pandas as pd
import glob

summary = []
for f in glob.glob('月报/*.xlsx'):
    df = pd.read_excel(f)
    summary.append({
        '文件': f.split('/')[-1],
        '总行数': len(df),
        '总金额': df['金额'].sum() if '金额' in df.columns else 0,
        '非空率': round(df.notna().mean().mean() * 100, 1),
    })

result = pd.DataFrame(summary)
result.to_excel('汇总报表.xlsx', index=False)
print(result.to_string(index=False))
```

## 输出要求

批量操作完成后输出：
- 处理了多少个文件/维度
- 每个子任务的结果摘要（行数、文件路径）
- 输出目录和文件列表
