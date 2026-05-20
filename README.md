# Justin ERP Purchase

> 阿靳 / 網翼電商經營工具 ERP 智能採購自動建單

把原本 UI 上要逐張慢慢點的智能採購建單作業，壓縮成**輸入條件 → 一鍵建單 → 異常自動分類記錄**。HTTP-direct，不靠 UI 自動化。

支援兩種工作流程：

| Workflow | 搜尋方式 | 加總門檻 | 標籤排除 | 特殊 |
|---|---|---|---|---|
| **Indo** | `Keyword='Indo'` | ≥ 6 | 無 | — |
| **1688** | `keywordType='ALL'` 廣泛 | ≥ 3 | 排除 `Indo`/`TW`/`YLL`/`Thai`/`SKSP*` | **Phase 2 SKSP 共同採購**：同 `SKSP###` 代碼合單 |

對應流程（客戶逐字稿）：
- 1️⃣ 設定搜尋條件 → 拉候選商品
- 2️⃣ 套訂購條件（**規格加總 ≥ 門檻** + **NX 倍數**）
- 3️⃣ 不訂購原則（**STOP 規格跳過** + **1688 標籤排除**）
- 4️⃣ 共同採購（**1688 only**：SKSP 同代碼合單）
- 5️⃣ 異常回報（數量不足 / STOP 故沒訂購）

---

## 特色

- **HTTP-direct** — 反推 ERP 前端 JS 找出 `POST /api/PurchaseSheet/add` 的 payload，跳過所有 modal 與按鈕點擊
- **純函數規則引擎** — `lib/purchase-rules.js` 完全無 Playwright/HTTP 依賴，方便獨立測試
- **分步 vs 一鍵兩種模式** — 分步可鎖單一 MainId 測規則；一鍵批次處理搜尋結果
- **即時異常紀錄** — dry-run / execute 都記，per-spec 細粒度（每個被 STOP 跳過的規格各一筆）
- **CSV 下載** — UTF-8 BOM，Excel 開不亂碼；含 mode 欄位區分 dry-run / execute
- **排程** — 每日固定時間 / 一次性執行
- **共用 sister project 的 chrome-profile** — distribution-print 那邊登好的 cookies 直接拿來用，雙專案共用一份 session

---

## 系統架構

```mermaid
graph TB
    subgraph Browser["瀏覽器 / 員工操作"]
        UI["index.html + style.css<br/>IBM Plex Sans + 深綠色 accent"]
        APP["app.js<br/>分步 / 一鍵 / 異常紀錄 / 排程"]
    end

    subgraph Server["後端 Node.js"]
        SRV["server.js (port 3001)<br/>HTTP API + Job Manager"]
        SCHED["排程引擎<br/>schedules.json"]
        KEEP["Session keep-alive<br/>每 4 小時"]
    end

    subgraph CLI["主邏輯（child_process）"]
        PC["purchase-create.js<br/>主流程腳本"]
        FETCH["_fetch-options.js<br/>supplier / translocation 拉選單"]
    end

    subgraph Lib["共用 Library"]
        SES["lib/session.js<br/>Playwright + reCAPTCHA fallback"]
        HTTP["lib/http-client.js<br/>Purchase / Supplier / Translocation"]
        RULE["lib/purchase-rules.js<br/>parseTags / decideProduct / buildAddPayload"]
    end

    subgraph State["持久化狀態"]
        ANOM["state/anomalies.jsonl<br/>append-only"]
        SCHEDFILE["schedules.json"]
    end

    subgraph ERP["Ajin ERP"]
        SRV01["srv01.ajinerp.com"]
        PSL["/api/ProductOverview/ProductSpecList"]
        ADD["/api/PurchaseSheet/add"]
        PROF["chrome-profile<br/>(共用 distribution-print)"]
    end

    APP -.->|REST + polling| SRV
    SRV --> SCHED & KEEP
    SRV -->|spawn| PC & FETCH
    SRV --> SCHEDFILE
    PC --> SES & HTTP & RULE
    PC -->|append| ANOM
    APP -.->|GET /api/anomalies + CSV| ANOM
    FETCH --> SES & HTTP
    SES -.->|persistent context| PROF
    PROF -.-> SRV01
    HTTP -.-> SRV01
    SRV01 --> PSL & ADD

    classDef rule fill:#e7f0ea,stroke:#2d6a4f,color:#1d4a37
    classDef api fill:#e3e3e3,stroke:#666
    class RULE,PC rule
    class SRV01,PSL,ADD,PROF api
```

