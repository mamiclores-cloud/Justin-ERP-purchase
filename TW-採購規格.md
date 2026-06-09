# TW 智能採購 — 規格草稿

> 狀態:**Phase A(庫存比對)+ Phase B(分配+建單)皆已實作並驗證(含單品真實建單)**。本檔為早期草稿彙整(逐字稿 `00–07` + supplier sheet 欄位 + 三廠商測試素材);**最新且權威的流程/規則以 [`README.md`](README.md) 的「TW 採購」段為準**,本檔保留決策脈絡。
>
> **Phase A 實作位置**:`tw/`(Python helper:`parsers.py` / `normalize.py` / `match.py` / `sheet_write.py` / `stock_match.py` / `config.py` / `tw_secrets.json`(gitignore))+ `server.js`(`POST /api/tw/run` multipart 上傳 + spawn)+ `public/`(員工 TW 卡 + 管理員 TW 設定)。OCR 用本地 RapidOCR(不接 LLM)。Python 借 `Justin-goods-status` 的 venv + `credentials.json`。
>
> **上傳選用 + 解析快取**:庫存每週才更新,故員工一鍵卡上傳是選用。`stock_match.py` 有快取 `state/tw-stock/parsed.json`:某廠商有上傳→解析+覆蓋該家快取;沒上傳→用上次快取(免 OCR)。全沒上傳→全用快取(無快取則報錯,須先上傳一次);**有效日期**=有新上傳取今天、全用快取取快取裡的週,讓 Phase A 的 v 與 Phase B 的採購量落在同一週欄組(`tw-purchase.js` 用 Phase A 回傳的 `date`)。
> **IN 沒對照處理(已定案)**:IN 檔是「完整在庫目錄」(1193 品全部庫存量>0、UTAMA+tnw 都要讀),沒對照=IN 有貨但我們未建對照(非每週缺漏)→ **IN 不產生沒對照清單**;IL/HS(當週到貨子集)仍列。barcode 抽取濾掉 `000000…` 重度補零垃圾碼(真實 barcode ≤2 前導 0,安全)。
> **Phase B(分配+建單)已實作 + 真實建單驗證**:`tw-purchase.js`(Node 主控:ERP `Keyword=TW` 需求 → spawn `tw/sheet_dump.py` → 以 `MainId #N` join → `lib/tw-allocate.js` 分配 → 一廠商一單 POST)+ `server.js` `/api/tw/purchase`(預覽)、`/api/tw/run-all`(一鍵)+ UI 員工一鍵卡 / 管理員預覽 / 分步執行 TW。分配規則:**BOX 分廠**(該廠商有每箱數量才訂整箱、否則散裝;箱數量欄空時從第 5 欄 `MIN N PCS` 推得)、最低量補齊後進位 6 倍數、**單價依廠商**(HS 每箱÷、IL/IN 每個)、低銷 IL8000/HS3000/IN5000、需求全訂、湊不滿改別家、**平手挑最便宜**。
> **欄位由程式建(已改)**:每次 execute,程式自己在「需求量」(紫,單一最右欄)左邊新增一組「**執行當天**」日期的欄(IL/HS/IN×有庫存/採購量 + 建單日期),同一天重跑不重建(`tw/sheet_write.py` 的 `ensure_today_group`)。Phase A 打 v、Phase B 回填採購量/建單日期/需求量,並把需求量日期同步成當天。
> **execute 完整度**:Phase B execute 會 ① 回填 sheet(`tw/sheet_writeback.py` 寫 需求量 + 各廠商採購量 + 建單日期到當天欄組)② 寫異常**三類**:`tw-no-stock`(三家沒貨)/ `tw-below-low-sales`(湊不滿低銷)/ `tw-data-gap`(已分配但缺單價→$0、或盒裝查不到每箱數量)到 `anomalies.jsonl`,02 異常 tab 已加 TW 平台 filter + 類型 label。建單單價用「每個價」(box 依廠商還原;ERP PurchasePrice 為 0 不用)。
> **驗證狀態**:離線 + live dry-run(join 351/354)+ 單元測試(分配 / 盒裝 / 單價)+ **單品真實建單**(KFD41 → TW-IL 單號 0525,數字經 ERP 核對一致)皆通過;排程已支援 TW(`--use-cache`)。**尚未做**:全批 execute(真建三家單)、Phase A 真打 v 到 sheet、前端實際點擊。
>
> 對照既有:[[project-overview]] 的 Indo / 1688 workflow。TW 與它們**架構不同**,不是複製貼上。

