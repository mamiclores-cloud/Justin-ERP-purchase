# tw/parsers.py — 三廠商庫存檔解析
#
# 各廠商每週給的格式不同(實測):
#   IN — .xls(UTAMA 表,含 barcode)
#   HS — .pdf(文字可抽,新到貨清單)
#   IL — .xlsx(到貨明細)+ 多張 WhatsApp 商品照片(jpeg)
#
# 設計:
#   _file_text_chunks(path)  把單一檔(任何支援格式)讀成「文字片段 list」
#   extract_vendor(vendor, files)  把該廠商所有檔的片段聯集 → 依廠商抽料號/barcode
#       IL/HS → codes_from_chunks(正規化料號)
#       IN    → barcodes_from_chunks(barcode 數字)
import os
from normalize import codes_from_chunks, barcodes_from_chunks

IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".bmp", ".webp")

_ocr = None  # RapidOCR 單例(載入模型較慢,只初始化一次)


def _ocr_image(path):
    """IL 商品照 → RapidOCR 辨識出的文字行 list(純本地,不接 LLM)。"""
    global _ocr
    if _ocr is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr = RapidOCR()
    with open(path, "rb") as f:           # 用 bytes 避開 opencv 中文路徑問題
        data = f.read()
    result, _elapse = _ocr(data)
    return [item[1] for item in result] if result else []


def _pdf_text(path):
    from pypdf import PdfReader
    rd = PdfReader(path)
    return [(pg.extract_text() or "") for pg in rd.pages]


def _xlsx_cells(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    chunks = []
    for ws in wb.worksheets:
        for row in ws.iter_rows(values_only=True):
            for cell in row:
                if cell is not None:
                    chunks.append(cell)
    wb.close()
    return chunks


def _xls_cells(path):
    import xlrd
    book = xlrd.open_workbook(path)
    chunks = []
    for sh in book.sheets():
        for r in range(sh.nrows):
            for c in range(sh.ncols):
                v = sh.cell_value(r, c)
                if v == "" or v is None:
                    continue
                # xlrd 把數字讀成 float;barcode 若被當數字會有 .0,轉成整數字串
                if isinstance(v, float) and v.is_integer():
                    chunks.append(str(int(v)))
                else:
                    chunks.append(v)
    return chunks


def _csv_cells(path):
    import csv
    rows = None
    for enc in ("utf-8-sig", "cp950", "latin-1"):   # latin-1 永不失敗,當保底
        try:
            with open(path, "r", newline="", encoding=enc) as f:
                rows = list(csv.reader(f))
            break
        except UnicodeDecodeError:
            continue
    chunks = []
    for row in (rows or []):
        for cell in row:
            if cell is not None and str(cell).strip():
                chunks.append(cell)
    return chunks


def _file_text_chunks(path):
    """把單一檔讀成文字片段 list;不認得的副檔名回 []。"""
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext in IMAGE_EXTS:
            return _ocr_image(path)
        if ext == ".pdf":
            return _pdf_text(path)
        if ext == ".xlsx":
            return _xlsx_cells(path)
        if ext == ".xls":
            return _xls_cells(path)
        if ext == ".csv":
            return _csv_cells(path)
    except Exception as e:
        # 單一檔壞掉不該讓整批失敗;回空 + 印警告(stderr)
        import sys
        print(f"[parsers] 解析失敗 {os.path.basename(path)}: {e}", file=sys.stderr)
    return []


def list_input_files(folder):
    """列出資料夾內所有可解析的檔(忽略子目錄)。"""
    out = []
    for fn in sorted(os.listdir(folder)):
        full = os.path.join(folder, fn)
        if os.path.isfile(full):
            out.append(full)
    return out


def extract_vendor(vendor, files):
    """把某廠商所有來源檔的片段聯集,依廠商抽出比對用識別碼集合。
    IL/HS → 正規化料號集合;IN → barcode 集合。"""
    chunks = []
    for path in files:
        chunks.extend(_file_text_chunks(path))
    if str(vendor).upper() == "IN":
        return barcodes_from_chunks(chunks)
    return codes_from_chunks(chunks)
