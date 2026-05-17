// purchase-create.js — 智能採購批次建單 CLI
//
// 流程（對應客戶逐字稿 1~6.txt）：
//   1. GET ProductSpecList(KeywordType, Keyword, cardinality, percent, supplier)
//      → 拿候選商品清單，每商品含 needpurchase / needpurchaseQty / KeyWord / Remark
//   2. 對每商品跑 lib/purchase-rules.decideProduct() 計算決策：
//      - STOP 規格從 Remark 拿來跳過
//      - 加總 needpurchaseQty (原值) >= 6 才建單；< 6 → 數量不足異常
//      - NX 倍數規則只在通過後對個別規格放大
//   3. dry-run → 印計畫；execute → 對每張 create-decision POST /api/PurchaseSheet/add
//   4. 結尾印異常清單 + 統計
//
// 用法：
//   node purchase-create.js --keyword Indo --cardinality SalesCount15 --percent 150 \
//                          --platform "indo-Office"                         # dry-run
//   node purchase-create.js ... --execute                                   # 真執行
//   node purchase-create.js ... --only KBT580,KBT89                         # 只跑指定商品
//   node purchase-create.js ... --keyword-type ProductCode                  # 主貨號搜尋
//   node purchase-create.js ... --threshold 6                               # 加總門檻
//   node purchase-create.js ... --max-products 5                            # 最多處理 N 筆（測試用）
//   node purchase-create.js ... --headed                                    # debug 顯示瀏覽器

const fs = require('fs');
const path = require('path');
const { launchWithSession } = require('./lib/session');
const { createClient } = require('./lib/http-client');
const {
  decideProduct,
  buildAddPayload,
  CARDINALITY_OPTIONS,
  getSpecLabel,
} = require('./lib/purchase-rules');