---

## 1. 一句話定義

TW 採購 = **每週一次**,把「三家廠商(IL / HS / IN)當週有什麼貨」對上「ERP 算出的需求量」,在**滿足各廠商低銷金額**的前提下,把每個規格的需求量**分配給有貨的廠商**,最後**依廠商各開一張採購單** POST 回 ERP。

## 2. 與 Indo / 1688 的根本差異

| 面向 | Indo / 1688 | **TW** |
|---|---|---|
| 決策單位 | per-product 獨立 | **跨廠商分配(投資組合層級)** |
| 資料來源 | 只有 ERP API | ERP **+ Google Sheet + 三廠商 Excel/PDF/圖片** |
| 倍數規則 | 商品 KeyWord 的 `NX` 標籤 | **全域固定 6 倍數** + 最低採購量補齊 |
| 建單門檻 | 規格加總 ≥ 6 / 3 | **廠商低銷金額**(IL 8000 / HS 3000 / IN 5000) |
| 單位 | 個 | **BOX 換算(箱 ↔ 個)** |
| 建單粒度 | 一商品一單 / SKSP 合單 | **一廠商一單** |
| 狀態 | 無 | HS「月至少叫一次」(待落地時處理) |

## 3. 系統概觀:兩個子系統

```
廠商每週庫存檔(IL=Excel+圖片 / HS=PDF / IN=xls)
        │  子系統 A:解析 → 比對料號 → 打 v
        ▼
  TW supplier sheet「check stock」分頁  ◀── ERP 智能採購(標籤 TW × 公式)抓需求量回填
        │  子系統 B:分配演算法(有貨廠商 + 低銷 + 6倍數 + BOX)
        ▼
  依廠商各開一張採購單  ──POST /api/PurchaseSheet/add──▶  Ajin ERP
```

- **子系統 A — 庫存比對回填**:多模態解析(含圖片 vision),較難。**客戶目前人工已有一版對照**,可後做。
- **子系統 B — 分配 + 建單**:核心採購邏輯,省最多人工,**優先做**。

---

## 4. 子系統 A — 庫存比對回填

### 4.1 來源格式(三家三樣,實測)

| 廠商 | 格式 | 結構 | 解析方式 |
|---|---|---|---|
| **IN** | `.xls`(UTAMA 表) | `CODE + barcode + 入數/箱 + 最低出貨量 + 庫存量` | 結構化,易 |
| **HS** | PDF(8 頁,**文字可抽**非掃描) | `料號 + 規格`(新到貨清單) | 抽文字 + parse |
| **IL** | Excel(到貨明細)**+ 多張 WhatsApp 商品照片** | Excel:`產品編號 + 品名`;照片:`料號 + 圖` | Excel 易;**照片需 AI vision** |

### 4.2 規則

1. **同廠商多來源檔取聯集(OR)**:IL 的 Excel ∪ 圖片;任一來源出現該料號 = 該廠商有貨。**跨廠商獨立**(IL 有貨不影響 HS/IN)。
2. **只判定有 / 無,不管數量**(即使 IN.xls 有庫存量欄也忽略)。
3. **比對 key(每家不同,實測確認)**:
   - **IL / HS**:廠商料號字串(IL=AI/AB/BA 系列;HS=A/B 系列)
   - **IN**:**barcode 數字**(sheet 的「IN product code」欄存的是 barcode,不是字母 CODE)
   - **後綴變體當同一品**:`AI001Y` → `AI001`、`AI010-1` → `AI010`(正規化/模糊比對)
   - 逐字稿明訂「用 AI 比對」:容錯 + 必要時用品名輔助
4. **輸出**:在 supplier sheet 對應的 **`{日期}` / `{廠商}` / `有庫存`** 欄打 `v`。
5. **程式自己建欄(最終定案)**:每次 execute,程式在「需求量」(紫,單一最右欄)左邊新增一組「執行當天」日期的欄(IL/HS/IN×有庫存/採購量 + 建單日期),把 v 打進當天「有庫存」(`ensure_today_group`);同一天重跑只更新當天那組、不重複新增。需求量永遠最右、日期同步成當天。