---

## 業務規則決策樹

對每張**候選商品**逐一跑這個樹：

```mermaid
flowchart TD
    Start([候選商品<br/>product + productSpc 陣列]) --> ParseKey[解析 KeyWord<br/>找 NX / STOP tag]
    ParseKey --> ParseRem[STOP tag 存在?<br/>有 → 解析 Remark STOP : list]
    ParseRem --> Loop{遍歷規格}
    Loop -->|needpurchase = false| Next[Next]
    Loop -->|needpurchase = true| StopCheck{在 STOP 列表?}
    StopCheck -->|是| StopAnomaly[記異常<br/>stop-spec-skipped<br/>per-spec]
    StopCheck -->|否| KeepSpec[加入 kept]
    StopAnomaly --> Next
    KeepSpec --> Next
    Next --> Loop
    Loop -->|遍歷完| SumCheck{kept 原值加總 >= 6?}
    SumCheck -->|否| InsufAnomaly[記異常<br/>insufficient-quantity<br/>per-product]
    SumCheck -->|是| NXCheck{有 NX tag?}
    NXCheck -->|是 N| Round[每規格<br/>ceil qty / N * N]
    NXCheck -->|否| Direct[用原 needpurchaseQty]
    Round --> Build[組 PurchaseSheetViewData]
    Direct --> Build
    Build --> ModeCheck{execute mode?}
    ModeCheck -->|是| Post[POST /api/PurchaseSheet/add]
    ModeCheck -->|否 dry-run| DryEnd([印計畫])
    Post --> RealEnd([建單成功])
    InsufAnomaly --> SkipEnd([跳過本商品])

    classDef anom fill:#f3eadb,stroke:#8b5a1d,color:#8b5a1d
    classDef ok fill:#e4eee6,stroke:#2c6b3a,color:#2c6b3a
    class StopAnomaly,InsufAnomaly anom
    class RealEnd,DryEnd ok
```

**重點規則** ([完整對應逐字稿 1-6.txt + 鞏固版 (1).txt + 補充-共同採購.txt]):

| KeyWord 含 | 規則 | 兩 workflow 行為 |
|---|---|---|
| `NX`（例 `12X`、`6X`、`8X`）| 每個有 `needpurchaseQty` 的規格，無條件進位到 N 的倍數 | 通用 |
| `STOP` | 進 `product.Remark` 讀 `STOP : <規格清單>`，列名的規格整個跳過（per-spec 記異常）；Remark 沒列規格 → 整品跳過 | 通用 |
| `Indo` / `TW` / `YLL` / `Thai` | — | **Indo workflow**: 一般處理；**1688 workflow**: SKIP-TAG（排除）|
| `SKSP###`（例 `SKSP121`、`SKSP02`）| 共同採購供應商代碼 | **Indo workflow**: 忽略；**1688 workflow**: Phase 1 排除、Phase 2 合單 |
| 其他（`150%` / `New0516` / `focallure` ...）| 一律忽略 | 通用 |

**加總門檻判斷使用原值**（不放大後）：
- 通過 `≥ 門檻` → 才進 NX 放大 → POST
- 不過 `< 門檻` → 整單不建 + 記 `insufficient-quantity` 異常
- Indo workflow 門檻 = 6；1688 workflow 門檻 = 3

---

## 1688 兩階段工作流程

1688 一鍵採購會 **一個 child process 跑完兩個階段**：

