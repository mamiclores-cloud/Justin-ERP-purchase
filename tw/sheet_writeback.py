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
    data = json.loads((sys.stdin.read() or "{}").lstrip("﻿"))   # 容忍可能的 UTF-8 BOM
    rows_in = data.get("rows") or []
    build_date = data.get("buildDate")   # 執行當天(建單日期);None 則不寫建單日期

    ws = M.open_check_stock()
    header = ws.row_values(1)
    week = find_latest_week(header)
    if not week:
        print(json.dumps({"error": "sheet 找不到當週欄組(請公司先建立『採購量 / 需求量』欄)"}, ensure_ascii=False))
        sys.exit(1)

    # 欄組(含建單日期欄)由 Phase A 的 ensure_today_group 建立;這裡只寫值,不再插欄。
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

    num_triples = []     # 需求量 + 採購量(數字 → USER_ENTERED)
    date_triples = []    # 建單日期(文字 → RAW,避免被當日期解析)
    written_rows = 0
    missing = []
    for r in rows_in:
        rn = prod_row.get(norm(r.get("product")))
        if not rn:
            missing.append(r.get("product"))
            continue
        if r.get("demand") is not None and cols.get((None, "需求量")) is not None:
            num_triples.append((rn, cols[(None, "需求量")] + 1, str(r["demand"])))
        vq = r.get("vendorQty") or {}
        for v in VENDORS:
            if vq.get(v) and cols.get((v, "採購量")) is not None:
                num_triples.append((rn, cols[(v, "採購量")] + 1, str(vq[v])))
        # 建單日期:有被分配建單(vendorQty 非空)的列才寫
        if build_date and vq and cols.get((None, "建單日期")) is not None:
            date_triples.append((rn, cols[(None, "建單日期")] + 1, str(build_date)))
        written_rows += 1

    written = apply_cells(ws, num_triples) + apply_cells(ws, date_triples, value_input_option="RAW")
    print(json.dumps({
        "date": week["date"],
        "buildDate": build_date,
        "written_cells": written,
        "rows": written_rows,
        "missing_cols": [k for k in [("IL", "採購量"), ("HS", "採購量"), ("IN", "採購量"), (None, "需求量")] if cols.get(k) is None],
        "missing": missing[:30],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
