#!/usr/bin/env python
# tw/sheet_writeback.py — Phase B 把「需求量 + 各廠商採購量」寫回「最右(最新)欄組」
#
# stdin JSON: { "rows": [ { "product": "KFD04 #2", "demand": 124,
#                           "vendorQty": { "IN": 126 } }, ... ] }
# ★ 不新增欄:只寫進公司已建好的最右欄組(找不到對應欄就略過該欄並回報)。
import sys
import os
import re
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import match as M
from sheet_write import find_latest_week, apply_cells

VENDORS = ("IL", "HS", "IN")


def norm(s):
    return re.sub(r"\s+", "", str(s or "")).upper()


def main():
    data = json.loads(sys.stdin.read() or "{}")
    rows_in = data.get("rows") or []

    ws = M.open_check_stock()
    header = ws.row_values(1)
    week = find_latest_week(header)
    if not week:
        print(json.dumps({"error": "sheet 找不到當週欄組(請公司先建立『採購量 / 需求量』欄)"}, ensure_ascii=False))
        sys.exit(1)
    cols = week["cols"]

    # product code → sheet 列號(1-based)
    colA = ws.col_values(1)
    prod_row = {}
    for idx, val in enumerate(colA):
        if idx == 0:
            continue
        p = str(val).strip()
        if p and p != "-":
            prod_row.setdefault(norm(p), idx + 1)

    triples = []
    written_rows = 0
    missing = []
    for r in rows_in:
        rn = prod_row.get(norm(r.get("product")))
        if not rn:
            missing.append(r.get("product"))
            continue
        if r.get("demand") is not None and cols.get((None, "需求量")) is not None:
            triples.append((rn, cols[(None, "需求量")] + 1, str(r["demand"])))
        vq = r.get("vendorQty") or {}
        for v in VENDORS:
            if vq.get(v) and cols.get((v, "採購量")) is not None:
                triples.append((rn, cols[(v, "採購量")] + 1, str(vq[v])))
        written_rows += 1

    written = apply_cells(ws, triples)
    print(json.dumps({
        "date": week["date"],
        "written_cells": written,
        "rows": written_rows,
        "missing_cols": [k for k in [("IL", "採購量"), ("HS", "採購量"), ("IN", "採購量"), (None, "需求量")] if cols.get(k) is None],
        "missing": missing[:30],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
