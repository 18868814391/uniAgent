#!/usr/bin/env python3
"""xl_transform — 数据变换 CLI（xl-transform 技能的落地命令）

用法：
    python xl_transform.py <输入> <输出> <操作> [选项]

输入/输出支持 .xlsx / .xlsm / .csv / .tsv（扩展名决定输出格式，csv 带 UTF-8 BOM）。
默认处理第一个 sheet（--sheet 指定其它）。输出**不能与输入同名**。

操作与参数：
    groupby   分组聚合
        --group-by 部门,月份       分组键（逗号分隔）
        --agg 金额=sum,笔数=count   聚合：列=函数，函数 sum/mean/median/min/max/
                                   count/nunique/first/last/std；未给 --agg 时输出每组行数 count
    pivot     透视表
        --index 部门 --columns 月份 --values 金额 --aggfunc sum [--fill 0] [--margins] [--margins-name 合计]
    merge     纵向关联（VLOOKUP 式，需第二个文件）
        --right 附表.xlsx --on 订单号 [--how left|inner|right|outer]（默认 inner）
    concat    横向拼接（同构多文件/多 sheet 合并成一张表）
        --right 文件A.xlsx,文件B.csv  （可多次给 --right；与主输入同构）
        [--right-sheet 名]            （合并 xlsx 时各文件用同一个 sheet 名）
    filter    条件筛选
        --query "金额 > 10000 and 状态 == '已审核'"
    sort      排序
        --by 日期:asc,金额:desc        （不写方向默认 asc；也可只给列名）

查询/列名约定：
    - pandas query 语法：字符串值必须加引号（'已审核'），多条件 and/or；日期建议转成字符串比较
      "日期 >= '2024-01-01'"；列名含空格/特殊字符时用反引号包住（`列 名`）
    - 列名参数（--group-by/--index/--values/--on/--by 等）多个用 ASCII 逗号分隔
"""
import argparse
import glob
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xl_utils import (assert_no_uncalculated_formulas, dump_json, ensure_new_output,
                      find_input, read_frame, save_frame, split_csv)

AGG_FUNCS = ('sum', 'mean', 'median', 'min', 'max', 'count', 'nunique', 'first', 'last', 'std')
OPS = ('groupby', 'pivot', 'merge', 'concat', 'filter', 'sort')


def read_right(path, sheet):
    rp = find_input(path)
    df, _s = read_frame(rp, sheet=sheet)
    return df


def parse_agg(text):
    """'列=函数,列=函数' → dict；顺带校验函数名。"""
    agg = {}
    for part in str(text).split(','):
        part = part.strip()
        if not part:
            continue
        if '=' not in part:
            sys.exit(f'错误：--agg 项 "{part}" 应为 列=函数（如 金额=sum）')
        col, _, fn = part.partition('=')
        col, fn = col.strip(), fn.strip().lower()
        if fn not in AGG_FUNCS:
            sys.exit(f'错误：--agg 函数 "{fn}" 不支持，仅支持 {" / ".join(AGG_FUNCS)}')
        agg[col] = fn
    if not agg:
        sys.exit('错误：--agg 为空')
    return agg


def check_cols(df, cols, what):
    missing = [c for c in cols if c not in df.columns]
    if missing:
        sys.exit(f'错误：{what} 找不到列 {missing}（现有列：{"、".join(map(str, df.columns))}）')


def op_groupby(df, args, log):
    keys = split_csv(args.group_by, '--group-by')
    check_cols(df, keys, '--group-by')
    agg_map = parse_agg(args.agg) if args.agg else {}
    check_cols(df, list(agg_map), '--agg')
    before = len(df)
    if not agg_map:
        res = df.groupby(keys).size().reset_index(name='count')
        log.append(f'分组计数（{"、".join(keys)}）')
    else:
        res = df.groupby(keys).agg(agg_map)
        # 显式命名聚合列（不依赖 MultiIndex 结构）：<列>_<函数>，如 金额_sum
        res.columns = [f'{k}_{v}' for k, v in agg_map.items()]
        res = res.reset_index()
        log.append(f'分组聚合（{"、".join(keys)}）→ {"、".join(res.columns[len(keys):])}')
    log.append(f'输入 {before} 行 → 输出 {len(res)} 组')
    return res


