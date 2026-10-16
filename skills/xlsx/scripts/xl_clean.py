#!/usr/bin/env python3
"""xl_clean — 数据清洗 CLI（xl-clean 技能的落地命令）

用法：
    python xl_clean.py <输入> <输出> [选项]

输入支持 .xlsx / .xlsm / .csv / .tsv；输出支持 .xlsx / .csv / .tsv
（扩展名决定格式；csv 自动带 UTF-8 BOM）。默认处理第一个 sheet，可用 --sheet 指定。
输出**不能与输入同名**（防覆盖源文件）。

处理按固定流水线顺序执行（改前先读结构，确认口径再调用）：
    read → --rename → --cast → --strip → --extract → --drop-cols
         → --dropna → --ffill → --fill-na/--fill → --clip → --drop-duplicates → 写出

常用示例：
    # 去重 + 删全空行 + 金额转数字，输出清洗结果
    python xl_clean.py 订单.csv 订单_cleaned.xlsx --drop-duplicates --dropna all --cast 金额=float

    # 空值填充（全局 '无' + 数值列 0），文本去空格
    python xl_clean.py 客户.xlsx 客户_cleaned.xlsx --fill-na 无 --fill 金额=0 --strip *

    # 从备注列用正则抽手机号到新列，日期列规范化
    python xl_clean.py 名单.csv 名单_cleaned.xlsx --extract 手机号=备注:1[3-9]\\d{9} --cast 日期=date

选项值规则：
    - 列表参数用 ASCII 逗号分隔（如 --cast 金额=float,数量=int）；值不要含 ASCII 逗号
    - 正则里不要含 '=' 或 ':'（--extract 语法为 新列=源列:正则）
    - --extract 的正则无捕获组时自动整体匹配；多捕获组取第一个
"""
import argparse
import os
import re
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xl_utils import (assert_no_uncalculated_formulas, dump_json, ensure_new_output,
                      find_input, format_pair_items, merged_cells_by_sheet,
                      read_frame, save_frame, split_csv)

CAST_TYPES = ('int', 'float', 'str', 'bool', 'date', 'datetime')
# 注意：值先经 .strip().lower() 再比对，因此集合一律小写；中文不受 lower 影响。
_TRUE_SET = {'1', '1.0', 'true', 'yes', 'y', '是', '真'}
_FALSE_SET = {'0', '0.0', 'false', 'no', 'n', '否', '假', ''}


def op_rename(df, items, log):
    for old, new in items.items():
        if old not in df.columns:
            sys.exit(f'错误：--rename 找不到列 "{old}"（现有列：{"、".join(map(str, df.columns))}）')
        df = df.rename(columns={old: new})
    if items:
        log.append(f'重命名 {len(items)} 列')
    return df


def op_cast(df, items, log):
    for col, typ in items.items():
        if col not in df.columns:
            sys.exit(f'错误：--cast 找不到列 "{col}"（现有列：{"、".join(map(str, df.columns))}）')
        if typ not in CAST_TYPES:
            sys.exit(f'错误：--cast 类型 "{typ}" 不支持，仅支持 {" / ".join(CAST_TYPES)}')
        s = df[col]
        if typ == 'int':
            df[col] = pd.to_numeric(s, errors='coerce').round().astype('Int64')
        elif typ == 'float':
            df[col] = pd.to_numeric(s, errors='coerce')
        elif typ == 'str':
            df[col] = s.astype(str) if not s.isna().all() else s
        elif typ == 'bool':
            # 严格语义：空值(NaN/None)保留为空(boolean 的 NA)，不再被静默填 False；
            # 无法识别的文本(如 'n/a'、'待审核')显式报错，绝不悄悄当成 False。
            m = s.astype('string').str.strip().str.lower()
            bad = sorted({str(v) for v in m.dropna().unique()
                          if v not in _TRUE_SET and v not in _FALSE_SET})
            if bad:
                shown = '、'.join(bad[:8]) + ('…' if len(bad) > 8 else '')
                sys.exit(f'错误：--cast 列 "{col}" 转 bool 失败：存在无法识别的值 [{shown}]'
                         f'（共 {len(bad)} 个）。真值：{" / ".join(sorted(_TRUE_SET))}；'
                         f'假值：{" / ".join(sorted(_FALSE_SET))}。无法识别的值不会静默处理。')

            def _to_bool(v):
                if pd.isna(v):
                    return pd.NA
                return v in _TRUE_SET

            df[col] = m.map(_to_bool).astype('boolean')
        elif typ == 'date':
            df[col] = pd.to_datetime(s, errors='coerce').dt.date
        elif typ == 'datetime':
            df[col] = pd.to_datetime(s, errors='coerce')
        log.append(f'列 "{col}" → {typ}')
    return df


