#!/usr/bin/env python3
"""xl_format — 表格格式化 CLI（xl-format 技能中"常规美化"的落地命令）

用法：
    python xl_format.py <输入.xlsx/.xlsm> <输出.xlsx> [选项]

基于 openpyxl **在原工作簿上改样式并另存**：保留原数据、公式与既有格式，
只叠加请求的样式项。默认处理第一个 sheet（--sheet 指定）。输出不能与输入同名。
输入为 csv/tsv 时本命令不可用——先用 xl_convert.py 转成 .xlsx 再美化。

常用示例：
    # 默认美化：蓝色表头 + 白字加粗 + 自动列宽 + 冻结首行 + 自动筛选 + 细边框
    python xl_format.py 数据.xlsx 数据_美化.xlsx

    # 只想要冻结+筛选（不要表头染色/边框/自动列宽等整套美化）
    python xl_format.py 数据.xlsx 数据_轻量.xlsx --bare

    # 指定表头颜色 / 表头在第 2 行 / 金额列千分位 / 指定表头字体
    python xl_format.py 数据.xlsx 数据_美化.xlsx --header-row 2 \
        --header-fill 70AD47 --number-format 金额=#,##0.00,占比=0.0% --font 微软雅黑

    # 列宽按表头名或列字母指定 + 数据居中 + 斑马纹
    python xl_format.py 数据.xlsx 数据_美化.xlsx \
        --col-width 订单号=18,金额=14 --align-data center --banded

选项说明：
    --bare               轻量模式：不做表头染色/加粗、细边框、自动列宽、斑马纹；
                         保留冻结与筛选；显式给出的 --number-format/--col-width/
                         --align-data/--banded 仍生效。
    --font 名            表头字体名（默认保留原表头字体；原为空时才回落 Arial）
    --header-row N       表头所在行（默认 1）；数据从 N+1 行开始
    --header-fill HEX    表头底色（默认 4472C4；配 --bare 时不染色）
    --header-color HEX   表头文字色（默认 FFFFFF，仅在染色时生效）
    --header-bold / --no-header-bold
    --wrap-header        表头文字换行居中
    --freeze 窗格        冻结，如 A2（默认 A2；--no-freeze 关闭）
    --autofilter / --no-autofilter
    --auto-width [N]     按内容自适应列宽，上限 N（默认 50，CJK 全角按 2 计；
                          超过 5000 数据行时只扫描前 5000 行，避免大表 O(n) 遍历）
    --col-width 列=宽    手工列宽：列可为列字母(A)或表头名，如 姓名=18,备注=30
    --thin-border / --no-thin-border
    --banded             斑马纹（浅蓝隔行），--banded-fill HEX 改色
    --number-format 列=格式,列2=格式   数字格式（列可用列字母或表头名）
    --align-data left|center|right     数据区对齐（表头始终居中）

性能：样式叠加（边框/对齐/数字格式/斑马纹）在同一趟行扫描内完成，不再逐特性
重复遍历全表；自动列宽单独一趟但受扫描行数上限约束。
"""
import argparse
import os
import sys

from openpyxl import load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import column_index_from_string, get_column_letter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xl_utils import display_width, dump_json, ensure_new_output, find_input, format_pair_items

DEFAULT_HEADER_FILL = '4472C4'
DEFAULT_BANDED_FILL = 'D9E2F3'
AUTO_WIDTH_SCAN_ROWS = 5000   # 自适应列宽的最大扫描行数（防大表 O(rows×cols) 全扫）


def column_index(ws, header_row, token):
    """列标识(字母或表头名) → 列号。"""
    t = str(token).strip()
    # 字母列（纯字母 1~3 位）
    if t.isalpha() and len(t) <= 3:
        try:
            return column_index_from_string(t.upper())
        except ValueError:
            pass
    # 表头名查找
    for idx in range(1, ws.max_column + 1):
        if str(ws.cell(row=header_row, column=idx).value).strip() == t:
            return idx
    sys.exit(f'错误：找不到列 "{token}"（表头第 {header_row} 行；可用列字母或表头名）')


