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
        elif "建單日期" in n:
            kind = "建單日期"
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


# 各廠商欄位「標題列」底色(讀自既有 5/25 欄組);資料列維持白底。需求量(紫)為既有欄不動。
VENDOR_BG = {
    "IL": {"red": 182 / 255.0, "green": 215 / 255.0, "blue": 168 / 255.0},  # #B6D7A8 綠
    "HS": {"red": 234 / 255.0, "green": 153 / 255.0, "blue": 153 / 255.0},  # #EA9999 紅
    "IN": {"red": 164 / 255.0, "green": 194 / 255.0, "blue": 244 / 255.0},  # #A4C2F4 藍
}
_WHITE = {"red": 1, "green": 1, "blue": 1}


def _a1col(n):
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _color_group(ws, cols):
    """新欄組廠商欄上色:標題=廠商色、資料列=白(覆蓋插欄從需求量繼承來的紫)。"""
    nrows = ws.row_count or 1000
    fmts = []
    for v in VENDORS:
        for kind in ("有庫存", "採購量"):
            ci = cols.get((v, kind))
            if ci is None:
                continue
            col = _a1col(ci + 1)
            fmts.append({"range": "%s1" % col, "format": {"backgroundColor": VENDOR_BG[v]}})
            fmts.append({"range": "%s2:%s%d" % (col, col, nrows), "format": {"backgroundColor": _WHITE}})
    if not fmts:
        return
    try:
        ws.batch_format(fmts)
    except Exception:                # 舊版 gspread 無 batch_format → 逐一
        for f in fmts:
            ws.format(f["range"], f["format"])


def ensure_today_group(ws, today):
    """確保有一組『日期=today』的欄(IL/HS/IN × 有庫存/採購量)在『需求量』左邊。
    『需求量』(紫)為單一最右欄,順便把它的日期改成 today。新建時依廠商上色。
    同一天已建 → 不重複插入(冪等)。回 find_latest_week(更新後) 結果;sheet 無『需求量』欄回 None。"""
    header = ws.row_values(1)
    demand_idx = None
    for i, h in enumerate(header):
        if "需求量" in _norm(h):
            demand_idx = i                       # 取最右(需求量為單一欄)
    if demand_idx is None:
        return None

    has_today = any(
        ("有庫存" in _norm(h)) and (str(h).split("\n")[0].strip() == today)
        for h in header if str(h).strip()
    )
    if not has_today:
        new_cols = []                            # 順序同既有欄組:IL/HS/IN × 有庫存/採購量(不含建單日期)
        for v in VENDORS:
            new_cols.append([u"%s\n%s\n有庫存" % (today, v)])
            new_cols.append([u"%s\n%s\n採購量" % (today, v)])
        ws.insert_cols(new_cols, col=demand_idx + 1, value_input_option="USER_ENTERED")
        header = ws.row_values(1)                # 插欄後右移,重抓需求量位置
        demand_idx = None
        for i, h in enumerate(header):
            if "需求量" in _norm(h):
                demand_idx = i

    want = u"%s\n需求量" % today                  # 需求量日期 → today(永遠最右)
    if str(ws.cell(1, demand_idx + 1).value) != want:
        ws.update_cell(1, demand_idx + 1, want)
        header = ws.row_values(1)

    res = find_latest_week(header)
    if res is not None:
        res["createdToday"] = not has_today
        if not has_today:
            _color_group(ws, res["cols"])        # 只在新建時上色
    return res


def clear_data(ws, col0_list):
    """清掉指定欄(0-based)的資料列(第 2 列起)值,保留標題與格式。
    避免上次跑剩的舊值殘留(ERP 需求/有貨會隨時間變,沒清會出現「有需求量卻沒採購量」的假象)。"""
    nrows = ws.row_count or 1000
    ranges = []
    for c in col0_list:
        if c is None:
            continue
        a = _a1col(c + 1)
        ranges.append("%s2:%s%d" % (a, a, nrows))
    if ranges:
        ws.batch_clear(ranges)


def apply_cells(ws, triples, value_input_option="USER_ENTERED"):
    """triples: [(row1based, col1based, value)] → 一次 batch 寫入。回寫入格數。
    value_input_option:數字用 USER_ENTERED;文字用 RAW(避免被當日期重新解析)。"""
    if not triples:
        return 0
    import gspread
    cells = [gspread.cell.Cell(row=r, col=c, value=v) for (r, c, v) in triples]
    ws.update_cells(cells, value_input_option=value_input_option)
    return len(cells)
