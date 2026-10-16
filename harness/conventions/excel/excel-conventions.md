# Excel专家输出规范

Excel专家角色的所有产物必须遵守本规范。

## 1. 数据安全（最高优先级）

- **写操作前备份**：对已有文件进行任何修改前，先复制为 `<文件名>.bak`。
- **不覆盖源文件**：输出文件名默认加后缀（`_processed`、`_cleaned`、`_output`），除非用户明确要求覆盖。
- **保留原始数据**：清洗/变换时，用 `df.copy()` 操作副本，原始数据始终可追溯。
- **破坏性操作确认**：删除整列、清空 Sheet、批量覆盖等操作前，用 `ask_user` 确认。

## 2. Python 脚本规范

- **所有操作写成 Python 脚本**（openpyxl / pandas），可重复执行。
- **脚本存放位置**：过程脚本与中间文件一律写到系统在本轮系统提示词【脚本执行模式】里给出的**会话级临时工作目录**（形如 `<授权目录>/.xl-work/<本轮唯一目录名>`，宿主每轮创建、本轮对话结束自动删除）。**必须原样照抄那个完整绝对路径** —— 不要简化成 `<授权目录>/.xl-work/`、不要自造目录名：写在 `.xl-work` 根下的脚本不属于任何一轮，宿主不会自动清理（会一直堆在那里）。**不要把脚本写在授权目录根部或产物目录里**——那里的脚本同样不会被自动清理、会越积越多。最终交付文件（xlsx/csv/图表）写授权目录，命名见 §6。
- **脚本开头标注输入输出路径**，用 `sys.argv` 或硬编码但加注释。
- **进度输出**：处理超过 100 行时，每 100 行输出一次进度。
- **异常处理**：用 `try/except` 包裹关键操作，失败时输出明确错误信息。
- **结果摘要**：脚本末尾输出操作摘要（处理行数、变化统计、输出路径）。

## 3. 大文件处理

超过 50,000 行的文件必须用以下策略，避免内存溢出或卡死：

- **大 CSV 分块读取**：`for chunk in pd.read_csv('input.csv', chunksize=10000): ...` 逐块处理，不要一次性全量加载。
  ⚠️ 注意：`pd.read_excel` **没有 chunksize 参数**（那是 `read_csv` 系列才有的），大 xlsx 不能这样分块。
- **大 Excel 采样/只读**：需要 DataFrame 分析时先 `pd.read_excel(path, nrows=1000)` 采样确认结构（xl-read 的 `xl_summarize.py` 已内置此口径），再决定是否全量；
  只需要逐行遍历单元格时用 `load_workbook('input.xlsx', read_only=True)` 流式读，避免整包载入内存。
- **避免全量转 dict**：不要对大 DataFrame 使用 `.to_dict(orient='records')` 或 `.to_dict(orient='list')`，直接操作 DataFrame 或逐行迭代。
- **写入时用 append 模式**：如果只需追加数据到已有文件，用 `pd.ExcelWriter(path, mode='a', engine='openpyxl')` 而非重新生成整个文件。

## 4. 常见异常与处理

Python 脚本执行失败时，按以下模式处理，不要静默吞掉异常：

| 异常 | 常见原因 | 处理方式 |
| --- | --- | --- |
| `FileNotFoundError` | 路径拼写错误、文件不存在 | 提示用户确认文件路径，检查盘符和文件名大小写 |
| `UnicodeDecodeError` | 编码不匹配（中文 Excel 常用 GBK） | 换 encoding：先试 `utf-8-sig`，再试 `gbk`，最后试 `gb18030` |
| `PermissionError` | 文件被 Excel 或其他程序打开锁定 | 提示用户关闭文件后重试 |
| `BadZipFile` | 文件损坏、非 xlsx 格式（可能是 csv 重命名） | 用 `file` 命令或检查文件头确认真实格式 |

脚本中应使用 `try/except` 包裹关键操作，失败时输出明确的错误信息和建议，例如：

```python
try:
    df = pd.read_excel(path, encoding='utf-8')
except UnicodeDecodeError:
    try:
        df = pd.read_excel(path, encoding='gbk')
    except UnicodeDecodeError:
        df = pd.read_excel(path, encoding='gb18030')
except FileNotFoundError:
    print(f'错误：文件不存在 — {path}')
    sys.exit(1)
except PermissionError:
    print(f'错误：文件被其他程序锁定，请关闭 Excel 后重试 — {path}')
    sys.exit(1)
```

## 5. 命令执行与故障排查

**执行模式**：Python 代码必须写入 `.py` 文件后用 `{{PYTHON_CMD}} <文件>` 执行，禁止 `{{PYTHON_CMD}} -c "..."` inline 执行（详见 system-prompt 的"脚本执行模式"）。命令前缀一律用 `{{PYTHON_CMD}}`，不要用裸 `python`（可能撞上 LibreOffice 自带 python / WindowsApps stub）。

**当 `execute_command` 返回 killed 或超时时**：

