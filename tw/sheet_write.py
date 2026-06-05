# tw/sheet_write.py — 把比對結果寫回 check stock
#
# 結構(實測):每週一組欄,header 是「單格內換行」: {日期}\n{廠商}\n{有庫存|採購量}
#   IL有庫存 | IL採購量 | HS有庫存 | HS採購量 | IN有庫存 | IN採購量 | 需求量
# 子系統 A 只新增/沿用該週欄組,並在三個「有庫存」欄對命中列打小寫 v。
#
# build_plan() 純計算(dry-run 安全);apply_plan() 才真的寫 sheet。

# 一週的欄組(順序固定,對齊 sheet 既有排法)
WEEK_COLUMNS = [
    ("IL", "有庫存"), ("IL", "採購量"),
    ("HS", "有庫存"), ("HS", "採購量"),
    ("IN", "有庫存"), ("IN", "採購量"),
    (None, "需求量"),
]
STOCK_MARK = "v"


def _header_text(date, vendor, kind):
    return f"{date}\n{vendor}\n{kind}" if vendor else f"{date}\n{kind}"


def _col_matches(cell, date, vendor, kind):
    """判斷某 header 格是否屬於 (date, vendor, kind) 欄。容忍空白/換行差異。"""
    c = str(cell or "").replace(" ", "").replace("\n", "")
    if date.replace(" ", "") not in c:
        return False
    if kind not in c:
        return False
    if vendor:
        return vendor in c
    # 需求量欄:不帶任何廠商名
    return not any(v in c for v in ("IL", "HS", "IN"))


def build_plan(ws, date, have_by_vendor):
    """計算寫回方案(不寫 sheet)。
    have_by_vendor: {"IL": set(sheet列號), "HS": ..., "IN": ...}
    回 dict:
      { date, reused(bool), new_headers:[(col0,text)], writes:[(row,col0,'v')],
        cols:{(vendor,kind):col0}, write_count_by_vendor:{...} }
    """
    header = ws.row_values(1)
    next_col = len(header)  # 第一個空欄(0-based)

    cols = {}
    new_headers = []
    reused = False
    for spec in WEEK_COLUMNS:
        v, kind = spec
        found = -1
        for i, h in enumerate(header):
            if _col_matches(h, date, v, kind):
                found = i
                break
        if found >= 0:
            cols[spec] = found
            reused = True
        else:
            cols[spec] = next_col
            new_headers.append((next_col, _header_text(date, v, kind)))
            next_col += 1

    writes = []
    write_count = {}
    for v in ("IL", "HS", "IN"):
        col0 = cols[(v, "有庫存")]
        rownums = sorted(have_by_vendor.get(v, set()))
        write_count[v] = len(rownums)
        for rownum in rownums:
            writes.append((rownum, col0, STOCK_MARK))

    return {
        "date": date,
        "reused": reused,
        "new_headers": new_headers,
        "writes": writes,
        "cols": cols,
        "write_count_by_vendor": write_count,
    }


def apply_plan(ws, plan):
    """真的寫回 sheet:先補欄組 header,再打 v。回寫入格數。"""
    import gspread
    cells = []
    for (col0, text) in plan["new_headers"]:
        cells.append(gspread.cell.Cell(row=1, col=col0 + 1, value=text))
    for (rownum, col0, val) in plan["writes"]:
        cells.append(gspread.cell.Cell(row=rownum, col=col0 + 1, value=val))
    if not cells:
        return 0
    # USER_ENTERED:讓 'v' 當純文字;header 換行用 \n
    ws.update_cells(cells, value_input_option="USER_ENTERED")
    return len(cells)