def op_pivot(df, args, log):
    index = split_csv(args.index, '--index')
    columns = split_csv(args.columns, '--columns')
    values = split_csv(args.values, '--values')
    check_cols(df, index, '--index')
    check_cols(df, columns, '--columns')
    check_cols(df, values, '--values')
    if len(index) != 1:
        sys.exit('错误：--index 目前仅支持单列')
    if len(columns) != 1:
        sys.exit('错误：--columns 目前仅支持单列')
    fn = (args.aggfunc or 'sum').lower()
    kw = {'fill_value': args.fill} if args.fill is not None else {}
    if args.margins:
        kw.update({'margins': True, 'margins_name': args.margins_name or '合计'})
    res = pd.pivot_table(df, index=index, columns=columns, values=values, aggfunc=fn, **kw)
    # 展平 MultiIndex 列（单数值列时取分类值本身，如 已审核 / 合计）；
    # 否则 to_excel(index=False) 会因 MultiIndex 列而失败。
    if isinstance(res.columns, pd.MultiIndex):
        flat, seen = [], set()
        for c in res.columns:
            nm = str(c[-1])
            if nm in seen:  # 理论碰撞（不同值列同名）：退化为全层级拼接
                nm = '_'.join(str(x) for x in c if str(x) != '')
            seen.add(nm)
            flat.append(nm)
        res.columns = flat
    res = res.reset_index()
    log.append(f'透视（行={index[0]}，列={columns[0]}，值={values[0]}，aggfunc={fn}）→ {len(res)} 行')
    return res


def op_merge(df, args, log):
    if len(args.right or []) != 1:
        sys.exit('错误：merge 只需一个 --right（关联文件）；多个文件拼接请用 concat')
    right = read_right(args.right[0], args.right_sheet)
    on = split_csv(args.on, '--on') if args.on else None
    how = args.how or 'inner'
    if how not in ('inner', 'left', 'right', 'outer'):
        sys.exit('错误：--how 仅支持 inner/left/right/outer')
    if on:
        check_cols(df, on, '--on')
        check_cols(right, on, '--on（右表）')
    before = len(df)
    res = pd.merge(df, right, on=on, how=how)
    log.append(f'关联（how={how}，on={on or "自动同名列"}）→ 输入 {before} 行 × {len(right)} 行 → 输出 {len(res)} 行')
    return res


def op_concat(df, args, log):
    frames = [df]
    labels = [args.input]
    for path in (args.right or []):
        for p in glob.glob(path) or [path]:
            frames.append(read_right(p, args.right_sheet))
            labels.append(p)
    res = pd.concat(frames, ignore_index=True)
    log.append(f'拼接 {len(frames)} 个表（{len(res)} 行）：{" + ".join(labels)}')
    return res


def op_filter(df, args, log):
    before = len(df)
    try:
        res = df.query(args.query)
    except Exception as e:
        sys.exit(f'错误：--query 表达式不合法：{e}\n提示：字符串值要加引号（如 状态 == \'已审核\'），'
                 f'多条件用 and/or，列名含空格用反引号（`列 名`）')
    log.append(f'条件筛选 → 移除 {before - len(res)} 行，剩余 {len(res)} 行')
    return res


def op_sort(df, args, log):
    by_parts = []
    asc = []
    for part in str(args.by).split(','):
        part = part.strip()
        if not part:
            continue
        if ':' in part:
            col, _, d = part.partition(':')
            by_parts.append(col.strip())
            asc.append(d.strip().lower() != 'desc')
        else:
            by_parts.append(part)
            asc.append(True)
    if not by_parts:
        sys.exit('错误：--by 为空')
    check_cols(df, by_parts, '--by')
    res = df.sort_values(by_parts, ascending=asc, kind='mergesort').reset_index(drop=True)
    log.append(f'排序（{"、".join(by_parts)}）')
    return res


