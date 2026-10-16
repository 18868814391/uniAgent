#!/usr/bin/env python3
"""xl_convert — xlsx/csv/tsv/json/markdown 互转（xl-convert 技能的落地 CLI）

用法：
    python xl_convert.py <input> <output> [--sheet NAME] [--encoding ENC] [--md-limit N]

- input 支持 .xlsx / .xlsm / .csv / .tsv；output 扩展名决定目标格式：
    .csv / .tsv / .json / .md / .xlsx
- 多 sheet 输入且未指定 --sheet 时，按 sheet 展开输出：
    <output_stem>_<sheet名>.csv|json|md  （输出 .xlsx 时合并写入同一文件的所有 sheet）
- --sheet 指定后只转换该 sheet，输出到 output 原路径（不展开）
- csv 输出带 UTF-8 BOM（Excel 打开不乱码）；json 中文不转义；markdown 为手写实现，
  不依赖 tabulate 库
- CSV 读取自动编码兜底 utf-8-sig → gbk → gb18030（可用 --encoding 指定后仍兜底）
"""
import argparse
import json
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xl_utils import (assert_no_uncalculated_formulas, find_input, read_csv_safe,
                      safe_sheet_name, to_markdown)

OUT_EXTS = ('.csv', '.tsv', '.json', '.md', '.xlsx')


def write_text(path, text):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


def export_frame(df, out_path, out_ext, md_limit=50):
    """单个 DataFrame 按目标扩展名写出，返回 (path, rows)。"""
    if out_ext == '.csv':
        df.to_csv(out_path, index=False, encoding='utf-8-sig')
    elif out_ext == '.tsv':
        df.to_csv(out_path, sep='\t', index=False, encoding='utf-8-sig')
    elif out_ext == '.json':
        records = df.to_dict(orient='records')
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(records, f, ensure_ascii=False, indent=2, default=str)
    elif out_ext == '.md':
        write_text(out_path, to_markdown(df, limit=md_limit) + '\n')
    else:
        df.to_excel(out_path, index=False, sheet_name='Sheet1')
    return out_path, len(df)


def main():
    ap = argparse.ArgumentParser(description='xlsx/csv/tsv/json/markdown 互转')
    ap.add_argument('input', help='输入文件（.xlsx/.xlsm/.csv/.tsv）')
    ap.add_argument('output', help='输出文件（扩展名决定格式：.csv/.tsv/.json/.md/.xlsx）')
    ap.add_argument('--sheet', help='只转换指定 sheet')
    ap.add_argument('--md-limit', type=int, default=50, help='markdown 导出行数上限（默认 50，0=不限）')
    args = ap.parse_args()

    in_path = find_input(args.input)
    # P0 护栏：输入含「公式但无缓存值」的列时拒绝转换（pandas 读成空值，转换产物会误导）。
    assert_no_uncalculated_formulas(in_path, sheet=args.sheet, what='格式转换')
    out_ext = os.path.splitext(args.output)[1].lower()
    if out_ext not in OUT_EXTS:
        sys.exit(f'错误：不支持的输出格式 "{out_ext}"，仅支持 {" / ".join(OUT_EXTS)}')

    in_ext = os.path.splitext(in_path)[1].lower()
    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or '.', exist_ok=True)

    written = []

    if in_ext in ('.csv', '.tsv'):
        sep = '\t' if in_ext == '.tsv' else ','
        df = read_csv_safe(in_path, sep=sep)
        p, n = export_frame(df, args.output, out_ext, md_limit=args.md_limit)
        written.append(('输入文件', n, p))
    else:
        with pd.ExcelFile(in_path) as xl:
            sheet_names = [args.sheet] if args.sheet else list(xl.sheet_names)
            if args.sheet and args.sheet not in xl.sheet_names:
                sys.exit(f'错误：文件里没有名为 "{args.sheet}" 的 sheet（现有：{"、".join(xl.sheet_names)}）')
            if out_ext == '.xlsx':
                # 合并写出：把所有选中 sheet 写入同一个目标文件
                out_dir = os.path.dirname(os.path.abspath(args.output))
                os.makedirs(out_dir, exist_ok=True)
                with pd.ExcelWriter(args.output, engine='openpyxl') as writer:
                    for s in sheet_names:
                        df = pd.read_excel(xl, sheet_name=s)
                        df.to_excel(writer, index=False, sheet_name=safe_sheet_name(s)[:31])
                        written.append((s, len(df), args.output))
            else:
                multi = len(sheet_names) > 1
                for s in sheet_names:
                    df = pd.read_excel(xl, sheet_name=s)
                    if multi:
                        base, ext = os.path.splitext(args.output)
                        out_p = f'{base}_{safe_sheet_name(s)}{ext}'
                    else:
                        out_p = args.output
                    p, n = export_frame(df, out_p, out_ext, md_limit=args.md_limit)
                    written.append((s, n, p))

    for s, n, p in written:
        print(f'{s}: {n} 行 → {p}')
    print(f'完成：共写出 {len(written)} 个文件')


if __name__ == '__main__':
    main()
