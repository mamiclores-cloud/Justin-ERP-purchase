#!/usr/bin/env python
# tw/sheet_writeback.py — Phase B 把「需求量 + 各廠商採購量」回填 check stock 當週欄組
#
# stdin JSON: { "date": "YY/MM/DD",
#               "rows": [ { "product": "KFD04 #2", "demand": 124,
#                           "vendorQty": { "IN": 126 } }, ... ] }
# 行為:找/建當週 7 欄組(同 Phase A 格式),寫 需求量 + 對應廠商「採購量」欄。
# 只在 Phase B execute 時被呼叫。輸出 stdout 一行 JSON。
import sys
import os
import re
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import match as M
from sheet_write import WEEK_COLUMNS, _header_text, _col_matches

VENDORS = ("IL", "HS", "IN")


def norm(s):
    return re.sub(r"\s+", "", str(s or "")).upper()


def main():
    data = json.loads(sys.stdin.read() or "{}")
    date = data.get("date") or ""
    rows_in = data.get("rows") or []

    ws = M.open_check_stock()
    header = ws.row_values(1)

    # 找/建當週欄組
    next_col = len(header)
    cols = {}
    new_headers = []
    for spec in WEEK_COLUMNS:
        v, kind = spec
        found = -1
        for i, h in enumerate(header):
            if _col_matches(h, date, v, kind):
                found = i
                break
        if found >= 0:
            cols[spec] = found
        else:
            cols[spec] = next_col
            new_headers.append((next_col, _header_text(date, v, kind)))
            next_col += 1

    # product code → sheet 列號(1-based)
    colA = ws.col_values(1)
    prod_row = {}
    for idx, val in enumerate(colA):
        if idx == 0:
            continue
        p = str(val).strip()
        if p and p != "-":
            prod_row.setdefault(norm(p), idx + 1)

    import gspread
    cells = []
    for (col0, text) in new_headers:
        cells.append(gspread.cell.Cell(1, col0 + 1, text))

    written_rows = 0
    missing = []
    for r in rows_in:
        rn = prod_row.get(norm(r.get("product")))
        if not rn:
            missing.append(r.get("product"))
            continue
        demand = r.get("demand")
        if demand is not None:
            cells.append(gspread.cell.Cell(rn, cols[(None, "需求量")] + 1, str(demand)))
        vq = r.get("vendorQty") or {}
        for v in VENDORS:
            if vq.get(v):
                cells.append(gspread.cell.Cell(rn, cols[(v, "採購量")] + 1, str(vq[v])))
        written_rows += 1

    if cells:
        ws.update_cells(cells, value_input_option="USER_ENTERED")

    print(json.dumps({
        "written_cells": len(cells),
        "rows": written_rows,
        "new_headers": [t for _, t in new_headers],
        "missing": missing[:30],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
