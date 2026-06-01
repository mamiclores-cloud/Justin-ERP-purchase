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
  buildGroupAddPayload,
  CARDINALITY_OPTIONS,
  getSpecLabel,
  getSkspCode,
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

    // 工作流程
    workflow:    get('--workflow', 'indo'),               // 'indo' | '1688'

    // 搜尋條件
    keyword:     get('--keyword', ''),
    keywordType: get('--keyword-type', 'Keyword'),        // Keyword | ProductName | ProductCode | ALL
    supplier:    get('--supplier', ''),                   // SupplierGUID（可空）
    cardinality: get('--cardinality', 'SalesCount15'),    // 對應需求算式
    percent:     parseInt(get('--percent', '100'), 10) || 100,

    // 採購單參數
    platform:    get('--platform', ''),                   // 採購平台，例 "indo-Office" / "1688-Office"

    // 行為控制
    only:        get('--only'),                           // 逗號分隔 MainId 清單
    threshold:   parseInt(get('--threshold', '6'), 10) || 6,
    maxProducts: parseInt(get('--max-products', '0'), 10) || 0,  // 0 = 無上限
    pauseMs:     parseInt(get('--pause-ms', '500'), 10) || 0,    // POST 之間的 delay
  };
}

function printHeader(opts) {
  const card = CARDINALITY_OPTIONS.find((c) => c.value === opts.cardinality);
  const effectiveThreshold = opts.workflow === '1688' ? 3 : opts.threshold;
  log(`=================================================`);
  log(`  智能採購批次建單 — ${opts.execute ? 'EXECUTE' : 'DRY-RUN'}`);
  log(`  workflow:    ${opts.workflow || 'indo'}`);
  log(`=================================================`);
  log(`  搜尋條件:`);
  log(`    keywordType: ${opts.keywordType}`);
  log(`    keyword:     ${opts.keyword || '(空)'}`);
  log(`    supplier:    ${opts.supplier || '(空 = 全部)'}`);
  log(`    cardinality: ${opts.cardinality}${card ? ' (' + card.label + ')' : ''}`);
  log(`    percent:     ${opts.percent}%`);
  log(`  採購單:`);
  log(`    platform:    ${opts.platform || '(空)'}`);
  log(`    threshold:   加總 >= ${effectiveThreshold} 才建單`);
  if (opts.only)        log(`    only:        ${opts.only}`);
  if (opts.maxProducts) log(`    maxProducts: ${opts.maxProducts}`);
  log('');
}

