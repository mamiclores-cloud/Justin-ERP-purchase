# tw/sheet_write.py — 找「公司預先建好的最右(最新)週欄組」+ 寫入
#
# ★ 設計:欄位由公司預先建好(最新日期在最右)。本工具【絕不新增欄】,
#   只找最右邊那組「有庫存 / 採購量 / 需求量」欄,把值寫進去。
#   日期以該欄組 header 為準(不是執行當天)。
VENDORS = ("IL", "HS", "IN")


def _norm(s):
    return str(s or "").replace(" ", "").replace("\n", "")


def find_latest_week(header):
    """從 header(第 1 列)找最右(最新)的週欄組。
    對每個 (vendor, kind) 取「最右邊」那欄(robust:不靠日期字串完全相等)。
    kind ∈ 有庫存 / 採購量 / 需求量;vendor ∈ IL/HS/IN 或 None(需求量)。
    回 {date, cols:{(vendor,kind):col0}};沒有任何週欄回 None。"""
    cols = {}
    latest_i, latest_date = -1, None
    for i, h in enumerate(header):
        c = str(h or "")
        if not c.strip():
            continue
        n = _norm(c)
        if "有庫存" in n:
            kind = "有庫存"
        elif "採購量" in n:
            kind = "採購量"
        elif "需求量" in n:
            kind = "需求量"
        else:
            continue
        vendor = next((v for v in VENDORS if v in n), None)
        key = (vendor, kind)
        if key not in cols or i > cols[key]:
            cols[key] = i
        if i > latest_i:
            latest_i, latest_date = i, c.split("\n")[0].strip()
    if not cols:
        return None
    return {"date": latest_date, "cols": cols}


def apply_cells(ws, triples):
    """triples: [(row1based, col1based, value)] → 一次 batch 寫入。回寫入格數。"""
    if not triples:
        return 0
    import gspread
    cells = [gspread.cell.Cell(row=r, col=c, value=v) for (r, c, v) in triples]
    ws.update_cells(cells, value_input_option="USER_ENTERED")
    return len(cells)