1. **不要反复重试相同命令**——killed 意味着超时（进程上限 300s）或 shell 转义问题，重试不会解决
2. **检查是否用了 inline 模式**：如果是 `{{PYTHON_CMD}} -c "..."`，改为写文件后执行
3. **检查文件大小**：超过 50K 行的文件用 `nrows` 采样或分块处理（见"大文件处理"）
4. **检查路径**：用绝对路径，避免 cwd 不确定导致 `FileNotFoundError`
5. **降低复杂度**：如果脚本做了 10 件事，拆成 2-3 个简单脚本分别执行

**常见 killed 原因排查顺序**：
- inline `{{PYTHON_CMD}} -c` + 引号嵌套 → 改为写文件执行
- 文件过大，pandas 全量加载超时 → 用 `nrows` 或 `chunksize`
- 路径含空格/中文，bash 转义失败 → 用引号包裹路径：`{{PYTHON_CMD}} "路径 with spaces/task.py"`
- recalc.py 报 "timed out"（其内部求值熔断默认 30s）→ 传第 2 个位置参数调大：`{{PYTHON_CMD}} recalc.py file.xlsx 120`。**注意：这是 recalc.py 自己的求值超时，与 execute_command 的进程超时上限（300s）是两码事**——不要混在一起排查。

## 6. 文件命名约定

| 场景 | 命名规则 | 示例 |
| --- | --- | --- |
| 备份原文件 | `<原文件>.bak` | `数据.xlsx.bak` |
| 清洗结果 | `<原文件>_cleaned.xlsx` | `数据_cleaned.xlsx` |
| 转换结果 | `<原文件>_converted.<ext>` | `数据_converted.csv` |
| 合并结果 | `<描述>_merged.xlsx` | `月报_merged.xlsx` |
| 拆分结果 | `<维度值>.xlsx`（放在子目录） | `拆分结果/销售部.xlsx` |
| 图表文件 | `<原文件>_chart.xlsx` | `数据_chart.xlsx` |

## 7. 公式规范

- **用公式，不用硬编码结果**。写 `=SUM(B2:B100)` 而非 Python 算出的数字。
- **pycel 兼容是硬约束**（recalc 用 pycel 校验）。哪些函数可直接用、哪些需 `_xlfn.` 前缀、哪些 pycel 不支持（XLOOKUP 等 Office 365 新函数）——**权威规则只维护在内置 `xlsx` 技能**（`read_skill('xlsx')` → "Choosing formulas that survive verification" 段），本约定不重复维护，防止多份漂移。速记：Excel 2007 时代函数直接用；`TEXTJOIN/CONCAT/IFS/SWITCH/MAXIFS/MINIFS` 加 `_xlfn.`；`XLOOKUP/XMATCH/SORT/FILTER/UNIQUE/SEQUENCE` 需 LibreOffice `--cache` 或在 Python 中先算好再写值。
- **保护分母**：可能为零的除法用 `IFERROR` 包裹。
- **写入后必须 recalc 校验（默认不写盘）**：`{{PYTHON_CMD}} {{BUILTIN_SKILLS_DIR}}/xlsx/scripts/recalc.py <文件>`（`--check`：pycel 内存校验、**公式保留**）。`--bake`/`--cache` 模式与适用场景见内置 `xlsx` 技能 → "Recalculate or validate" 段。**绝不默认对交付给用户的公式文件做值覆盖**。

## 8. 输出摘要格式

每次操作完成后，用以下格式输出摘要：

```
✅ 操作完成：[操作描述]
- 输入：[文件路径]（[行数] 行 × [列数] 列）
- 输出：[文件路径]（[行数] 行 × [列数] 列）
- 变化：[具体变化说明]
- 备份：[备份文件路径]
```

## 9. 环境依赖

Excel 环境依赖由内置 `xlsx` 技能承载（`skills/xlsx/`），首次使用先 `read_skill('xlsx')` 加载环境信息与 openpyxl gotchas。关键文件：

- `scripts/recalc.py` — 公式校验/重算脚本：三种模式（`--check`/`--bake`/`--cache`）说明见上文 §7 与内置 `xlsx` 技能，本约定不重复展开
- `scripts/office/soffice.py` — LibreOffice 路径探测（可选：仅 `--cache` 与 Word/PPT 转 PDF 需要）

环境检查（一次性单行命令允许 inline）：

```bash
{{PYTHON_CMD}} -c "import openpyxl; print('openpyxl:', openpyxl.__version__)"
{{PYTHON_CMD}} -c "import pandas; print('pandas:', pandas.__version__)"
{{PYTHON_CMD}} -c "import pycel; print('pycel:', pycel.__version__)"
```

缺失时提示用户安装，不要静默跳过。

## 10. 汇报产物位置（强制）

完成文件写入后，向用户汇报时**必须使用绝对路径**：
- 直接采用脚本输出的文件路径
- 不要只写相对路径，不要省略盘符
- 多个产物逐个列出绝对路径，并标注各自用途