```mermaid
flowchart TD
    Start([1688 一鍵採購<br/>workflow=1688]) --> P1Search[Phase 1 廣泛搜尋<br/>keywordType=ALL  keyword=空]
    P1Search --> P1Loop{遍歷候選商品}
    P1Loop --> P1Tag{含 Indo/TW/YLL/Thai/SKSP*?}
    P1Tag -->|是| P1Skip[SKIP-TAG<br/>留給 Phase 2 處理<br/>不算異常]
    P1Tag -->|否| P1Rules[套商業規則<br/>STOP / NX / 加總≥3]
    P1Rules --> P1Decide{decision?}
    P1Decide -->|create| P1Post[POST add<br/>個別採購單]
    P1Decide -->|skip-insufficient| P1Anom[記異常<br/>insufficient-quantity]
    P1Skip --> P1Loop
    P1Post --> P1Loop
    P1Anom --> P1Loop
    P1Loop -->|完| P2Search[Phase 2 SKSP 搜尋<br/>keyword=SKSP]
    P2Search --> P2Decide[每商品 decideProduct<br/>threshold=0]
    P2Decide --> P2Group[依 SKSP### 代碼分組]
    P2Group --> P2Loop{遍歷每組}
    P2Loop --> P2Sum{群組合計 rawSum ≥ 3?}
    P2Sum -->|否| P2GAnom[記異常<br/>整組跳過]
    P2Sum -->|是| P2Build[buildGroupAddPayload<br/>多商品合 itemView]
    P2Build --> P2Post[POST add<br/>共同採購單<br/>多商品共用 1 張]
    P2GAnom --> P2Loop
    P2Post --> P2Loop
    P2Loop -->|完| End([Summary + 異常匯出])

    classDef anom fill:#f3eadb,stroke:#8b5a1d,color:#8b5a1d
    classDef ok fill:#e4eee6,stroke:#2c6b3a,color:#2c6b3a
    classDef p1 fill:#eaf3ee,stroke:#2d6a4f,color:#1d4a37
    classDef p2 fill:#dfe9ff,stroke:#3056a8,color:#1f3a73
    class P1Search,P1Tag,P1Rules,P1Decide,P1Post p1
    class P2Search,P2Decide,P2Group,P2Loop,P2Sum,P2Build,P2Post p2
    class P1Anom,P2GAnom anom
    class End ok
```

### Phase 1 vs Phase 2 對照

| 項目 | Phase 1（廣泛）| Phase 2（SKSP 共同採購）|
|---|---|---|
| 搜尋條件 | `keywordType=ALL` `keyword=空` | `keywordType=Keyword` `keyword=SKSP` |
| 標籤排除 | `Indo`/`TW`/`YLL`/`Thai`/`SKSP*` 全跳過 | 只排除 `Indo`/`TW`/`YLL`/`Thai`（保留 SKSP） |
| 門檻 | 個別商品 `rawSum ≥ 3` | 個別商品 threshold=0；**群組合計 `≥ 3`** 才建單 |
| 採購單粒度 | 一商品一張單 | 同 `SKSP###` 代碼的多商品 → **合成一張單** |
| 異常記錄 | `insufficient-quantity` per-product | `insufficient-quantity` per-group（mainId=SKSP###）|

### 為什麼要兩階段

逐字稿「補充-共同採購.txt」：SKSP 標籤代表這些商品來自**同一個供應商**（例：SKSP121 = 同一個 1688 商家）。實務上要把同代碼的商品**合到同一張採購單**，員工才能跟廠商一次下單、一次收貨。

- 沒有兩階段的話：每個 SKSP 商品個別建單 → 同廠商 6 個商品 = 6 張單，廠商 / 員工都要重複處理 6 次
- 有兩階段：Phase 1 跳過所有 SKSP，Phase 2 統一合單 → 同廠商 1 張單

### 單品查詢（`--only`）特殊處理

分步執行透過 `--only KBT580` 鎖單一商品時，Phase 2 會**自動跳過**（單品查詢的語意不適用於批次合單）。

---

## UI 操作流程