def op_strip(df, cols, log):
    target = [c for c in df.columns if c in cols or '*' in cols]
    changed = 0
    for c in target:
        if pd.api.types.is_string_dtype(df[c]) or df[c].dtype == object:
            before = df[c].astype(str).str.len().sum()
            df[c] = df[c].astype('string').str.strip().astype(object)
            after = df[c].fillna('').astype(str).str.len().sum()
            changed += int(before != after)
    if target:
        log.append(f'去除首尾空格（{len(target)} 列）')
    return df


def op_extract(df, items, log):
    for newcol, spec in items.items():
        src, _, pattern = spec.partition(':')
        if not src or not pattern:
            sys.exit(f'错误：--extract "{newcol}={spec}" 语法应为 新列=源列:正则')
        if src not in df.columns:
            sys.exit(f'错误：--extract 找不到源列 "{src}"（现有列：{"、".join(map(str, df.columns))}）')
        if newcol in df.columns:
            sys.exit(f'错误：--extract 目标列 "{newcol}" 已存在，换个列名')
        try:
            pat = pattern if '(' in pattern else f'({pattern})'
            df[newcol] = df[src].astype('string').str.extract(pat, expand=False)
        except re.error as e:
            sys.exit(f'错误：--extract 正则 "{pattern}" 不合法：{e}')
        log.append(f'正则提取 新列 "{newcol}" ← "{src}"')
    return df


def op_drop_cols(df, cols, log):
    missing = [c for c in cols if c not in df.columns]
    if missing:
        sys.exit(f'错误：--drop-cols 找不到列 {missing}（现有列：{"、".join(map(str, df.columns))}）')
    if cols:
        df = df.drop(columns=cols)
        log.append(f'删除列：{"、".join(cols)}')
    return df


def op_dropna(df, how, subset, log):
    kw = {}
    if subset:
        subset = split_csv(subset, '--dropna-subset')
        missing = [c for c in subset if c not in df.columns]
        if missing:
            sys.exit(f'错误：--dropna-subset 找不到列 {missing}')
        kw['subset'] = subset
    before = len(df)
    df = df.dropna(how=how, **kw)
    if before != len(df):
        log.append(f'删除空值行（how={how}）：移除 {before - len(df)} 行')
    return df


def op_ffill(df, cols, log):
    cols = split_csv(cols, '--ffill')
    missing = [c for c in cols if c not in df.columns]
    if missing:
        sys.exit(f'错误：--ffill 找不到列 {missing}')
    for c in cols:
        n = int(df[c].isna().sum() - df[c].ffill().isna().sum())
        df[c] = df[c].ffill()
        if n:
            log.append(f'列 "{c}" 前值填充 {n} 个空值')
    return df


def op_fill(df, global_val, by_col, log):
    def fill_col(c, v):
        n = int(df[c].isna().sum())
        df[c] = df[c].fillna(v)
        return n

    for c, v in by_col.items():
        if c not in df.columns:
            sys.exit(f'错误：--fill 找不到列 "{c}"（现有列：{"、".join(map(str, df.columns))}）')
        n = fill_col(c, v)
        if n:
            log.append(f'列 "{c}" 填充 {n} 个空值为 {v!r}')
    if global_val is not None:
        total = 0
        for c in df.columns:
            total += fill_col(c, global_val)
        if total:
            log.append(f'全列填充 {total} 个空值为 {global_val!r}')
    return df


def op_clip(df, items, log):
    for col, rng in items.items():
        if col not in df.columns:
            sys.exit(f'错误：--clip 找不到列 "{col}"')
        lo, _, hi = rng.partition(',')
        lo = float(lo) if lo.strip() not in ('', '-inf') else None
        hi = float(hi) if hi.strip() not in ('', 'inf') else None
        if not pd.api.types.is_numeric_dtype(df[col]):
            df[col] = pd.to_numeric(df[col], errors='coerce')
        df[col] = df[col].clip(lower=lo, upper=hi)
        log.append(f'列 "{col}" 截断范围 {lo}~{hi}')
    return df


def op_dedup(df, subset, keep, log):
    kw = {'keep': keep}
    if subset:
        subset = split_csv(subset, '--subset')
        missing = [c for c in subset if c not in df.columns]
        if missing:
            sys.exit(f'错误：--subset 找不到列 {missing}')
        kw['subset'] = subset
    before = len(df)
    df = df.drop_duplicates(**kw)
    if before != len(df):
        scope = '整行' if not subset else f'按列 {"、".join(subset)}'
        log.append(f'去重（{scope}，keep={keep}）：移除 {before - len(df)} 行')
    return df