### 4.3 實測料號重疊(全量,非抽樣)

| 廠商 | sheet 料號數 | 廠商檔料號數 | 交集 | key |
|---|---|---|---|---|
| IL | 511 | 712 | 183 | 廠商料號 |
| HS | 365 | 201(新到貨子集) | 85 | 廠商料號 |
| IN | 351 | 1193 | 169 | **barcode** |

> 交集 3~5 成屬正常:廠商檔只是「這次有貨」子集,沒列到=沒貨;後綴變體正規化後交集會更高。**自動比對可行。**

---

## 5. 子系統 B — 需求量 → 分配 → 建單

### 5.1 需求量回填(逐字稿 03)

- ERP 智能採購,**標籤 `TW`** + 自訂公式(cardinality × percent)抓建議採購量 → 回填 sheet 對應規格列。
- 可重用既有 `intelligentList`(只是 Keyword 改 `TW`)。目前客戶人工複製。

### 5.2 分配演算法(逐字稿 04,**已確認**)

對 sheet 上每個有需求量的**規格**(`MainId #N`):

1. 找**當週有貨的廠商**(該規格最新日期欄打 v 的廠商)。
2. 數量**向上取整到 6 的倍數**(需求 25 → 30)。
3. **補到最低採購量**(廠商有規定則補齊)。
4. **BOX 換算**(見 5.3)。
5. **金額 = 單價 × 數量**;廠商被分到的總金額 ≥ **低銷** 才出貨:
   - **IL 8000 / HS 3000(月至少叫一次)/ IN 5000**
6. **需求量照 ERP 全訂**(決策 a):低銷只是「廠商出不出貨」門檻,過了就按需求補滿,不砍需求。
7. **分配自由度**(同一規格多家有貨時):分給「**這次最需要湊低銷**」的廠商;**差距平手時挑每個單價最便宜**(缺價排最後)。
8. **目標:剛好達低銷**就好,不為湊門檻而超訂。
9. **某廠商湊不滿低銷** → 把它有貨的規格**改分配給別家有貨的廠商**(該家自己不出貨)。
10. ❌ **無 KS**:sheet 有 KS 料號/價格欄,但採購只算 IL/HS/IN,KS 完全忽略。

### 5.3 單位 / BOX(逐字稿 05)

- 有 `BOX` 標籤的商品:廠商只能**整箱出**;sheet 標「每箱幾件」+ 最低採購量「1box」。**但 `BOX` 是商品層級**,實際成箱與否看各廠商——有填「每箱數量」才訂整箱、沒有就當散裝(6倍數+最低)。每箱數量欄空時,從第 5 欄 Price 備註 `MIN N PCS` 推得(例 IN KFD01 一箱=40)。
- 以「箱」思考分配,但**建單填「個」= 箱數 × 每箱幾件**(例:泡麵 1 箱 = 40 包 → 填 40)。
- **單價單位依廠商**:HS 在「單價」欄填每箱價 → ÷ 每箱數量還原成每個;IL/IN 填每個價。

### 5.4 建單(逐字稿 06,**已確認**)

- **一廠商一單**(這次有出貨的廠商各一張)。
- 命名:物流資訊 = `TW-{廠商}`、訂單編號 = 日期 `MMDD` → 單名 `TW-IN 0525`。
- 日期 = **跑採購當天 / 那一週**的日期。
- 該廠商這次分配到的**所有商品 × 規格**放同一張;數量填「個」(BOX 換算後)。
- 建出來的量要跟 sheet 分配結果一致。
- ⚙️ 待對 ERP:`TW-IN` / `0525` 對應 `buildAddPayload` 哪兩個欄(`PurchasePlatform` / `PurchasePlatformNo` / `LogisticsCompany` / `LogisticsNo`)。

---

## 6. 異常與範圍(已確認)

