---
name: xl-chart
description: "图表生成。当用户提到'图表/画图/柱状图/折线图/饼图/散点图/趋势图/可视化/做图'时触发。基于 openpyxl 生成 Excel 图表。"
---

# xl-chart（图表生成）

## 适用

- 在 Excel 文件中生成图表（柱状、折线、饼图、散点、组合图）
- 为数据添加可视化展示
- 用户说"帮我画个图""做个图表""可视化一下"

## 图表类型速查

| 类型 | 适用场景 | openpyxl 类 |
| --- | --- | --- |
| 柱状图 | 分类对比 | `BarChart` |
| 折线图 | 趋势变化 | `LineChart` |
| 饼图 | 占比构成 | `PieChart` |
| 散点图 | 相关性分析 | `ScatterChart` |
| 面积图 | 趋势+累计 | `AreaChart` |
| 组合图 | 多维度展示 | `BarChart` + `LineChart` |

## 图表模板

### 柱状图

```python
from openpyxl import load_workbook
from openpyxl.chart import BarChart, Reference

wb = load_workbook('data.xlsx')
ws = wb.active

chart = BarChart()
chart.type = 'col'
chart.title = '各部门费用汇总'
chart.y_axis.title = '金额（元）'
chart.x_axis.title = '部门'
chart.style = 10

# 数据区域（含标题行）
data = Reference(ws, min_col=2, min_row=1, max_col=2, max_row=ws.max_row)
# 类别标签
cats = Reference(ws, min_col=1, min_row=2, max_row=ws.max_row)

chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)
chart.shape = 4  # 圆角柱
chart.width = 20
chart.height = 12

ws.add_chart(chart, 'D2')
wb.save('data_with_chart.xlsx')
```

### 折线图

```python
from openpyxl.chart import LineChart, Reference

chart = LineChart()
chart.title = '月度趋势'
chart.y_axis.title = '金额'
chart.style = 10
chart.width = 22
chart.height = 14

data = Reference(ws, min_col=2, max_col=7, min_row=1, max_row=13)  # 6 个系列
cats = Reference(ws, min_col=1, min_row=2, max_row=13)

chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)

# 每条线样式
for s in chart.series:
    s.smooth = True

ws.add_chart(chart, 'A15')
```

### 饼图

```python
from openpyxl.chart import PieChart, Reference

chart = PieChart()
chart.title = '费用构成'
chart.style = 10
chart.width = 16
chart.height = 12

data = Reference(ws, min_col=2, min_row=1, max_row=ws.max_row)
cats = Reference(ws, min_col=1, min_row=2, max_row=ws.max_row)

chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)

# 显示百分比标签
from openpyxl.chart.label import DataLabelList
chart.dataLabels = DataLabelList()
chart.dataLabels.showPercent = True
chart.dataLabels.showCatName = True

ws.add_chart(chart, 'D2')
```

### 组合图（柱状+折线）

```python
from openpyxl.chart import BarChart, LineChart, Reference

# 柱状图（主轴）
bar = BarChart()
bar.title = '费用与趋势'
bar.y_axis.title = '金额'

data_bar = Reference(ws, min_col=2, min_row=1, max_row=ws.max_row)
cats = Reference(ws, min_col=1, min_row=2, max_row=ws.max_row)
bar.add_data(data_bar, titles_from_data=True)
bar.set_categories(cats)

# 折线图（次轴）
line = LineChart()
line.y_axis.title = '增长率'
data_line = Reference(ws, min_col=3, min_row=1, max_row=ws.max_row)
line.add_data(data_line, titles_from_data=True)
line.y_axis.axId = 200  # 次轴 ID

# 组合
bar.y_axis.crosses = 'max'
bar += line

bar.width = 22
bar.height = 14
ws.add_chart(bar, 'D2')
```

## 样式配置

- 颜色方案：`chart.style = 10`（默认商务风格），可用 0-48
- 柱状图用 `chart.shape = 4`（圆角）更美观
- 图表大小：宽度 16-24，高度 10-16，根据数据量调整
- 字体：图表标题 14pt 加粗，轴标题 11pt，标签 9pt

## 输出要求

图表生成后输出：
- 图表类型和标题
- 数据范围说明
- 输出文件路径