def preview_rows(df, n=5, max_cols=20):
    sub = df.head(n).iloc[:, :max_cols]
    return sub.where(sub.notna(), None).to_dict(orient='records')


def main():
    ap = argparse.ArgumentParser(description='Excel/csv 数据变换（xl-transform）')
    ap.add_argument('input', help='输入文件（.xlsx/.xlsm/.csv/.tsv）')
    ap.add_argument('output', help='输出文件（.xlsx/.csv/.tsv）')
    ap.add_argument('op', choices=OPS, help='操作：groupby/pivot/merge/concat/filter/sort')
    ap.add_argument('--sheet', help='输入 sheet 名（默认第一个）')
    # groupby
    ap.add_argument('--group-by', help='[groupby] 分组键列，逗号分隔')
    ap.add_argument('--agg', help='[groupby] 聚合：列=函数,列2=函数')
    # pivot
    ap.add_argument('--index', help='[pivot] 行索引列')
    ap.add_argument('--columns', help='[pivot] 列索引列')
    ap.add_argument('--values', help='[pivot] 值列')
    ap.add_argument('--aggfunc', help='[pivot] 聚合函数（默认 sum）')
    ap.add_argument('--fill', help='[pivot] 空值填充值')
    ap.add_argument('--margins', action='store_true', help='[pivot] 加合计行列')
    ap.add_argument('--margins-name', default='合计', help='[pivot] 合计名称（默认 合计）')
    # merge / concat
    ap.add_argument('--right', action='append', help='[merge/concat] 关联/拼接文件（可重复，支持 * 通配）')
    ap.add_argument('--right-sheet', help='[merge/concat] 右侧文件 sheet 名（默认第一个）')
    ap.add_argument('--on', help='[merge] 关联键列（逗号分隔；缺省用两表同名列）')
    ap.add_argument('--how', help='[merge] inner/left/right/outer（默认 inner）')
    # filter
    ap.add_argument('--query', help='[filter] pandas query 条件表达式')
    # sort
    ap.add_argument('--by', help='[sort] 排序列：列或 列:asc/desc，逗号分隔')
    args = ap.parse_args()

    in_path = find_input(args.input)
    ensure_new_output(in_path, args.output)
    # P0 护栏：输入含「公式但无缓存值」的列时拒绝变换（pandas 读成空值，结果会误导）。
    assert_no_uncalculated_formulas(in_path, sheet=args.sheet, what='数据变换')
    df, _single = read_frame(in_path, sheet=args.sheet)

    log = []
    if args.op == 'groupby':
        if not args.group_by:
            ap.error('groupby 需要 --group-by')
        df = op_groupby(df, args, log)
    elif args.op == 'pivot':
        if not (args.index and args.columns and args.values):
            ap.error('pivot 需要 --index/--columns/--values')
        df = op_pivot(df, args, log)
    elif args.op == 'merge':
        if not args.right:
            ap.error('merge 需要 --right（关联文件）')
        df = op_merge(df, args, log)
    elif args.op == 'concat':
        if not args.right:
            ap.error('concat 需要 --right（要拼接的文件）')
        df = op_concat(df, args, log)
    elif args.op == 'filter':
        if not args.query:
            ap.error('filter 需要 --query')
        df = op_filter(df, args, log)
    elif args.op == 'sort':
        if not args.by:
            ap.error('sort 需要 --by')
        df = op_sort(df, args, log)

    out_path, n = save_frame(df, args.output)
    dump_json({
        'mode': 'transform',
        'operation': args.op,
        'input': in_path,
        'output': out_path,
        'rows': int(n),
        'cols': int(len(df.columns)),
        'columns': list(map(str, df.columns)),
        'operations': log,
        'preview': preview_rows(df),
    })


if __name__ == '__main__':
    main()