- **TW 異常記三類**(沿用既有 `anomalies.jsonl` + CSV 機制):
  - ① `tw-no-stock`:有需求量但**三家都沒貨** → 這次訂不到
  - ② `tw-below-low-sales`:規格只有「湊不滿低銷」的廠商有貨 → 沒人接得起 → 訂不到
  - ③ `tw-data-gap`:已分配建單但**該廠商缺單價(→$0)** 或 **盒裝查不到每箱數量**(後加;依「有異常就回報、不自己猜」原則)
  - 「料號在 sheet 找不到對照」歸 **子系統 A 的資料維護提示**,不混進採購異常。
- **需求量回填:自動化納入**(ERP 抓 TW 需求量 → 自動寫回 sheet)。
- **sheet:先用「副本」當測試**,正式上線再切正本。

## 7. 架構 / 分期 / 實作計畫(已確認)

**架構:Node 主導 + Python helper**
- TW 長在現有 Node 專案,多一張「TW 卡」跟 Indo/1688 並列,共用 UI / job manager / 建單 / 異常 / 排程。
- sheet 讀寫 + 廠商檔解析(Excel/PDF/xls)+ 圖片辨識 → **Python helper**,Node 用 `spawn` 呼叫(跟現有 `_fetch-options.js` 同模式,JSON 走 stdout)。
- 分配演算法 → Node 純函數(跟 `lib/purchase-rules.js` 一起,可獨立測)。
- 建單 → 沿用 Node `lib/http-client.js`。

**分期:先 A(自動比對)後 B(分配+建單)**

### Phase A — 庫存比對自動化(先做)
1. **上傳介面**:UI 上傳三廠商當週庫存檔(逐字稿 07:「由我們上傳後 AI 自動處理」)。
2. **Python helper 解析**:
   - IN `.xls`(xlrd)→ 抽 barcode
   - HS PDF(pypdf,文字可抽)→ 抽料號 token
   - IL Excel(openpyxl)→ 抽產品編號;**IL WhatsApp 圖片 → vision 抽料號**
3. **比對**:每廠商料號**聯集** → **正規化**(去 `Y` / `-N` 後綴變體)→ 對 sheet 廠商料號欄(**IN 用 barcode**)。
4. **寫回 sheet**:程式新增當天欄組(於需求量左)→ 命中的料號在當天「有庫存」欄打 `v`(`ensure_today_group`,同日不重建)。
5. 沒命中對照的料號 → 列「資料維護提示」。

### Phase B — 需求量 + 分配 + 建單(後做)
1. ERP 抓 TW 需求量 → 自動寫回 sheet(§5.1)。
2. 讀 sheet(有貨 v + 需求量 + 單價/箱/最低)→ 分配演算法(§5.2)。
3. 一廠商一單 POST ERP(§5.4)。
4. 異常記兩類(§6)。

### Phase A 開工前要敲定的技術點
- **圖片辨識用什麼**:IL 照片要 vision。用 Claude API(本專案要接 Anthropic API key + 新依賴)還是別的?
- **廠商檔上傳方式**:UI 上傳 → 存哪 → 怎麼觸發 Python helper?
- **新日期欄結構 ✅ 已驗證**:header 是**單格內換行**(`{日期}\n{廠商}\n有庫存`),全在第 1 列、資料第 2 列起。最新格式 = **每週 7 欄**:`IL有庫存 / IL採購量 / HS有庫存 / HS採購量 / IN有庫存 / IN採購量 / 需求量`。日期格 `YY/MM/DD`(如 `26/05/25`),打勾用小寫 `v`。子系統 A 新增整週欄組、只填三個「有庫存」欄。
- **Python helper 的金鑰 / venv**:用 `goods-status` 的 `credentials.json` + venv,還是本專案複製一份獨立管理?

---

## 附:supplier sheet「check stock」欄位(左側固定區)

| 欄 | 欄名 | 用途 |
|---|---|---|
| A | Product code | ERP 貨號+規格 `MainId #N`,**sheet↔ERP 對接 key** |
| B–C | KS product code / KS Price | (採購不用,忽略) |
| D | Rush, New, Add | 標記 |
| E–I | IL product code / 單價 / 一箱幾件 / 最低採購數量 / Price |
| J–N | HS product code / 單價 / 一箱幾件 / 最低採購數量 / Price |
| O–S | IN product code(=barcode) / 單價 / 一箱幾件 / 最低採購數量 / Price |
| T–U | Pics / Product Name |
| V+ | `{日期} {廠商} 有庫存` / `採購量`(每週新增) |