function ts() { return new Date().toISOString().slice(11, 19); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ============ 異常紀錄 append-only log ============
   被前端 02 異常紀錄 tab 讀。每筆 anomaly 一行 JSON，crash-safe。
   server.js spawn 時會塞 PURCHASE_RUN_ID env；CLI 自己跑會 fallback 用時間戳。

   ★ 只記錄員工真正需要 review 的兩類（對應逐字稿 4-1 / 4-2）：
       - insufficient-quantity  → 數量不足（per-product，加總 < 6）
       - stop-spec-skipped      → STOP 故沒訂購（per-spec，建議叫貨但 Remark 列為 STOP）
     其他類型（POST 失敗 / API 錯誤）屬於系統訊息，不寫入給員工看的歷史檔。
     注意：STOP 商品中沒被 Remark 列名的規格成功建單 = 正確結果，不算異常。

   dry-run / execute 都會寫入（dry-run 方便員工測試規則是否正確），mode 欄位區分。
*/
const ANOMALY_LOG = path.join(__dirname, 'state', 'anomalies.jsonl');
const RUN_ID = process.env.PURCHASE_RUN_ID || ('cli-' + Date.now().toString(36));
const RECORDED_TYPES = new Set(['insufficient-quantity', 'stop-spec-skipped']);

function appendAnomalies(decision, mode, opts) {
  if (!decision.anomalies || decision.anomalies.length === 0) return;
  const filtered = decision.anomalies.filter((a) => RECORDED_TYPES.has(a.type));
  if (filtered.length === 0) return;

  const dir = path.dirname(ANOMALY_LOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const lines = filtered.map((a) => JSON.stringify({
    time: now,
    runId: RUN_ID,
    mode,                                       // 'execute' or 'dry-run'
    // 執行條件 — 同商品在不同 cardinality / percent 下算出的需求量不同,
    // 員工檢視 CSV 要靠這兩欄區分「這是哪個條件跑出來的異常」
    cardinality: opts?.cardinality,
    percent: opts?.percent,
    mainId: decision.mainId,
    productName: decision.productName || '',
    type: a.type,
    message: a.message,
    // insufficient-quantity 用
    rawSum: a.rawSum,
    threshold: a.threshold,
    specs: a.specs,
    // stop-spec-skipped 用
    specLabel: a.specLabel,
    specGuid: a.specGuid,
    suggestedQty: a.suggestedQty,
    tags: decision.tags?.all,
  }));
  fs.appendFileSync(ANOMALY_LOG, lines.join('\n') + '\n');
}

function parseArgs() {
  const args = process.argv.slice(2);
  function get(name, def = null) {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
  }
  return {
    execute:     args.includes('--execute'),
    headed:      args.includes('--headed'),
    debug:       args.includes('--debug'),

    // 搜尋條件
    keyword:     get('--keyword', ''),
    keywordType: get('--keyword-type', 'Keyword'),       // Keyword | ProductName | ProductCode
    supplier:    get('--supplier', ''),                   // SupplierGUID（可空）
    cardinality: get('--cardinality', 'SalesCount15'),    // 對應需求算式
    percent:     parseInt(get('--percent', '100'), 10) || 100,

    // 採購單參數
    platform:    get('--platform', ''),                   // 採購平台，例 "indo-Office"

    // 行為控制
    only:        get('--only'),                           // 逗號分隔 MainId 清單
    threshold:   parseInt(get('--threshold', '6'), 10) || 6,
    maxProducts: parseInt(get('--max-products', '0'), 10) || 0,  // 0 = 無上限
    pauseMs:     parseInt(get('--pause-ms', '500'), 10) || 0,    // POST 之間的 delay
  };
}

function printHeader(opts) {
  const card = CARDINALITY_OPTIONS.find((c) => c.value === opts.cardinality);
  log(`=================================================`);
  log(`  智能採購批次建單 — ${opts.execute ? 'EXECUTE' : 'DRY-RUN'}`);
  log(`=================================================`);
  log(`  搜尋條件:`);
  log(`    keywordType: ${opts.keywordType}`);
  log(`    keyword:     ${opts.keyword || '(空)'}`);
  log(`    supplier:    ${opts.supplier || '(空 = 全部)'}`);
  log(`    cardinality: ${opts.cardinality}${card ? ' (' + card.label + ')' : ''}`);
  log(`    percent:     ${opts.percent}%`);
  log(`  採購單:`);
  log(`    platform:    ${opts.platform || '(空)'}`);
  log(`    threshold:   加總 >= ${opts.threshold} 才建單`);
  if (opts.only)        log(`    only:        ${opts.only}`);
  if (opts.maxProducts) log(`    maxProducts: ${opts.maxProducts}`);
  log('');
}

function formatDecision(d) {
  const lines = [];
  const decisionLabel = {
    'create': '[CREATE]',
    'skip-insufficient': '[SKIP-INSUFFICIENT]',
    'skip-no-needpurchase': '[SKIP-NO-NEED]',
  }[d.decision] || '[UNKNOWN]';

  lines.push(`${decisionLabel}  ${d.mainId}  ${d.productName ? '— ' + d.productName.slice(0, 50) : ''}`);
  lines.push(`    tags: [${d.tags.all.join(', ') || '-'}]` +
             (d.tags.multiplier ? `  multiplier: ${d.tags.multiplier}X` : '') +
             (d.tags.hasStop ? '  STOP' : ''));

  if (d.stopSkipped.length > 0) {
    lines.push(`    STOP-skipped (${d.stopSkipped.length}): ${d.stopSkipped.map((x) => x.label).join(', ')}`);
  }

  if (d.decision === 'create') {
    lines.push(`    items (${d.items.length}):`);
    d.items.forEach((it) => {
      const note = (it.finalQty !== it.origQty) ? ` (${it.origQty} → ${it.finalQty})` : '';
      lines.push(`      • ${it.label}  qty=${it.finalQty}${note}`);
    });
    lines.push(`    rawSum=${d.rawSum}  finalSum=${d.finalSum}`);
  } else if (d.decision === 'skip-insufficient') {
    const t = d.anomalies[0]?.threshold ?? 6;
    lines.push(`    rawSum=${d.rawSum}  threshold=${t}  ← 數量不足`);
    d.anomalies[0]?.specs?.forEach((s) => {
      lines.push(`      • ${s.label}  origQty=${s.qty}`);
    });
  }
  return lines.join('\n');
}

(async () => {
  const opts = parseArgs();
  printHeader(opts);

  if (opts.execute && !opts.platform) {
    log('!!! --execute 模式必須提供 --platform（採購平台，例 "indo-Office"）');
    process.exit(1);
  }

  const onlySet = opts.only ? new Set(opts.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;

  const { context } = await launchWithSession({ headless: !opts.headed });
  const api = createClient(context);

  /* ============ Step 1: GetIntelligentList ============ */
  log(`=== Step 1: GET /api/ProductOverview/ProductSpecList ===`);
  const res = await api.Purchase.intelligentList({
    length: 999,
    KeywordType: opts.keywordType,
    Keyword: opts.keyword,
    supplier: opts.supplier,
    cardinality: opts.cardinality,
    percent: opts.percent,
  });

  const products = res.list || [];
  const total = res.recordsTotal ?? res.recordsFiltered ?? products.length;
  log(`  fetched ${products.length} products  (recordsTotal=${total})`);

  if (products.length === 0) {
    log('  沒有候選商品 — 結束');
    await context.close();
    return;
  }

  /* ============ Step 2: Decide per product ============ */
  log(`\n=== Step 2: 規則決策 ===\n`);

  const decisions = [];
  let scanned = 0;
  for (const p of products) {
    const mainId = p.product?.MainId;
    if (onlySet && !onlySet.has(mainId)) continue;
    if (opts.maxProducts > 0 && scanned >= opts.maxProducts) break;
    scanned++;

    const d = decideProduct(p.product, p.productSpc, { threshold: opts.threshold });
    decisions.push(d);
    console.log(formatDecision(d));
    console.log('');

    // 即時 append 異常到檔（dry-run 也寫，方便測試規則是否正確；mode 欄位區分）
    try { appendAnomalies(d, opts.execute ? 'execute' : 'dry-run', opts); }
    catch (e) { log(`  (warn) anomaly log append failed: ${e.message}`); }
  }

  /* ============ Step 3: POST add (or dry-run) ============ */
  const toCreate = decisions.filter((d) => d.decision === 'create');
  log(`\n=== Step 3: ${opts.execute ? 'POST PurchaseSheet/add' : 'DRY-RUN'} (${toCreate.length} 張單) ===\n`);

  const results = [];
  for (let i = 0; i < toCreate.length; i++) {
    const d = toCreate[i];
    const payload = buildAddPayload(d, { platform: opts.platform });

    if (!opts.execute) {
      log(`  [DRY-RUN ${i + 1}/${toCreate.length}] ${d.mainId}  (itemView ${payload.itemView.length} 規格, platform="${payload.PurchasePlatform}")`);
      if (opts.debug) {
        console.log('    payload:', JSON.stringify(payload, null, 2));
      }
      results.push({ mainId: d.mainId, status: 'dry-run' });
      continue;
    }

    log(`  [${i + 1}/${toCreate.length}] POST add — ${d.mainId}  (規格 ${payload.itemView.length}, platform="${payload.PurchasePlatform}")`);
    try {
      const resAdd = await api.Purchase.add(payload);
      const ok = resAdd?.Status === 'Success';
      if (ok) {
        const guid = resAdd.PurchaseSheetGUID || resAdd.GUID || resAdd.guid || '(no guid)';
        log(`    ✓ Success  PurchaseSheetGUID=${guid}`);
        results.push({ mainId: d.mainId, status: 'ok', guid, response: resAdd });
      } else {
        log(`    !!! Status=${resAdd?.Status}  ErrorMessage=${(resAdd?.ErrorMessage || '').slice(0, 200)}`);
        results.push({ mainId: d.mainId, status: 'fail', response: resAdd });
        // 系統層的 POST 失敗 — 不寫員工異常紀錄（屬於系統訊息，只在 log 印出）
      }
    } catch (e) {
      log(`    !!! API error: ${e.message.slice(0, 200)}`);
      results.push({ mainId: d.mainId, status: 'error', error: e.message });
      // 系統層的 API error — 不寫員工異常紀錄
    }
    if (opts.pauseMs > 0 && i < toCreate.length - 1) await sleep(opts.pauseMs);
  }

  /* ============ Step 4: Summary + 異常清單 ============ */
  log(`\n=== Summary ===`);

  const byDecision = {
    'create':                decisions.filter((d) => d.decision === 'create').length,
    'skip-insufficient':     decisions.filter((d) => d.decision === 'skip-insufficient').length,
    'skip-no-needpurchase':  decisions.filter((d) => d.decision === 'skip-no-needpurchase').length,
  };
  log(`  Scanned products:     ${scanned}`);
  log(`  CREATE decisions:     ${byDecision['create']}`);
  log(`  SKIP (數量不足):       ${byDecision['skip-insufficient']}`);
  log(`  SKIP (無建議量):       ${byDecision['skip-no-needpurchase']}`);

  if (opts.execute) {
    const ok = results.filter((r) => r.status === 'ok').length;
    const fail = results.filter((r) => r.status === 'fail' || r.status === 'error').length;
    log(`  POST 成功:            ${ok}`);
    log(`  POST 失敗:            ${fail}`);
  }

  /* ============ 異常清單 ============ */
  const anomalies = decisions.flatMap((d) => d.anomalies);
  if (anomalies.length > 0) {
    log(`\n=== 異常回報 (${anomalies.length}) ===`);
    const byType = anomalies.reduce((a, x) => { (a[x.type] = a[x.type] || []).push(x); return a; }, {});
    if (byType['insufficient-quantity']) {
      log(`\n  ⚠ 數量不足 (${byType['insufficient-quantity'].length})`);
      byType['insufficient-quantity'].forEach((a) => log(`     - ${a.message}`));
    }
    if (byType['stop-spec-skipped']) {
      log(`\n  ⚠ STOP 故沒訂購（規格） (${byType['stop-spec-skipped'].length})`);
      byType['stop-spec-skipped'].forEach((a) => log(`     - ${a.message}`));
    }
  } else {
    log(`\n  (無異常)`);
  }

  if (opts.execute) {
    const failed = results.filter((r) => r.status === 'fail' || r.status === 'error');
    if (failed.length > 0) {
      log(`\n=== POST 失敗詳情 ===`);
      failed.forEach((f) => {
        log(`  ${f.mainId}  status=${f.status}`);
        if (f.error) log(`    error: ${f.error}`);
        if (f.response?.ErrorMessage) log(`    server: ${f.response.ErrorMessage}`);
      });
    }
  }

  await context.close();
  log(`\ndone`);
})().catch((e) => {
  console.error('[FATAL]', e.message);
  console.error(e.stack);
  process.exit(1);
});
