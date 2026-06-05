# tw/config.py — TW 庫存比對設定
#
# 敏感值(sheet id / 金鑰路徑)順序:環境變數 > tw_secrets.json > 預設。
# tw_secrets.json 已在 .gitignore;範例見 tw_secrets.example.json。
# Node spawn 時可用環境變數 TW_SHEET_ID / TW_CREDENTIALS / TW_GID 覆蓋。
import os
import json

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load_secrets():
    p = os.path.join(_HERE, "tw_secrets.json")
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


_s = _load_secrets()


def _get(key, env, default=None):
    v = os.environ.get(env)
    if v:
        return v
    if _s.get(key) not in (None, ""):
        return _s.get(key)
    return default


CREDENTIALS_FILE = _get("credentials_file", "TW_CREDENTIALS")
SHEET_ID = _get("sheet_id", "TW_SHEET_ID")
CHECK_STOCK_GID = int(_get("check_stock_gid", "TW_GID", 1391214642) or 1391214642)

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",
]

VENDORS = ["IL", "HS", "IN"]

# check stock 第 1 列 header 欄名(實測)
HEADER_PRODUCT_CODE = "Product code"
HEADER_VENDOR_CODE = {
    "IL": "IL product code",
    "HS": "HS product code",
    "IN": "IN product code",
}

# 各廠商低銷門檻(子系統 B 用,先放這供日後)
LOW_SALES = {"IL": 8000, "HS": 3000, "IN": 5000}
