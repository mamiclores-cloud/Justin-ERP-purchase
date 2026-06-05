#!/usr/bin/env python
# tw/sheet_dump.py — 讀 check stock,輸出每列「定價 + 最新一週有貨」(給 Node Phase B 分配用)
#
# 輸出(stdout 一行 JSON):
#   { "rows": [ { "product": "KBT109",
#                 "vendors": { "IL": {code, hasStock, unitPrice, boxSize, minPcs}, "HS":..., "IN":... } }, ... ],
#     "stockCols": { "IL": "<最新有庫存欄 header>", ... } }
#
# hasStock = 該廠商「最新一週」的「有庫存」欄是否為小寫 v。
import sys
import os
import json
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import match as M

VENDORS = ("IL", "HS", "IN")


def to_num(x):
    s = re.sub(r"[^\d.]", "", str(x or ""))
    try:
        return float(s) if s else 0
    except ValueError:
        return 0


def min_pcs(x):
    m = re.search(r"\d+", str(x or ""))
    return int(m.group()) if m else 0


def box_from_note(note):
    # 有些品「每箱數量」欄空著,真正的一箱幾件寫在 Price 備註自由文字,如 "MIN 40 PCS" → 一箱 40 個
    m = re.search(r"MIN\s*(\d+)\s*PCS", str(note or ""), re.I)
    return int(m.group(1)) if m else 0


def main():
    ws = M.open_check_stock()
    grid = ws.get("A1:LD1600")            # 需含右側「有庫存」欄
    header = grid[0]

    def col(name):
        for i, h in enumerate(header):
            if str(h).strip().lower() == name.lower():
                return i
        return -1

    base = {}
    for v in VENDORS:
        c = col(f"{v} product code")
        base[v] = {"code": c, "price": c + 1, "box": c + 2, "min": c + 3, "note": c + 4}

    # 各廠商「最新(最右)」有庫存欄 — 用共用 find_latest_week(只認最右欄組,不新增)
    from sheet_write import find_latest_week
    week = find_latest_week(header)
    week_date = week["date"] if week else None
    stockcol = {v: (week["cols"].get((v, "有庫存")) if week else None) for v in VENDORS}

    rows = []
    for r in grid[1:]:
        prod = (r[0] if len(r) > 0 else "").strip()
        if prod in ("", "-"):
            continue
        vd = {}
        for v in VENDORS:
            b = base[v]
            code = str(r[b["code"]] if 0 <= b["code"] < len(r) else "").strip()
            sc = stockcol.get(v)
            has = sc is not None and sc < len(r) and str(r[sc]).strip().lower() == "v"
            box = int(to_num(r[b["box"]] if b["box"] < len(r) else ""))
            note = r[b["note"]] if b["note"] < len(r) else ""
            if not box:                       # 每箱數量欄空 → 試從 Price 備註抓「MIN N PCS」
                box = box_from_note(note)
            vd[v] = {
                "code": code,
                "hasStock": has,
                "unitPrice": to_num(r[b["price"]] if b["price"] < len(r) else ""),
                "boxSize": box,
                "minPcs": min_pcs(r[b["min"]] if b["min"] < len(r) else ""),
            }
        rows.append({"product": prod, "vendors": vd})

    out = {
        "rows": rows,
        "weekDate": week_date,
        "stockCols": {v: (str(header[stockcol[v]]).replace("\n", " ") if stockcol.get(v) is not None else None) for v in VENDORS},
    }
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