def main():
    ap = argparse.ArgumentParser(description='Excel 表格常规美化（xl-format）')
    ap.add_argument('input', help='输入 .xlsx/.xlsm')
    ap.add_argument('output', help='输出 .xlsx（另存，不覆盖输入）')
    ap.add_argument('--sheet', help='处理的 sheet（默认第一个）')
    ap.add_argument('--bare', action='store_true',
                    help='轻量模式：不做表头染色/加粗、细边框、自动列宽、斑马纹')
    ap.add_argument('--font', default=None, help='表头字体名（默认保留原表头字体）')
    ap.add_argument('--header-row', type=int, default=1, help='表头行号（默认 1）')
    ap.add_argument('--header-fill', default=DEFAULT_HEADER_FILL, help='表头底色 HEX（默认 4472C4）')
    ap.add_argument('--header-color', default='FFFFFF', help='表头文字色 HEX（默认 FFFFFF）')
    ap.add_argument('--header-bold', dest='header_bold', action='store_true', default=True)
    ap.add_argument('--no-header-bold', dest='header_bold', action='store_false')
    ap.add_argument('--wrap-header', action='store_true', help='表头换行居中')
    ap.add_argument('--freeze', default='A2', help='冻结窗格位置（默认 A2；用 --no-freeze 关）')
    ap.add_argument('--no-freeze', dest='freeze', action='store_const', const=None)
    ap.add_argument('--autofilter', dest='autofilter', action='store_true', default=True)
    ap.add_argument('--no-autofilter', dest='autofilter', action='store_false')
    ap.add_argument('--auto-width', nargs='?', const=50, default=50, type=int,
                    help='自适应列宽（上限，默认 50；--no-auto-width 关）')
    ap.add_argument('--no-auto-width', dest='auto_width', action='store_const', const=None)
    ap.add_argument('--col-width', help='手工列宽：列=宽,列2=宽（列=字母或表头名）')
    ap.add_argument('--thin-border', dest='thin_border', action='store_true', default=True)
    ap.add_argument('--no-thin-border', dest='thin_border', action='store_false')
    ap.add_argument('--banded', action='store_true', help='斑马纹隔行')
    ap.add_argument('--banded-fill', default=DEFAULT_BANDED_FILL, help='斑马纹底色 HEX（默认 D9E2F3）')
    ap.add_argument('--number-format', help='数字格式：列=格式,列2=格式')
    ap.add_argument('--align-data', choices=['left', 'center', 'right'], help='数据区对齐')
    args = ap.parse_args()

    # --bare：轻量操作（只想要冻结/筛选/数字格式等）时，关掉整套美化的隐式默认。
    if args.bare:
        args.header_bold = False
        args.header_fill = None
        args.thin_border = False
        args.auto_width = None

    in_path = find_input(args.input)
    ext = os.path.splitext(in_path)[1].lower()
    if ext in ('.csv', '.tsv'):
        sys.exit('错误：xl_format 只支持 .xlsx/.xlsm（csv 无格式概念）。先转 xlsx：'
                 'python xl_convert.py <csv> <xlsx>，再执行本命令')
    ensure_new_output(in_path, args.output)
    if args.output.lower().endswith(('.csv', '.tsv')):
        sys.exit('错误：输出必须是 .xlsx/.xlsm（保存样式）')

    keep_vba = ext == '.xlsm'
    wb = load_workbook(in_path, keep_vba=keep_vba)
    if args.sheet:
        if args.sheet not in wb.sheetnames:
            sys.exit(f'错误：没有名为 "{args.sheet}" 的 sheet（现有：{"、".join(wb.sheetnames)}）')
        ws = wb[args.sheet]
    else:
        ws = wb.active

    hrow = args.header_row
    if hrow < 1 or hrow > ws.max_row:
        sys.exit(f'错误：--header-row {hrow} 超出范围（max_row={ws.max_row}）')
    first_data = hrow + 1
    max_r, max_c = ws.max_row, ws.max_column
    log = []

    # 1. 表头样式：保留原表头字体名（中文环境不误回退），仅染色/加粗/换行
    if args.header_bold or args.header_fill or args.wrap_header:
        proto = ws.cell(row=hrow, column=1).font
        proto_name = getattr(proto, 'name', None) or ''
        base_font = (args.font or proto_name) or 'Arial'
        # 颜色只在染色时用白字；未染色（如 bare + 显式加粗）时保持默认深色，避免白字不可见
        fcolor = args.header_color if args.header_fill else None
        hf = Font(name=base_font, bold=args.header_bold, color=fcolor)
        hfill = PatternFill(start_color=args.header_fill, end_color=args.header_fill,
                            fill_type='solid') if args.header_fill else None
        for c in range(1, max_c + 1):
            cell = ws.cell(row=hrow, column=c)
            cell.font = hf
            if hfill is not None:
                cell.fill = hfill
            if args.wrap_header:
                cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
        acts = []
        if args.header_bold:
            acts.append('加粗')
        if hfill is not None:
            acts.append(f'底色 {args.header_fill}')
        if args.wrap_header:
            acts.append('换行居中')
        log.append(f'表头样式（第 {hrow} 行，{"+".join(acts)}，字体 {base_font}）')

    # 2~4. 数据区样式单趟完成：细边框 / 对齐 / 数字格式 / 斑马纹（一次行扫描）
    nf_cols = {}
    if args.number_format:
        for tok, fmt in format_pair_items(args.number_format, '--number-format').items():
            nf_cols[column_index(ws, hrow, tok)] = fmt
    if args.thin_border or args.align_data or nf_cols or args.banded:
        side = Side(style='thin', color='BFBFBF') if args.thin_border else None
        border = Border(left=side, right=side, top=side, bottom=side) if side else None
        halign = args.align_data
        bfill = (PatternFill(start_color=args.banded_fill, end_color=args.banded_fill,
                             fill_type='solid') if args.banded else None)
        align_map = {'left': '左', 'center': '居中', 'right': '右'}
        for r in range(first_data, max_r + 1):
            banded_row = bfill is not None and ((r - first_data) % 2 == 1)
            for c in range(1, max_c + 1):
                cell = ws.cell(row=r, column=c)
                if border is not None:
                    cell.border = border
                if halign:
                    cell.alignment = Alignment(horizontal=halign, vertical='center')
                if banded_row:
                    cell.fill = bfill
                if c in nf_cols:
                    cell.number_format = nf_cols[c]
        if args.thin_border:
            log.append('细边框')
        if halign:
            log.append(f'数据{align_map[halign]}对齐')
        if nf_cols:
            log.append(f'数字格式 {len(nf_cols)} 列')
        if args.banded:
            log.append(f'斑马纹（{args.banded_fill}，自第 {first_data + 1} 行起隔行）')

    # 5. 列宽：手工指定 + 自适应（后者受扫描行数上限约束，防大表全扫）
    if args.col_width:
        for tok, w in format_pair_items(args.col_width, '--col-width').items():
            ci = column_index(ws, hrow, tok)
            ws.column_dimensions[get_column_letter(ci)].width = float(w)
            log.append(f'列 "{tok}" 宽 {w}')
    if args.auto_width:
        scan_end = min(max_r, hrow + AUTO_WIDTH_SCAN_ROWS)
        for c in range(1, max_c + 1):
            longest = 0
            # 表头 + 数据（含公式取公式字符串，避免过长可被上限截断）
            for r in range(hrow, scan_end + 1):
                v = ws.cell(row=r, column=c).value
                if v is None:
                    continue
                longest = max(longest, display_width(v))
            ws.column_dimensions[get_column_letter(c)].width = min(longest + 4, args.auto_width)
        scanned = scan_end - hrow + 1
        suffix = f'（数据超过 {AUTO_WIDTH_SCAN_ROWS} 行，仅按前 {scanned} 行计算）' if max_r > scan_end else ''
        log.append(f'自适应列宽（上限 {args.auto_width}）{suffix}')

    # 6. 冻结 + 自动筛选
    if args.freeze:
        ws.freeze_panes = args.freeze
        log.append(f'冻结窗格 {args.freeze}')
    if args.autofilter and max_r >= hrow:
        ws.auto_filter.ref = ws.dimensions
        log.append('自动筛选')

    out_dir = os.path.dirname(os.path.abspath(args.output))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    wb.save(args.output)
    dump_json({
        'mode': 'format',
        'input': in_path,
        'output': os.path.abspath(args.output),
        'sheet': ws.title,
        'rows': max(0, max_r - hrow),
        'cols': max_c,
        'operations': log,
        'note': '原数据/公式/既有格式保留，仅叠加本次样式；公式缓存值需在 Excel 中打开后由软件重算',
    })


if __name__ == '__main__':
    main()
