#!/usr/bin/env python3
"""xl_summarize — 一步输出 Excel 结构摘要（xl-read 技能的落地 CLI）

用法：
    python xl_summarize.py <file> [--sample N] [--limit N]
    file 支持 .xlsx / .xlsm / .csv / .tsv（csv/tsv 按单表处理）

返回 JSON（print 到 stdout，编码 utf-8、中文不转义）：
    { "<sheet>": {
        "rows":    行数（<limit 为真实数据行数；≥limit 用 openpyxl max_row-1 估算，可能含格式空行）
        "cols":    列数
        "sampled": 列统计是否基于采样
        "columns": [{ name, dtype, non_null, null_count, null_pct, sampled,
                      min/max/mean（数值列）| unique_count/top_values（object 列） }]
        "preview": 前 5 行
        "note":    口径说明（采样/格式空行提示）
      }, ... }

口径：数据行 ≤ limit（默认 50_000）全量加载并统计；
      超过则只读前 sample（默认 1_000）行做统计与预览，总行数按 openpyxl
      read_only max_row 估算——不要把采样统计当成全量结论汇报。
"""
import argparse
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xl_utils import (DEFAULT_SAMPLE_ROWS, PROBE_MAX_ROWS, SAMPLE_LIMIT, count_csv_lines,
                      dump_json, find_input, merged_cells_by_sheet, probe_formulas,
                      read_frame, sheet_dims, summarize_frame)


def main():
    ap = argparse.ArgumentParser(description='Excel/csv 结构摘要（等价 xl-read 分析）')
    ap.add_argument('path', help='输入文件（.xlsx/.xlsm/.csv/.tsv）')
    ap.add_argument('--sample', type=int, default=DEFAULT_SAMPLE_ROWS, help='大文件采样行数（默认 1000）')
    ap.add_argument('--limit', type=int, default=SAMPLE_LIMIT, help='全量统计行数阈值（默认 50000）')
    args = ap.parse_args()

    path = find_input(args.path)
    ext = os.path.splitext(path)[1].lower()

    result = {}
    if ext in ('.csv', '.tsv'):
        # 单表：csv/tsv 没有多 sheet。先流式数物理行（内存 O(1)，不再整包读），
        # 超限则只读前 sample 行做统计（物理行对引号内换行会偏大，note 中标注）。
        total = max(count_csv_lines(path) - 1, 0)   # 减表头行（近似）
        if total > args.limit:
            df, _ = read_frame(path, nrows=args.sample)
            sampled = True
            note = f'全量约 {total} 行（按物理行估算，引号内换行会偏大）；列统计基于前 {args.sample} 行采样'
        else:
            df, _ = read_frame(path)
            sampled = False
            note = None
        result['_csv'] = {'rows': total, 'cols': len(df.columns), 'sampled': sampled,
                          **summarize_frame(df, sampled=sampled, note=note)}
    else:
        dims = sheet_dims(path)
        merged = merged_cells_by_sheet(path)   # zipfile 直读 mergeCell，开销小
        with pd.ExcelFile(path) as xl:
            for name in xl.sheet_names:
                max_row = dims.get(name, (0, 0))[0]
                est_rows = max(max_row - 1, 0)
                if est_rows <= args.limit:
                    df = pd.read_excel(xl, sheet_name=name)
                    sampled = False
                    rows = len(df)
                    note = None
                    if est_rows > rows:
                        note = f'openpyxl 见 {est_rows + 1} 行，其中 {rows} 行为实际数据（其余为格式空行）'
                else:
                    df = pd.read_excel(xl, sheet_name=name, nrows=args.sample)
                    sampled = True
                    rows = est_rows
                    note = f'全量约 {rows} 行（openpyxl max_row-1 估算，可能含格式空行）；列统计基于前 {args.sample} 行采样'
                result[name] = {'rows': rows, 'cols': len(df.columns), 'sampled': sampled,
                                'merged_cells': merged.get(name, 0),
                                **summarize_frame(df, sampled=sampled, note=note)}

        # 合并单元格提示（防空值误判：合并区域非首格 pandas 读为 NaN）
        merged_sheets = [n for n, cnt in merged.items() if cnt]
        if merged_sheets:
            for name in merged_sheets:
                if name not in result:
                    continue
                base = (result[name].get('note') or '').strip()
                tip = ('⚠️ 该 sheet 含 {n} 处合并单元格——pandas 会把合并区域非左上角的单元格'
                       '读成空值。若后续做 --dropna any / 删行 / 去重，可能误删这类"看起来是空"'
                       '的行；先确认哪些空列来自合并单元格。'
                       .format(n=merged.get(name, 0)))
                result[name]['note'] = (base + '\n' + tip) if base else tip

        # P0 防御：公式列无缓存值 → pandas 读到 100% 空值，会被误当成"脏数据/空列"。
        # 仅当确有 pandas 全空列时才做一次 read_only 探测，常规文件零额外开销。
        empty_sheets = [name for name, info in result.items()
                        if any(c.get('null_pct', 0) >= 100 for c in info.get('columns', []))]
        if empty_sheets:
            # 探测行数与提示口径一致：抽查行数不超过采样行数，也不超过常量上限
            probe = probe_formulas(path, max_rows=min(args.sample, PROBE_MAX_ROWS)) or {}
            probed = min(args.sample, PROBE_MAX_ROWS)
            for name in empty_sheets:
                pinfo = probe.get(name)
                if pinfo and pinfo.get('no_cache'):
                    base = (result[name].get('note') or '').strip()
                    warn = ('⚠️ 该 sheet 前 {max} 行内探测到 {n} 个「公式但无缓存值」单元格，'
                            'pandas 因此把对应公式列读成空——这是 openpyxl 刚写入公式的正常状态，'
                            '不是数据缺失。需要数值请先 recalc --cache（保公式+写缓存值，需 LibreOffice）'
                            '或 --bake（静态快照）；校验用 --check。不要据此做空值填充/删除。'
                            .format(max=probed, n=pinfo['no_cache_count']))
                    result[name]['note'] = (base + '\n' + warn) if base else warn
    dump_json(result)


if __name__ == '__main__':
    main()
