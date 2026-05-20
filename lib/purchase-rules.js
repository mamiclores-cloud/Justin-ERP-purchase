// purchase-rules.js — 智能採購商業規則（純函數，不碰 Playwright/HTTP）
//
// 規則來自客戶逐字稿（drive-download-20260516T085529Z-3-001/{1-6}.txt）：
//
//   ① 商品 KeyWord 是逗號分隔的標籤（範例："Indo,2M,12X,STOP"）
//       - `NX` (N 為數字, 例 12X / 6X / 8X) → 每個有 needpurchase 的規格，採購量無條件
//         進位到 N 的倍數
//       - `STOP` → 進 product.Remark 讀 `STOP : <規格清單>`，列到的規格整個跳過
//       - 其他 tag (Indo, YLL, 2M, New0516...) 一律忽略
//
//   ② 一個商品 = 一張採購單（不跨商品合單）
//
//   ③ 加總門檻判斷必須用「原值」(needpurchaseQty)：
//        rawSum = sum(每個未被 STOP 跳過的規格的 needpurchaseQty)
//        rawSum >= 6 → 通過（再做 NX 放大）
//        rawSum  < 6 → 整張單不建，列為「數量不足」異常
//
//   ④ 通過後，個別規格才做 NX 倍數放大：
//        qty = tags.multiplier ? ceil(needpurchaseQty / N) * N : needpurchaseQty
//
//   ⑤ 對每個「needpurchase=true 但 Remark 列名 STOP」的規格，回報為「STOP 故沒訂購」異常
//      （per-spec，一個規格一筆）。商品其他規格仍會正常建單。
//      若全部 needpurchase 規格都被 STOP 蓋掉 → 整單不建（多筆 stop-spec-skipped）。

/* ============ Tag 解析 ============ */

// 解析 product.KeyWord 拿出我們關心的兩種 tag
// 回傳：{ all: [...], hasStop: bool, multiplier: number|null }
function parseTags(keyword) {
  const all = String(keyword || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let multiplier = null;
  for (const t of all) {
    const m = t.match(/^(\d+)X$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0) { multiplier = n; break; }
    }
  }

  return {
    all,
    hasStop: all.includes('STOP'),
    multiplier,
  };
}

/* ============ STOP 規格清單解析 ============ */