```mermaid
flowchart LR
    Start([雙擊 start.bat]) --> Server[server.js 啟動<br/>port 3001]
    Server --> Browser[自動開 Chrome<br/>localhost:3001]
    Browser --> Tab{選 sub-tab}
    Tab -->|分步執行| Step[輸入單一 MainId<br/>+ cardinality/percent/platform]
    Tab -->|一鍵完成| OneClick[輸入搜尋條件<br/>批次處理搜尋結果]
    Step --> Preview[預覽<br/>Dry-Run]
    Preview --> StepBuild[確認規則 OK<br/>→ 建單 EXECUTE]
    OneClick --> AllPreview[預覽 Dry-Run]
    AllPreview --> AllExec[確認 → 真執行]
    StepBuild --> Logs[Log panel<br/>即時 stream]
    AllExec --> Logs
    Logs --> AnomTab[02 異常紀錄 tab<br/>5s polling]
    AnomTab --> CSV[下載 CSV]
    AnomTab --> Review[Review / 刪除單筆]
```

---

## 快速開始

### 環境需求
- Node.js ≥ v18（建議 v20+）
- Google Chrome（任一版本，已安裝）
- Windows 10/11

### 安裝

```bash
git clone https://github.com/mamiclores-cloud/Justin-ERP-purchase.git
cd Justin-ERP-purchase
npm install
```

### 設定憑證

```bash
cp secrets.example.js secrets.js
# 編輯 secrets.js 填商店代碼 / 帳號 / 密碼
```

> **共用 chrome-profile**：本專案預設 `secrets.js` 的 `profileDir` 指向 sister project `D:\Justin-ERP-distribution-print\chrome-profile`。如果你只裝這個專案，請改成本專案目錄下的相對路徑：
> ```js
> profileDir: path.join(__dirname, 'chrome-profile'),
> ```
> 然後第一次啟動會閃 Chrome 視窗讓你過 reCAPTCHA。

### 啟動

```bash
# 方法 A: 雙擊 start.bat（一鍵啟動 server + 開瀏覽器）
# 方法 B: CLI
npm start
# 開 http://localhost:3001
```

### 停止

```bash
# 雙擊 stop.bat 或關閉 server 視窗
```

---

## Web 控制台

啟動後訪問 `http://localhost:3001`，三個 tab：

### 01 智能採購建單（深綠色帶）
- **Indo 一鍵採購**：搜尋 `Indo` 標籤商品 → 套規則（threshold=6）→ 個別建單
- **1688 一鍵採購**：廣泛搜尋（threshold=3，排除 `Indo`/`TW`/`YLL`/`Thai`/`SKSP*`）+ Phase 2 SKSP 共同採購 — **一顆按鈕跑完兩階段**
- **分步執行**（管理員）：輸入單一 MainId + 平台（Indo / 1688）→ 預覽 / 建單，1688 + 鎖單會跳過 Phase 2

### 02 異常紀錄
- 紅色 badge 顯示總數
- Filter：類型（數量不足 / STOP 故沒訂購）+ 模式（dry-run / execute）+ MainId/訊息搜尋
- 5 秒 polling 即時更新（在這個 tab 時）
- **下載 CSV**（UTF-8 BOM，Excel 直開不亂碼）
- 清空全部 / 刪單筆

### 03 排程
- 每日固定時間 / 一次性指定時間
- 可勾 EXECUTE 模式

### Header
- 中間：DRY-RUN / EXECUTE 模式 badge
- 右側：session pill（點擊手動 refresh）

---

## CLI 用法

