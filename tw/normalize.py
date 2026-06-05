# tw/normalize.py — 料號正規化(純函數,給比對用)
#
# 規則(對齊客戶確認):
#   - IL / HS:用「廠商料號」比對,後綴變體當同一品
#       AI001Y  -> AI001   (去尾端 Y)
#       AI010-1 -> AI010   (去尾端 -N)
#       KFZ511  -> KFZ511
#   - IN:用 barcode 數字比對(sheet 的 IN product code 欄存的是 barcode)
import re

_SUFFIX_DASH = re.compile(r"-\d+$")
_SUFFIX_Y = re.compile(r"Y$")

# 料號形態:1~4 碼字母 + 2~5 碼數字 (+可選 -N 後綴),例 EK001 / EK007-2 / KFZ511 / B601-1
CODE_RE = re.compile(r"[A-Z]{1,4}\d{2,5}(?:-\d+)?")
# barcode:11~14 位數字(濾掉售價/入數/庫存量等短數字)
BARCODE_RE = re.compile(r"\d{11,14}")


def normalize_code(code):
    """IL/HS 廠商料號正規化:去空白、轉大寫、去 -N / Y 後綴變體。"""
    s = re.sub(r"\s+", "", str(code or "")).upper()
    s = _SUFFIX_DASH.sub("", s)
    s = _SUFFIX_Y.sub("", s)
    return s


def normalize_barcode(code):
    """IN barcode 正規化:只留數字。"""
    return re.sub(r"\D", "", str(code or ""))


def codes_from_chunks(chunks):
    """從一堆文字片段抽出正規化後的料號集合(IL/HS 用)。"""
    out = set()
    for s in chunks:
        for tok in CODE_RE.findall(str(s).upper()):
            n = normalize_code(tok)
            if n:
                out.add(n)
    return out


def _degenerate_barcode(s):
    """濾掉明顯垃圾 barcode:全零、或 >=4 個前導 0(tnw 統計表的補零內部碼)。
    真實 EAN barcode 最多 2 個前導 0(例 008968…),sheet 端也無 >=4 前導 0,故安全。"""
    if not s or set(s) == {"0"}:
        return True
    return s.startswith("0000")


def barcodes_from_chunks(chunks):
    """從一堆文字片段抽出 barcode 集合(IN 用);跳過垃圾碼。"""
    out = set()
    for s in chunks:
        for m in BARCODE_RE.findall(str(s)):
            if not _degenerate_barcode(m):
                out.add(m)
    return out


def ocr_variants(code):
    """OCR I↔1 混淆容錯:回傳料號的可能變體集合(IL/HS 比對用)。
    例 A1002(OCR 把 AI 讀成 A1)→ {A1002, AI002}。"""
    out = {code}
    if "1" in code or "I" in code:
        out.add(code.replace("1", "I"))
        out.add(code.replace("I", "1"))
    return out