// 解析 product.Remark 取出 `STOP : <list>` 後面的規格 token
// 範例：
//   "STOP : #11"                    → ['#11']
//   "STOP : #1, #3"                 → ['#1', '#3']
//   "STOP : 僅7.65, 僅11 Deep Lavender" → ['僅7.65', '僅11 Deep Lavender']
// 支援冒號前後可有 0~多個空白（半形冒號或全形冒號）
function parseStopSpecs(remark) {
  if (!remark) return [];
  const text = String(remark);
  // 找 STOP : ... 直到換行或字串結尾
  const m = text.match(/STOP\s*[:：]\s*([^\r\n]+)/i);
  if (!m) return [];
  return m[1]
    .split(/[,，、]/)  // 半形逗號、全形逗號、頓號都當分隔
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ============ STOP 規格比對 ============ */

// 判斷某規格是否在 STOP 清單裡
// 比對策略（任一命中即算）：
//   1. ItemAtrNo 抽 #N 與 token 完全相等 (例 "KBT557 #2" → "#2")
//   2. SpecOne 與 token 完全相等
//   3. (SpecOne + ' ' + SpecTwo) 與 token 完全相等
//   4. token 跟 SpecOne 或 SpecFull 任一方互含（substring，雙向都試）
function matchesStopList(spec, stopTokens) {
  if (!stopTokens || stopTokens.length === 0) return false;

  const specNum = (String(spec.ItemAtrNo || '').match(/#\d+/) || [''])[0];
  const specOne = String(spec.SpecOne || '').trim();
  const specTwo = String(spec.SpecTwo || '').trim();
  const specFull = specTwo && specTwo !== '-' ? `${specOne} ${specTwo}` : specOne;

  return stopTokens.some((tok) => {
    const t = String(tok || '').trim();
    if (!t) return false;
    if (specNum && t === specNum) return true;
    if (specOne && t === specOne) return true;
    if (specFull && t === specFull) return true;
    // substring 雙向（防使用者 token 比 specOne 短或長）
    if (specOne && (t.includes(specOne) || specOne.includes(t))) return true;
    if (specFull && specFull !== specOne && (t.includes(specFull) || specFull.includes(t))) return true;
    return false;
  });
}

/* ============ SKSP 共同採購代碼 ============ */

// 從 tags.all 取出 SKSPxxx 代碼（例 'SKSP121'）；無則回傳 null
function getSkspCode(tags) {
  for (const t of tags.all) {
    if (/^SKSP\d+$/i.test(t)) return t.toUpperCase();
  }
  return null;
}

/* ============ 倍數放大 ============ */

// 無條件進位到 n 的倍數（n=null/0 → 原值）
function roundUpToMultiple(qty, n) {
  const q = Number(qty) || 0;
  const nn = Number(n) || 0;
  if (q <= 0) return 0;
  if (nn <= 0) return q;
  return Math.ceil(q / nn) * nn;
}

/* ============ 規格顯示 helper ============ */

function getSpecLabel(spec) {
  const specOne = spec.SpecOne || '';
  const specTwo = spec.SpecTwo;
  const variation = specTwo && specTwo !== '-' ? `${specOne} ${specTwo}` : specOne;
  return `${spec.ItemAtrNo || '?'}${variation ? ' — ' + variation : ''}`;
}

/* ============ 商品決策 ============ */

// 對單一商品做決策（不送 API，純資料運算）
// 回傳結構：
//   {
//     mainId, productGuid, productName,
//     tags: { all, hasStop, multiplier },
//     stopSkipped: [{ spec, label }],              // 因 STOP 跳過的規格
//     items: [{ spec, label, origQty, finalQty, sort }], // 通過、最終要 POST 的規格
//     rawSum,                                       // 未放大前的加總（用來判斷 >= 6）
//     finalSum,                                     // 放大後加總（顯示用）
//     decision: 'create' | 'skip-insufficient' | 'skip-no-needpurchase',
//     anomalies: [{ type, ... }],                   // 異常清單
//   }
function decideProduct(product, productSpc, opts = {}) {
  const threshold = opts.threshold ?? 6;
  const excludeTags = opts.excludeTags || [];   // 1688 3-1：含任一 tag 就跳過
  const tags = parseTags(product.KeyWord);

  // ① 3-1 標籤排除（最高優先序，對應 1688 不訂購原則）
  if (excludeTags.length > 0) {
    const hitTag = excludeTags.find((et) =>
      tags.all.some((t) => {
        const tl = t.toLowerCase();
        const etl = et.toLowerCase();
        if (tl === etl) return true;
        // 'sksp' 前綴：匹配 SKSP121 / SKSP02 ... 等代碼
        if (etl === 'sksp' && /^sksp\d+$/i.test(t)) return true;
        return false;
      })
    );
    if (hitTag) {
      return {
        mainId: product.MainId || '?',
        productGuid: product.ProductGUID,
        productName: product.Name || '',
        exchangeRateGuid: product.ExchangeRateGUID,
        exchangeRate: product.ExchangeRate,
        tags,
        stopSkipped: [],
        items: [],
        rawSum: 0,
        finalSum: 0,
        decision: 'skip-tag-excluded',
        anomalies: [],   // 標籤排除屬於預期行為，不進異常紀錄
      };
    }
  }

  const stopTokens = tags.hasStop ? parseStopSpecs(product.Remark) : [];
  // stopTokens 為空 + hasStop → 備註沒列出特定規格 → 整個商品停產，全規格跳過
  const stopAll = tags.hasStop && stopTokens.length === 0;

  const stopSkipped = [];   // 結構：[{ spec, label, suggestedQty }]
  const kept = [];

  // 收集 per-spec STOP 異常（在掃描規格時就加進 anomalies）
  const anomalies = [];

  for (const spec of productSpc || []) {
    if (!spec.needpurchase) continue;
    const qty = Number(spec.needpurchaseQty) || 0;
    if (qty <= 0) continue;
    if (tags.hasStop && (stopAll || matchesStopList(spec, stopTokens))) {
      const label = getSpecLabel(spec);
      stopSkipped.push({ spec, label, suggestedQty: qty });
      // ⑤ 規格建議叫貨但 Remark 標示 STOP → 「STOP 故沒訂購」異常（一規格一筆）
      anomalies.push({
        type: 'stop-spec-skipped',
        mainId: product.MainId || '?',
        specLabel: label,
        specGuid: spec.ProductSpecGUID,
        suggestedQty: qty,
        message: `${product.MainId || '?'} ${label}：建議採購 ${qty}，但 Remark 標示 STOP — 不訂購`,
      });
      continue;
    }
    kept.push({ spec, origQty: qty });
  }

  const result = {
    mainId: product.MainId || '?',
    productGuid: product.ProductGUID,
    productName: product.Name || '',
    exchangeRateGuid: product.ExchangeRateGUID,
    exchangeRate: product.ExchangeRate,
    tags,
    stopSkipped,
    items: [],
    rawSum: 0,
    finalSum: 0,
    decision: 'skip-no-needpurchase',
    anomalies,
  };

  if (kept.length === 0) {
    // 沒任何規格要採購（可能全被 STOP 蓋掉、或本來就無 needpurchase）
    // 不額外加 anomaly — 個別 stop-spec-skipped 已記
    return result;
  }

  // ③ 原值加總判斷
  result.rawSum = kept.reduce((s, k) => s + k.origQty, 0);

  if (result.rawSum < threshold) {
    result.decision = 'skip-insufficient';
    result.anomalies.push({
      type: 'insufficient-quantity',
      mainId: result.mainId,
      rawSum: result.rawSum,
      threshold,
      message: `${result.mainId}：規格加總 ${result.rawSum} < ${threshold}，數量不足不建單`,
      specs: kept.map((k) => ({ label: getSpecLabel(k.spec), qty: k.origQty })),
    });
    return result;
  }

  // ④ 通過 → 對個別規格做 NX 放大
  result.decision = 'create';
  result.items = kept.map((k, i) => ({
    spec: k.spec,
    label: getSpecLabel(k.spec),
    origQty: k.origQty,
    finalQty: roundUpToMultiple(k.origQty, tags.multiplier),
    sort: i + 1,
  }));
  result.finalSum = result.items.reduce((s, it) => s + it.finalQty, 0);

  // 注意：STOP 商品只要剩下的規格通過門檻就正常建單，不算異常（已 review by design）
  return result;
}

/* ============ 組 PurchaseSheetViewData ============ */

// 把 decideProduct 通過的結果組成 POST /api/PurchaseSheet/add 的 payload
// 對應 analysis/purchase-intelligent.js:737-768
function buildAddPayload(decision, opts = {}) {
  if (decision.decision !== 'create') {
    throw new Error(`buildAddPayload: decision ${decision.decision} != 'create' for ${decision.mainId}`);
  }

  return {
    PurchasePlatform: opts.platform || '',
    PurchasePlatformNo: opts.platformNo || '',
    LogisticsCompany: opts.logisticsCompany || '',
    LogisticsNo: opts.logisticsNo || '',
    ShippingLocationGUID: opts.shippingLocationGuid || '',
    ShippingLocationName: opts.shippingLocationName || '',
    ShippingLocationNo: opts.shippingLocationNo || '',
    PurchaseAllPrice: opts.purchaseAllPrice ?? 0,
    Discount: opts.discount ?? 0,
    TotalWeight: opts.totalWeight ?? 0,
    TransitFee: opts.transitFee ?? 0,
    PackageFee: opts.packageFee ?? 0,
    TotalPrice: opts.totalPrice ?? 0,
    Remark: opts.remark || '',
    itemView: decision.items.map((it) => ({
      ProductGUID: decision.productGuid,
      ProductSpecGUID: it.spec.ProductSpecGUID,
      QTY: String(it.finalQty),
      ExchangeRateGUID: decision.exchangeRateGuid || '',
      ExchangeRate: String(decision.exchangeRate ?? ''),
      Remark: '',
      PurchasePrice: String(it.spec.PurchasePrice ?? 0),
      weight: String(it.spec.Weight ?? 0),
      sort: it.sort,
    })),
  };
}

/* ============ SKSP 共同採購：多商品合成一張採購單 payload ============ */

// decisions：同一 SKSP 代碼的多筆 create 決策
// 把所有 items 合成同一 itemView，一次 POST 建一張單
function buildGroupAddPayload(decisions, opts = {}) {
  if (!decisions || decisions.length === 0) {
    throw new Error('buildGroupAddPayload: decisions 陣列為空');
  }
  let sortIndex = 1;
  const itemView = [];
  for (const d of decisions) {
    for (const it of d.items) {
      itemView.push({
        ProductGUID: d.productGuid,
        ProductSpecGUID: it.spec.ProductSpecGUID,
        QTY: String(it.finalQty),
        ExchangeRateGUID: d.exchangeRateGuid || '',
        ExchangeRate: String(d.exchangeRate ?? ''),
        Remark: '',
        PurchasePrice: String(it.spec.PurchasePrice ?? 0),
        weight: String(it.spec.Weight ?? 0),
        sort: sortIndex++,
      });
    }
  }
  return {
    PurchasePlatform: opts.platform || '',
    PurchasePlatformNo: '',
    LogisticsCompany: '',
    LogisticsNo: '',
    ShippingLocationGUID: '',
    ShippingLocationName: '',
    ShippingLocationNo: '',
    PurchaseAllPrice: 0,
    Discount: 0,
    TotalWeight: 0,
    TransitFee: 0,
    PackageFee: 0,
    TotalPrice: 0,
    Remark: '',
    itemView,
  };
}

/* ============ Cardinality 對照表（給 CLI 提示 / UI dropdown） ============ */

const CARDINALITY_OPTIONS = [
  { value: 'SafetyStock',   label: '安全庫存' },
  { value: 'SalesCount7',   label: '7日銷量' },
  { value: 'SalesCount15',  label: '15日銷量' },
  { value: 'SalesCount30',  label: '30日銷量' },
  { value: 'SalesCount60',  label: '60日銷量' },
  { value: 'SalesCount90',  label: '90日銷量' },
];

module.exports = {
  parseTags,
  parseStopSpecs,
  matchesStopList,
  roundUpToMultiple,
  getSpecLabel,
  getSkspCode,
  decideProduct,
  buildAddPayload,
  buildGroupAddPayload,
  CARDINALITY_OPTIONS,
};
