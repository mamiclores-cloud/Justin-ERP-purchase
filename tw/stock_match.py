#!/usr/bin/env python
# tw/stock_match.py — Phase A:三廠商庫存檔 → 比對 → 寫 v
#
# 用法:python stock_match.py [--uploads <dir>] [--date YY/MM/DD] [--execute]
#   uploads 目錄結構:<dir>/IL/*  <dir>/HS/*  <dir>/IN/*(各廠商子資料夾,可空 / 可不給)
#
# 「每週才更新一次庫存」的快取邏輯:
#   - 某廠商這次「有上傳檔」→ 解析(含 OCR)→ 更新該廠商快取。
#   - 某廠商這次「沒上傳」  → 沿用上次快取(不再 OCR)。
#   - 完全沒上傳            → 全用快取(沒快取則報錯,請先上傳一次)。
#   快取:state/tw-stock/parsed.json = { date, vendors: {IL:[...], HS:[...], IN:[...]} }
#   有效日期:有新上傳 = 今天(--date);全用快取 = 快取裡的日期(維持同一週欄組)。
import sys
import os
import json
import argparse
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import match as M
import sheet_write as W
from parsers import extract_vendor, list_input_files
from normalize import normalize_code, ocr_variants

VENDORS = ("IL", "HS", "IN")
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(_ROOT, "state", "tw-stock")
CACHE_FILE = os.path.join(CACHE_DIR, "parsed.json")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def today_str():
    d = datetime.date.today()
    return f"{d.year % 100:02d}/{d.month:02d}/{d.day:02d}"


def load_cache():
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_cache(date, vendor_sets):
    os.makedirs(CACHE_DIR, exist_ok=True)
    data = {
        "date": date,
        "savedAt": today_str(),
        "vendors": {v: sorted(vendor_sets.get(v, set())) for v in VENDORS},
    }
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def find_unmatched(vendor, ids, rows):
    """廠商檔有、但 sheet 對不上的識別碼 → 資料維護提示。IN 不列(完整目錄)。"""
    if vendor == "IN":
        return []
    sheet_ids = set()
    for r in rows:
        k = normalize_code(r[vendor])
        if k:
            sheet_ids |= ocr_variants(k)
    return sorted(x for x in ids if not (ocr_variants(x) & sheet_ids))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--uploads", default="", help="廠商檔根目錄(內含 IL/ HS/ IN/;可空 = 用快取)")
    ap.add_argument("--date", default=None)
    ap.add_argument("--execute", action="store_true")
    args = ap.parse_args()
    date = args.date or today_str()

    ws = M.open_check_stock()
    idx, rows = M.read_rows(ws)
    log(f"[A] 有效規格列 {len(rows)}")

    cache = load_cache()
    vendor_sets = {}
    src = {}                 # 每家來源:upload / cache / none
    any_upload = False
    for v in VENDORS:
        folder = os.path.join(args.uploads, v) if args.uploads else ""
        files = list_input_files(folder) if (folder and os.path.isdir(folder)) else []
        if files:
            log(f"[A] {v}: {len(files)} 檔解析中(含 OCR)...")
            vendor_sets[v] = extract_vendor(v, files)
            src[v] = "upload"
            any_upload = True
        elif cache and cache.get("vendors", {}).get(v):
            vendor_sets[v] = set(cache["vendors"][v])
            src[v] = "cache"
        else:
            vendor_sets[v] = set()
            src[v] = "none"

    if any_upload:
        eff_date = date
        save_cache(eff_date, vendor_sets)        # 有上傳的覆蓋、沒上傳的沿用 → 存新快取
        log(f"[A] 更新庫存快取(日期 {eff_date})")
    else:
        if not cache:
            print(json.dumps({"error": "尚無庫存資料:請先上傳一次三廠商庫存檔。"}, ensure_ascii=False))
            sys.exit(1)
        eff_date = cache.get("date") or date
        log(f"[A] 沒有新上傳 → 用上次快取(日期 {eff_date},免 OCR)")

    have, unmatched = {}, {}
    for v in VENDORS:
        have[v] = M.match_vendor(rows, v, vendor_sets[v])
        unmatched[v] = find_unmatched(v, vendor_sets[v], rows)
        log(f"[A] {v}: 來源={src[v]} 識別碼 {len(vendor_sets[v])} / 命中 {len(have[v])} 列")

    plan = W.build_plan(ws, eff_date, have)
    written = 0
    if args.execute:
        written = W.apply_plan(ws, plan)
        log(f"[A] 寫入 {written} 格")
    else:
        log("[A] dry-run(未寫入)")

    result = {
        "date": eff_date,
        "mode": "execute" if args.execute else "dry-run",
        "usedCache": (not any_upload),
        "source": src,
        "rows": len(rows),
        "matched": {v: len(have[v]) for v in VENDORS},
        "unmatched_count": {v: len(unmatched[v]) for v in VENDORS},
        "unmatched_sample": {v: unmatched[v][:50] for v in VENDORS},
        "new_columns": [t for (_c, t) in plan["new_headers"]],
        "reused_week_group": plan["reused"],
        "written_cells": written,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
