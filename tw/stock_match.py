#!/usr/bin/env python
# tw/stock_match.py — Phase A:三廠商庫存檔 → 比對 → 在「最右(最新)欄組」打 v
#
# 用法:python stock_match.py [--uploads <dir>] [--execute]
#   uploads 目錄結構:<dir>/IL/*  <dir>/HS/*  <dir>/IN/*(各廠商子資料夾,可空 / 可不給)
#
# ★ execute 時:程式自己在『需求量』(紫,單一最右欄)左邊新增一組「執行當天」日期的欄
#   (IL/HS/IN×有庫存/採購量 + 建單日期),把 v 打進當天「有庫存」欄;同一天重跑不重建。
#   dry-run 不動 sheet,只讀最右組。需求量永遠維持在最右、日期同步成今天。
#
# 「每週才更新一次庫存」的快取邏輯(只影響「是否重新 OCR」,不影響欄位日期):
#   - 某廠商有上傳檔 → 解析(含 OCR)→ 更新該廠商快取。
#   - 某廠商沒上傳   → 沿用上次快取(不再 OCR)。
#   - 完全沒上傳     → 全用快取(沒快取則報錯)。
#   快取:state/tw-stock/parsed.json = { vendors: {IL:[...], HS:[...], IN:[...]} }
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


def save_cache(vendor_sets):
    os.makedirs(CACHE_DIR, exist_ok=True)
    data = {"savedAt": today_str(), "vendors": {v: sorted(vendor_sets.get(v, set())) for v in VENDORS}}
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def find_unmatched(vendor, ids, rows):
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
    ap.add_argument("--uploads", default="")
    ap.add_argument("--date", default=None)        # 保留相容,實際日期取自 sheet 最右欄組
    ap.add_argument("--execute", action="store_true")
    args = ap.parse_args()

    ws = M.open_check_stock()
    idx, rows = M.read_rows(ws)
    if args.execute:
        week = W.ensure_today_group(ws, today_str())   # 建當天欄組(於需求量左、需求量日期改今天),同日不重建
    else:
        week = W.find_latest_week(ws.row_values(1))     # dry-run 不動 sheet,只讀最右組
    if not week:
        print(json.dumps({"error": "sheet 找不到『需求量』欄(請確認副本格式)"}, ensure_ascii=False))
        sys.exit(1)
    eff_date = week["date"]
    log(f"[A] 有效規格列 {len(rows)};{'當天新欄組' if args.execute else '最右欄組'}日期 {eff_date}{'(本次新建)' if week.get('createdToday') else ''}")

    cache = load_cache()
    vendor_sets, src, any_upload = {}, {}, False
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
        save_cache(vendor_sets)
        log("[A] 更新庫存快取(有上傳的覆蓋、沒上傳的沿用)")
    elif not cache:
        print(json.dumps({"error": "尚無庫存資料:請先上傳一次三廠商庫存檔。"}, ensure_ascii=False))
        sys.exit(1)
    else:
        log("[A] 沒有新上傳 → 全用上次快取(免 OCR)")

    have, unmatched = {}, {}
    for v in VENDORS:
        have[v] = M.match_vendor(rows, v, vendor_sets[v])
        unmatched[v] = find_unmatched(v, vendor_sets[v], rows)
        log(f"[A] {v}: 來源={src[v]} 識別碼 {len(vendor_sets[v])} / 命中 {len(have[v])} 列")

    # 只往最右那組「有庫存」欄打 v(不新增欄)
    written = 0
    missing_cols = [v for v in VENDORS if week["cols"].get((v, "有庫存")) is None]
    if args.execute:
        triples = []
        for v in VENDORS:
            ci = week["cols"].get((v, "有庫存"))
            if ci is None:
                continue
            for rownum in sorted(have[v]):
                triples.append((rownum, ci + 1, "v"))
        written = W.apply_cells(ws, triples)
        log(f"[A] 寫入 {written} 格(打 v)到 {eff_date} 欄組")
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
        "missing_stock_cols": missing_cols,    # 該日期欄組缺哪幾家的「有庫存」欄
        "written_cells": written,
        "groupCreated": bool(week.get("createdToday")),
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