def main():
    ap = argparse.ArgumentParser(description='Excel/csv 数据清洗（xl-clean）')
    ap.add_argument('input', help='输入文件（.xlsx/.xlsm/.csv/.tsv）')
    ap.add_argument('output', help='输出文件（.xlsx/.csv/.tsv）')
    ap.add_argument('--sheet', help='输入 sheet 名（默认第一个）')
    ap.add_argument('--rename', help='重命名：旧列=新列,旧列2=新列2')
    ap.add_argument('--cast', help='类型转换：列=int|float|str|bool|date|datetime,列2=...')
    ap.add_argument('--strip', help='去除首尾空格列列表（* = 全部文本列）')
    ap.add_argument('--extract', help='正则提取新列：新列=源列:正则,新列2=...')
    ap.add_argument('--drop-cols', help='删除列：列1,列2')
    ap.add_argument('--dropna', choices=['all', 'any'], help='删除空值行：all=全空行，any=含任一空值')
    ap.add_argument('--dropna-subset', help='配合 --dropna 只检查这些列')
    ap.add_argument('--ffill', help='前值填充列：列1,列2')
    ap.add_argument('--fill-na', help='全局空值填充值')
    ap.add_argument('--fill', help='按列空值填充：列=值,列2=值2')
    ap.add_argument('--clip', help='数值截断范围：列=min,max（inf/-inf 表示不限）')
    ap.add_argument('--drop-duplicates', action='store_true', help='去重')
    ap.add_argument('--subset', help='配合 --drop-duplicates 按指定列去重')
    ap.add_argument('--keep', default='first', choices=['first', 'last'], help='去重保留行（默认 first）')
    ap.add_argument('--allow-merged-dropna', action='store_true',
                    help='[危险] 文件含合并单元格时仍执行 --dropna any（合并单元格下方 pandas 读为空，'
                         '删"含空值行"可能误删数据；确认无合并表头/分组后慎用）')
    args = ap.parse_args()

    in_path = find_input(args.input)
    ensure_new_output(in_path, args.output)
    # P0 护栏：输入含「公式但无缓存值」的列时拒绝清洗（pandas 会把它们读成空值，
    # 继续清洗会剥离公式并产出空列 = 静默数据丢失）。
    assert_no_uncalculated_formulas(in_path, sheet=args.sheet, what='数据清洗')
    # P1 护栏：合并单元格区域下方 pandas 读为 NaN；--dropna any 会把它们当"含空值行"整行删除。
    # 仅在用户真要删"含任一空值"的行时才做合并探测（zipfile 直读，开销小）。
    if args.dropna == 'any' and not args.allow_merged_dropna:
        sheet_key = args.sheet if args.sheet else None
        mcount = merged_cells_by_sheet(in_path)
        target = sheet_key if sheet_key else (next(iter(mcount), None))
        if target and mcount.get(target, 0):
            sys.exit(f'错误：文件含 {mcount[target]} 处合并单元格（sheet：{target}），'
                     f'而 --dropna any 会删除"含任一空值"的行——合并单元格非首格在 pandas 中读为空，'
                     f'整行会被误删。建议：1) 先跑 xl_summarize 确认空值来源；'
                     f'2) 改用 --dropna-subset 限定业务列；3) 确认无合并数据后加 --allow-merged-dropna 显式放行。')

    df, _single = read_frame(in_path, sheet=args.sheet)
    log = []
    df = op_rename(df, format_pair_items(args.rename, '--rename'), log) if args.rename else df
    df = op_cast(df, format_pair_items(args.cast, '--cast'), log) if args.cast else df
    df = op_strip(df, split_csv(args.strip, '--strip'), log) if args.strip else df
    df = op_extract(df, format_pair_items(args.extract, '--extract'), log) if args.extract else df
    df = op_drop_cols(df, split_csv(args.drop_cols, '--drop-cols'), log) if args.drop_cols else df
    df = op_dropna(df, args.dropna, args.dropna_subset, log) if args.dropna else df
    df = op_ffill(df, args.ffill, log) if args.ffill else df
    df = op_fill(df, args.fill_na, format_pair_items(args.fill, '--fill') if args.fill else {}, log)
    df = op_clip(df, format_pair_items(args.clip, '--clip'), log) if args.clip else df
    df = op_dedup(df, args.subset, args.keep, log) if args.drop_duplicates else df

    out_path, n = save_frame(df, args.output)
    dump_json({
        'mode': 'clean',
        'input': in_path,
        'output': out_path,
        'rows': int(n),
        'cols': int(len(df.columns)),
        'columns': list(map(str, df.columns)),
        'operations': log,
        'nulls_per_column': {str(c): int(df[c].isna().sum()) for c in df.columns},
    })


if __name__ == '__main__':
    main()