```bash
# Indo dry-run（預設 workflow=indo）
node purchase-create.js --keyword Indo --cardinality SalesCount30 --percent 150 \
                       --platform "indo-Office"

# 1688 dry-run（兩階段：廣泛 + SKSP 共同採購）
node purchase-create.js --workflow 1688 --cardinality SalesCount30 --percent 150 \
                       --platform "1688-Office"

# 真執行
node purchase-create.js ... --execute

# 鎖單測試（單一 MainId,Indo 模式）
node purchase-create.js --keyword KBT580 --keyword-type ProductCode \
                       --cardinality SalesCount30 --percent 150 \
                       --platform "indo-Office" --only KBT580 --execute

# 鎖單測試（單一 MainId,1688 模式 — Phase 2 自動跳過）
node purchase-create.js --workflow 1688 --keyword KBT348 --keyword-type ProductCode \
                       --cardinality SalesCount15 --percent 100 \
                       --platform "1688-Office" --only KBT348

# 只跑前 N 筆（測試用）
node purchase-create.js ... --max-products 5

# 加總門檻（Indo 預設 6;1688 強制 3,參數會被 workflow 蓋過）
node purchase-create.js ... --threshold 6

# Debug 顯示瀏覽器
node purchase-create.js ... --headed --debug
```

完整參數對照：

| 參數 | 預設 | 說明 |
|---|---|---|
| `--workflow` | `indo` | `indo` / `1688` — 1688 走兩階段（含 SKSP 共同採購）|
| `--keyword` | (空) | 搜尋關鍵字（1688 workflow Phase 1 會忽略，固定用 ALL）|
| `--keyword-type` | `Keyword` | `Keyword` / `ProductName` / `ProductCode` / `ALL` |
| `--cardinality` | `SalesCount15` | 需求算式：`SafetyStock` / `SalesCount7` / `15` / `30` / `60` / `90` |
| `--percent` | `100` | 倍率 % |
| `--supplier` | (空) | 供應商 GUID（可空 = 全部） |
| `--platform` | (空) | 採購平台，例如 `indo-Office` / `1688-Office` |
| `--threshold` | `6` | Indo 加總門檻；1688 workflow 強制使用 3 |
| `--only` | (空) | 只跑指定 MainId，逗號分隔（1688 + only 會跳過 Phase 2）|
| `--max-products` | `0` | 0 = 無上限 |
| `--execute` | false | 真的 POST add |
| `--debug` | false | 印完整 payload |
| `--headed` | false | 顯示瀏覽器（debug） |
| `--pause-ms` | `500` | POST 之間 delay (ms) |

---

## 異常紀錄機制

只記**員工真正需要 review** 的兩類（嚴格對應逐字稿 4-1 / 4-2）：

| 類型 | 觸發條件 | 粒度 |
|---|---|---|
| **數量不足** (`insufficient-quantity`) | 同商品所有規格（未被 STOP 蓋掉的）加總 `< 6` | per-product 一筆 |
| **STOP 故沒訂購** (`stop-spec-skipped`) | 規格有 needpurchase=true，但被 Remark `STOP : ...` 列名 | per-spec 一筆 |

**不記**的情況：
- STOP 商品中沒被 Remark 列名的規格成功建單 = 正確結果
- POST 失敗 / API error = 系統訊息（管理員看 log，不給員工看）

存儲：`state/anomalies.jsonl`（append-only JSONL，crash-safe）
- 每行一筆 JSON：`{time, runId, mode, mainId, productName, type, message, specLabel, suggestedQty, rawSum, threshold, tags, ...}`
- `dry-run` / `execute` 都會寫入；用 `mode` 欄位區分

### CSV 匯出

```
GET /api/anomalies.csv?type=<>&mode=<>&q=<>
```

欄位：時間, 模式, 貨號, 商品名稱, 異常類型, 異常訊息, 規格, 建議採購量, 規格加總, 門檻, Tags, RunId

---

## 專案結構

