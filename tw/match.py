# tw/match.py — 讀 check stock 料號欄 + 比對當週有貨
#
# 流程:
#   open_check_stock()  以 service account 開 check stock 分頁
#   read_rows(ws)       讀左側固定區(A:U),回每列的 product code + 三廠商料號
#   match_vendor(...)   給某廠商「當週有貨識別碼集合」,算出哪些 sheet 列有貨
#
# 比對 key(實測 + 客戶確認):
#   IL / HS — 廠商料號(normalize_code),OCR 的 I↔1 混淆做容錯
#   IN      — barcode(normalize_barcode)
import config
from normalize import normalize_code, normalize_barcode, ocr_variants


def open_check_stock():
    import gspread
    from google.oauth2.service_account import Credentials
    if not config.CREDENTIALS_FILE or not config.SHEET_ID:
        raise RuntimeError("缺 TW sheet 設定(tw_secrets.json 或環境變數 TW_SHEET_ID / TW_CREDENTIALS)")
    creds = Credentials.from_service_account_file(config.CREDENTIALS_FILE, scopes=config.SCOPES)
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(config.SHEET_ID)
    ws = next((w for w in sh.worksheets() if w.id == config.CHECK_STOCK_GID), None)
    if ws is None:
        raise RuntimeError(f"找不到 gid={config.CHECK_STOCK_GID} 的分頁")
    return ws


def _find_col(header, name):
    for i, h in enumerate(header):
        if str(h).strip().lower() == name.lower():
            return i
    return -1


def read_rows(ws):
    """讀 check stock 左側固定區(A:U)。
    回 (col_index_dict, rows);rows 每筆:
      {row: sheet列號(1-based), product, IL, HS, IN}
    只保留 product code 非空且非 '-' 的列(那是真正對應 ERP 規格的列)。"""
    grid = ws.get("A1:U2000")
    header = grid[0]
    idx = {
        "product": _find_col(header, config.HEADER_PRODUCT_CODE),
        "IL": _find_col(header, config.HEADER_VENDOR_CODE["IL"]),
        "HS": _find_col(header, config.HEADER_VENDOR_CODE["HS"]),
        "IN": _find_col(header, config.HEADER_VENDOR_CODE["IN"]),
    }
    rows = []
    for r_i, row in enumerate(grid[1:], start=2):  # header 在第 1 列
        def cell(k):
            i = idx[k]
            return row[i] if (0 <= i < len(row)) else ""
        product = str(cell("product")).strip()
        if product in ("", "-"):
            continue
        rows.append({
            "row": r_i,
            "product": product,
            "IL": cell("IL"), "HS": cell("HS"), "IN": cell("IN"),
        })
    return idx, rows


def match_vendor(rows, vendor, vendor_ids):
    """給某廠商當週有貨識別碼集合 vendor_ids(IL/HS=料號, IN=barcode),
    算出哪些 sheet 列有貨。回 set(sheet 列號)。"""
    vendor = str(vendor).upper()
    have = set()
    if vendor == "IN":
        stock = {normalize_barcode(x) for x in vendor_ids if normalize_barcode(x)}
        for r in rows:
            key = normalize_barcode(r["IN"])
            if key and key in stock:
                have.add(r["row"])
    else:
        # IL/HS:有貨集合先展開 I↔1 容錯,比對更穩
        stock = set()
        for c in vendor_ids:
            stock |= ocr_variants(c)
        for r in rows:
            raw = r[vendor]
            if raw is None or str(raw).strip() in ("", "-"):
                continue
            key = normalize_code(raw)
            if key and (ocr_variants(key) & stock):
                have.add(r["row"])
    return have