function formatDecision(d) {
  const lines = [];
  const decisionLabel = {
    'create':                '[CREATE]',
    'skip-insufficient':     '[SKIP-INSUFFICIENT]',
    'skip-no-needpurchase':  '[SKIP-NO-NEED]',
    'skip-tag-excluded':     '[SKIP-TAG]',
  }[d.decision] || '[UNKNOWN]';

  lines.push(`${decisionLabel}  ${d.mainId}  ${d.productName ? '— ' + d.productName.slice(0, 50) : ''}` +
             (d.excludeReason ? `  (${d.excludeReason})` : ''));
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

/* ============ 共用：搜尋 + 決策 + POST 單商品單（Indo / 1688 phase1 用）============ */

async function fetchAndDecide(api, fetchParams, decideOpts, opts) {
  log(`  正在向 ERP 查詢智能採購清單 (KeywordType=${fetchParams.keywordType || 'Keyword'}, cardinality=${opts.cardinality} × ${opts.percent}%) ...`);
  log(`  (重型查詢可能需要 30-180 秒,請耐心等候,進度每 15 秒回報一次)`);
  const queryStart = Date.now();
  // 每 15 秒回報「還在等」避免使用者以為卡死
  const heartbeat = setInterval(() => {
    const elapsed = ((Date.now() - queryStart) / 1000).toFixed(0);
    log(`  ... 仍在等 ERP 回應 (已等 ${elapsed} 秒)`);
  }, 15000);
  let res;
  try {
    res = await api.Purchase.intelligentList({
      length: 999,
      KeywordType: fetchParams.keywordType || 'Keyword',
      Keyword: fetchParams.keyword || '',
      supplier: opts.supplier || '',
      cardinality: opts.cardinality,
      percent: opts.percent,
    });
  } finally {
    clearInterval(heartbeat);
  }
  const elapsed = ((Date.now() - queryStart) / 1000).toFixed(1);
  const products = res.list || [];
  const total = res.recordsTotal ?? res.recordsFiltered ?? products.length;
  log(`  fetched ${products.length} products  (recordsTotal=${total}, 耗時 ${elapsed}s)`);

  const onlySet = opts.only ? new Set(opts.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const decisions = [];
  let scanned = 0;
  for (const p of products) {
    const mainId = p.product?.MainId;
    if (onlySet && !onlySet.has(mainId)) continue;
    if (opts.maxProducts > 0 && scanned >= opts.maxProducts) break;
    scanned++;
    const d = decideProduct(p.product, p.productSpc, decideOpts);
    decisions.push(d);
    console.log(formatDecision(d));
    console.log('');
    try { appendAnomalies(d, opts.execute ? 'execute' : 'dry-run', opts); }
    catch (e) { log(`  (warn) anomaly log append failed: ${e.message}`); }
  }
  log(`  scanned=${scanned}`);
  return decisions;
}

async function postDecisions(toCreate, opts, api, labelPrefix) {
  const results = [];
  for (let i = 0; i < toCreate.length; i++) {
    const d = toCreate[i];
    const payload = buildAddPayload(d, { platform: opts.platform });
    if (!opts.execute) {
      log(`  [DRY-RUN ${labelPrefix}${i + 1}/${toCreate.length}] ${d.mainId}  (規格 ${payload.itemView.length})`);
      if (opts.debug) console.log('    payload:', JSON.stringify(payload, null, 2));
      results.push({ mainId: d.mainId, status: 'dry-run' });
      continue;
    }
    log(`  [${labelPrefix}${i + 1}/${toCreate.length}] POST — ${d.mainId}  (規格 ${payload.itemView.length})`);
    try {
      const resAdd = await api.Purchase.add(payload);
      const ok = resAdd?.Status === 'Success';
      if (ok) {
        const guid = resAdd.PurchaseSheetGUID || resAdd.GUID || resAdd.guid || '(no guid)';
        log(`    ✓ Success  GUID=${guid}`);
        results.push({ mainId: d.mainId, status: 'ok', guid });
      } else {
        log(`    !!! Status=${resAdd?.Status}  Err=${(resAdd?.ErrorMessage || '').slice(0, 200)}`);
        results.push({ mainId: d.mainId, status: 'fail', response: resAdd });
      }
    } catch (e) {
      log(`    !!! API error: ${e.message.slice(0, 200)}`);
      results.push({ mainId: d.mainId, status: 'error', error: e.message });
    }
    if (opts.pauseMs > 0 && i < toCreate.length - 1) await sleep(opts.pauseMs);
  }
  return results;
}

function printSummary(decisions, results, opts) {
  const byDecision = {
    'create':             decisions.filter((d) => d.decision === 'create').length,
    'skip-insufficient':  decisions.filter((d) => d.decision === 'skip-insufficient').length,
    'skip-no-needpurchase': decisions.filter((d) => d.decision === 'skip-no-needpurchase').length,
    'skip-tag-excluded':  decisions.filter((d) => d.decision === 'skip-tag-excluded').length,
  };
  log(`  CREATE decisions:     ${byDecision['create']}`);
  log(`  SKIP (數量不足):       ${byDecision['skip-insufficient']}`);
  log(`  SKIP (無建議量):       ${byDecision['skip-no-needpurchase']}`);
  if (byDecision['skip-tag-excluded']) log(`  SKIP (標籤排除):       ${byDecision['skip-tag-excluded']}`);

  if (opts.execute && results) {
    log(`  POST 成功:            ${results.filter((r) => r.status === 'ok').length}`);
    log(`  POST 失敗:            ${results.filter((r) => r.status === 'fail' || r.status === 'error').length}`);
  }

  const anomalies = decisions.flatMap((d) => d.anomalies).filter((a) => a.type !== 'tag-excluded');
  if (anomalies.length > 0) {
    log(`\n=== 異常回報 (${anomalies.length}) ===`);
    const byType = anomalies.reduce((acc, x) => { (acc[x.type] = acc[x.type] || []).push(x); return acc; }, {});
    if (byType['insufficient-quantity']) {
      log(`\n  ⚠ 數量不足 (${byType['insufficient-quantity'].length})`);
      byType['insufficient-quantity'].forEach((a) => log(`     - ${a.message}`));
    }
    if (byType['stop-spec-skipped']) {
      log(`\n  ⚠ STOP 故沒訂購 (${byType['stop-spec-skipped'].length})`);
      byType['stop-spec-skipped'].forEach((a) => log(`     - ${a.message}`));
    }
  } else {
    log(`\n  (無異常)`);
  }

  if (opts.execute && results) {
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
}

/* ============ Indo 工作流程（原邏輯不變） ============ */

async function runIndo(opts, api) {
  log(`=== [Indo] Step 1: GET ProductSpecList ===`);
  const decisions = await fetchAndDecide(
    api,
    { keywordType: opts.keywordType, keyword: opts.keyword },
    { threshold: opts.threshold },
    opts,
  );
  if (decisions.length === 0) { log('  沒有候選商品'); return; }

  const toCreate = decisions.filter((d) => d.decision === 'create');
  log(`\n=== [Indo] Step 2: ${opts.execute ? 'POST' : 'DRY-RUN'} (${toCreate.length} 張單) ===\n`);
  const results = await postDecisions(toCreate, opts, api, '');
  log(`\n=== Summary ===`);
  printSummary(decisions, results, opts);
}

/* ============ 1688 工作流程：兩階段 ============ */

// Phase 1 不訂購標籤清單（SKSP 也跳過，留給 phase 2 共同採購）
const EXCLUDE_1688 = ['Indo', 'TW', 'YLL', 'Thai', 'SKSP'];
// Phase 2 只搜 SKSP，SKSP 自身不排除
const EXCLUDE_SKSP = ['Indo', 'TW', 'YLL', 'Thai'];
const THRESHOLD_1688 = 3;

async function run1688(opts, api) {
  const mode = opts.execute ? 'EXECUTE' : 'DRY-RUN';
  const allDecisions = [];
  let totalResults = [];

  /* ── Phase 1：廣泛搜尋（一般 1688 商品） ── */
  log(`\n${'='.repeat(60)}`);
  log(`=== [1688 Phase 1] 廣泛搜尋一般商品 (threshold ≥ ${THRESHOLD_1688}) ===`);
  log(`${'='.repeat(60)}\n`);

  const p1decisions = await fetchAndDecide(
    api,
    { keywordType: 'ALL', keyword: '' },
    { threshold: THRESHOLD_1688, excludeTags: EXCLUDE_1688 },
    opts,
  );
  allDecisions.push(...p1decisions);

  const p1create = p1decisions.filter((d) => d.decision === 'create');
  log(`\n=== [1688 Phase 1] ${mode} 個別商品採購單 (${p1create.length} 張) ===\n`);
  const p1results = await postDecisions(p1create, opts, api, 'P1-');
  totalResults.push(...p1results);

  /* ── Phase 2：SKSP 共同採購 ──
     --only 模式特別處理:
       - 若 --only 商品有 SKSP 標籤 → Phase 2 跑,但只跑相關群組(管理員測合單預覽用)
       - 若 --only 商品無 SKSP → 整個 Phase 2 跳過(單品查詢不適用合單)
  */
  let onlySkspCodes = null;
  if (opts.only) {
    onlySkspCodes = new Set();
    for (const d of p1decisions) {
      if (d.decision === 'skip-tag-excluded') {
        const sksp = getSkspCode(d.tags);
        if (sksp) onlySkspCodes.add(sksp);
      }
    }
    if (onlySkspCodes.size === 0) {
      log(`\n[1688] --only 已設定且無 SKSP 商品,跳過 Phase 2 SKSP 合單`);
      log(`\n${'='.repeat(60)}`);
      log(`=== [1688] 總結 ===`);
      log(`${'='.repeat(60)}`);
      printSummary(allDecisions, totalResults, opts);
      return;
    }
    log(`\n[1688] --only 偵測到 SKSP 商品,Phase 2 只跑相關群組: ${[...onlySkspCodes].join(', ')}`);
  }

  log(`\n${'='.repeat(60)}`);
  log(`=== [1688 Phase 2] SKSP 共同採購 (threshold ≥ ${THRESHOLD_1688}) ===`);
  log(`${'='.repeat(60)}\n`);

  log(`  正在向 ERP 查詢 SKSP 商品清單 ...`);
  const skspStart = Date.now();
  const skspHeartbeat = setInterval(() => {
    const elapsed = ((Date.now() - skspStart) / 1000).toFixed(0);
    log(`  ... 仍在等 ERP 回應 (已等 ${elapsed} 秒)`);
  }, 15000);
  let skspRes;
  try {
    skspRes = await api.Purchase.intelligentList({
      length: 999,
      KeywordType: 'Keyword',
      Keyword: 'SKSP',
      supplier: opts.supplier || '',
      cardinality: opts.cardinality,
      percent: opts.percent,
    });
  } finally {
    clearInterval(skspHeartbeat);
  }
  const skspElapsed = ((Date.now() - skspStart) / 1000).toFixed(1);
  const skspProducts = skspRes.list || [];
  log(`  fetched ${skspProducts.length} SKSP products  (耗時 ${skspElapsed}s)`);

  // 對每個 SKSP 商品決策（threshold=0，門檻判斷在合單層）
  const skspDecisions = [];
  for (const p of skspProducts) {
    const d = decideProduct(p.product, p.productSpc, {
      threshold: 0,
      excludeTags: EXCLUDE_SKSP,
    });
    skspDecisions.push(d);
    // --only 模式:只印 / 只計相關 SKSP 群組的商品(避免雜訊)
    const skspCode = getSkspCode(d.tags);
    const relevant = !onlySkspCodes || (skspCode && onlySkspCodes.has(skspCode));
    if (relevant && (d.decision === 'create' || d.decision === 'skip-no-needpurchase')) {
      console.log(formatDecision(d));
      console.log('');
    }
    if (relevant) {
      try { appendAnomalies(d, opts.execute ? 'execute' : 'dry-run', opts); }
      catch (e) { log(`  (warn) anomaly log append failed: ${e.message}`); }
      allDecisions.push(d);
    }
  }

  // 依 SKSP 代碼分組（只取 create 決策）
  const skspGroups = {};
  for (const d of skspDecisions) {
    if (d.decision !== 'create') continue;
    const code = getSkspCode(d.tags);
    if (!code) continue;  // 無 SKSPxxx 代碼就跳過（不合單）
    // --only 模式:只保留相關群組
    if (onlySkspCodes && !onlySkspCodes.has(code)) continue;
    if (!skspGroups[code]) skspGroups[code] = [];
    skspGroups[code].push(d);
  }

  const groupCodes = Object.keys(skspGroups);
  log(`\n  SKSP 分組數量：${groupCodes.length} 組${onlySkspCodes ? ` (--only 過濾後)` : ''}`);

  // 對每組做合單門檻判斷 + POST
  let groupIdx = 0;
  for (const code of groupCodes) {
    groupIdx++;
    const groupDecisions = skspGroups[code];
    const groupRawSum = groupDecisions.reduce((s, d) => s + d.rawSum, 0);
    const groupMainIds = groupDecisions.map((d) => d.mainId).join(', ');
    const groupSpecCount = groupDecisions.reduce((s, d) => s + d.items.length, 0);

    log(`\n  [群組 ${groupIdx}/${groupCodes.length}] ${code}  商品: ${groupMainIds}`);
    log(`    合計 rawSum=${groupRawSum}  規格數=${groupSpecCount}`);

    if (groupRawSum < THRESHOLD_1688) {
      log(`    ⚠ 合計 ${groupRawSum} < ${THRESHOLD_1688}，整組不建單`);
      // 記 insufficient-quantity 異常（per-group）
      const groupAnomaly = {
        type: 'insufficient-quantity',
        mainId: code,
        productName: `共同採購 ${code} (${groupMainIds})`,
        rawSum: groupRawSum,
        threshold: THRESHOLD_1688,
        message: `${code} 共同採購合計 ${groupRawSum} < ${THRESHOLD_1688}，整組跳過`,
        specs: groupDecisions.flatMap((d) => d.items.map((it) => ({ label: it.label, qty: it.origQty }))),
      };
      const fakeDecision = {
        mainId: code, productName: groupAnomaly.productName, tags: { all: [] },
        decision: 'skip-insufficient', anomalies: [groupAnomaly],
      };
      try { appendAnomalies(fakeDecision, opts.execute ? 'execute' : 'dry-run', opts); }
      catch (e) { log(`  (warn) anomaly log failed: ${e.message}`); }
      allDecisions.push(fakeDecision);   // 讓 printSummary 數得到此筆群組異常
      continue;
    }

    const payload = buildGroupAddPayload(groupDecisions, { platform: opts.platform });
    if (!opts.execute) {
      log(`    [DRY-RUN P2-${groupIdx}] ${code}  (itemView ${payload.itemView.length} 規格)`);
      if (opts.debug) console.log('    payload:', JSON.stringify(payload, null, 2));
      totalResults.push({ mainId: code, status: 'dry-run' });
      continue;
    }

    log(`    [P2-${groupIdx}/${groupCodes.length}] POST — ${code}  (規格 ${payload.itemView.length})`);
    try {
      const resAdd = await api.Purchase.add(payload);
      const ok = resAdd?.Status === 'Success';
      if (ok) {
        const guid = resAdd.PurchaseSheetGUID || resAdd.GUID || resAdd.guid || '(no guid)';
        log(`    ✓ Success  GUID=${guid}`);
        totalResults.push({ mainId: code, status: 'ok', guid });
      } else {
        log(`    !!! Status=${resAdd?.Status}  Err=${(resAdd?.ErrorMessage || '').slice(0, 200)}`);
        totalResults.push({ mainId: code, status: 'fail', response: resAdd });
      }
    } catch (e) {
      log(`    !!! API error: ${e.message.slice(0, 200)}`);
      totalResults.push({ mainId: code, status: 'error', error: e.message });
    }
    if (opts.pauseMs > 0) await sleep(opts.pauseMs);
  }

  /* ── 總結 ── */
  log(`\n${'='.repeat(60)}`);
  log(`=== [1688] 總結 ===`);
  log(`${'='.repeat(60)}`);
  printSummary(allDecisions, totalResults, opts);
}

/* ============ 入口 ============ */

(async () => {
  const opts = parseArgs();
  printHeader(opts);

  if (opts.execute && !opts.platform) {
    log('!!! --execute 模式必須提供 --platform（採購平台，例 "indo-Office" / "1688-Office"）');
    process.exit(1);
  }

  const { context } = await launchWithSession({ headless: !opts.headed });
  const api = createClient(context);

  try {
    if (opts.workflow === '1688') {
      await run1688(opts, api);
    } else {
      await runIndo(opts, api);
    }
  } finally {
    await context.close();
  }
  log(`\ndone`);
})().catch((e) => {
  console.error('[FATAL]', e.message);
  console.error(e.stack);
  process.exit(1);
});