```
.
├── server.js                  # HTTP server + Job Manager + Schedule + Session keep-alive
├── purchase-create.js         # 主 CLI / 子程序腳本
├── _fetch-options.js          # 拉 supplier / translocation 選單給 UI 用
├── _keepalive.js              # server 定期 ping ERP dashboard 用
├── record-workflow.js         # （備用）開瀏覽器錄製操作，反推 API 時用
├── secrets.example.js         # 設定範例
├── package.json
├── start.bat / start.ps1      # 一鍵啟動
├── stop.bat / stop.ps1
│
├── public/                    # Web 前端
│   ├── index.html             # 三個 tab
│   ├── style.css              # IBM Plex + 深綠色 accent
│   └── app.js                 # tab 切換 / 表單 / log stream / 異常清單 / 排程
│
├── lib/                       # 共用 Library
│   ├── session.js             # Playwright 登入 + reCAPTCHA fallback（自 distribution-print）
│   ├── http-client.js         # Purchase / Supplier / Translocation 命名空間
│   ├── purchase-rules.js      # 純函數商業規則
│   └── recorder.js            # 操作錄製器（反推 API 用）
│
# 以下 gitignored，不會 commit：
├── secrets.js                 # 你的實際憑證
├── chrome-profile/            # （本專案預設指向 sister project 的，所以本目錄通常無此資料夾）
├── state/                     # 排程 + 異常紀錄
│   └── anomalies.jsonl
├── analysis/                  # 反推來的 ERP 前端 JS（內部資料）
└── node_modules/
```

---

## API 端點

### 業務操作

| Endpoint | Method | 用途 |
|---|---|---|
| `/api/steps` | GET | 步驟註冊表 |
| `/api/start` | POST | 啟動 job |
| `/api/job/:id?since=N` | GET | Polling log |
| `/api/stop/:id` | POST | 終止 job |
| `/api/suppliers` | GET | 供應商選單（5 分鐘 cache） |
| `/api/translocations` | GET | 集運地點選單 |

### 異常紀錄

| Endpoint | Method | 用途 |
|---|---|---|
| `/api/anomalies?type=&mode=&q=` | GET | 列表（filter 支援） |
| `/api/anomalies.csv?type=&mode=&q=` | GET | 下載 CSV |
| `/api/anomalies/:id` | DELETE | 刪單筆 |
| `/api/anomalies` | DELETE | 清空全部 |

### 排程

| Endpoint | Method | 用途 |
|---|---|---|
| `/api/schedules` | GET / POST | 列 / 新增 |
| `/api/schedules/:id` | PATCH / DELETE | 編輯 / 刪 |
| `/api/schedules/:id/run` | POST | 立即執行 |

### Session

| Endpoint | Method | 用途 |
|---|---|---|
| `/api/session-status` | GET | session pill 狀態 |
| `/api/session-refresh` | POST | 手動觸發 keepalive |

---

## 反推來源

`POST /api/PurchaseSheet/add` 的 payload `PurchaseSheetViewData` 從 `/Scripts/js/Purchase/purchase-intelligent.js:737-768` 反推：

```js
{
  PurchasePlatform: "indo-Office",   // ← 採購平台（業務唯一必填）
  PurchasePlatformNo: "",
  LogisticsCompany: "",
  LogisticsNo: "",
  ShippingLocationGUID: "",
  ShippingLocationName: "",
  ShippingLocationNo: "",
  PurchaseAllPrice: 0, Discount: 0, TotalWeight: 0,
  TransitFee: 0, PackageFee: 0, TotalPrice: 0,
  Remark: "",
  itemView: [{
    ProductGUID, ProductSpecGUID,
    QTY: "12",                       // 字串型別
    ExchangeRateGUID, ExchangeRate,
    Remark: "",
    PurchasePrice, weight,            // weight 小寫！
    sort: 1                           // 1-indexed
  }, ...]
}
```

「加入清單」「轉採購單」是純前端 state（無 API），直接 POST add 即可。`CheckPurchaseForm` 唯一驗證 = `itemView` 非空。

---

## Sister Project

[**Justin-ERP-distribution-print**](https://github.com/mamiclores-cloud/Justin-ERP-distribution-print) — 出貨端自動化（蝦皮分車 / 不分車 / PDF 列印）

兩專案共用一份 chrome-profile，**不可同時跑**（會搶 Playwright persistent context lock）。

---

## 授權

僅供阿靳 / 網翼電商經營工具 ERP 商店內部使用。**請勿用於攻擊其他 ERP 系統**。
