// tw-purchase.js — TW Phase B 主控:ERP 需求 → join sheet → 分配 → 一廠商一單建單
//
// 架構:Node 主導(ERP session + 建單 + 分配),sheet 讀取交給 tw/sheet_dump.py(Python/gspread)。
// 流程:
//   1. ERP intelligentList(Keyword=TW)→ 每規格 needpurchaseQty + GUID + KeyWord(BOX 標籤)
//   2. spawn tw/sheet_dump.py → 每列 per-vendor 有貨/單價/每箱/最低
//   3. 以 MainId #N join → 組 specs → lib/tw-allocate 分配
//   4. dry-run:印計畫 + 輸出結果 JSON;--execute:POST /api/PurchaseSheet/add 一廠商一單
//
// 用法:node tw-purchase.js [--date YY/MM/DD] [--cardinality SalesCount90] [--percent 150]
//                          [--max-products N] [--execute] [--debug]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { launchWithSession } = require('./lib/session');
const { createClient } = require('./lib/http-client');
const { allocate, calcQty, perPiecePrice, DEFAULT_LOW_SALES, VENDORS } = require('./lib/tw-allocate');
const { parseTags, parseStopSpecs, matchesStopList } = require('./lib/purchase-rules');

function ts() { return new Date().toISOString().slice(11, 19); }
function log(m) { console.error(`[${ts()}] ${m}`); }   // 過程訊息走 stderr;結果 JSON 走 stdout

const ANOMALY_LOG = path.join(__dirname, 'state', 'anomalies.jsonl');
const RUN_ID = process.env.PURCHASE_RUN_ID || ('tw-' + Date.now().toString(36));

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (n, d = null) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    execute: a.includes('--execute'),
    debug: a.includes('--debug'),
    headed: a.includes('--headed'),
    date: get('--date', `${pad(d.getFullYear() % 100)}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`),
    cardinality: get('--cardinality', 'SalesCount90'),
    percent: parseInt(get('--percent', '150'), 10) || 150,
    maxProducts: parseInt(get('--max-products', '0'), 10) || 0,
    uploads: get('--uploads', ''),   // 有給 → 先跑 Phase A 庫存比對(寫 v)再跑 Phase B
    useCache: process.argv.includes('--use-cache'),  // 無上傳也用快取跑 Phase A(排程用)
  };
}

function dateNoOf(dateStr) {
  // "26/06/04" → "0604"
  const m = String(dateStr).split('/');
  return m.length >= 3 ? (m[1] + m[2]) : String(dateStr).replace(/\D/g, '').slice(-4);
}

const norm = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
const mainOf = (s) => norm(String(s || '').split('#')[0]);

function isGlobalExcluded(product) {
  const tags = parseTags(product.KeyWord);
  if (tags.all.some((t) => t.toLowerCase() === 'special')) return true;
  if (String(product.MainId || '').toUpperCase().startsWith('KDS')) return true;
  return false;
}
function hasBoxTag(product) {
  return parseTags(product.KeyWord).all.some((t) => t.toUpperCase() === 'BOX');
}

/* ---- spawn tw/sheet_dump.py 讀 sheet ---- */
function loadSheet() {
  const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, 'tw', 'tw_secrets.json'), 'utf8'));
  const py = process.env.TW_PYTHON || secrets.python_exe || 'python';
  const script = path.join(__dirname, 'tw', 'sheet_dump.py');
  log(`讀 sheet(${py} sheet_dump.py)...`);
  const r = spawnSync(py, [script], {
    cwd: __dirname,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (r.status !== 0) {
    throw new Error('sheet_dump.py 失敗: ' + (r.stderr || r.error || '').toString().slice(0, 300));
  }
  return JSON.parse(r.stdout);
}

/* ---- ERP TW 需求 → lookup ---- */
function buildErpLookup(list, opts) {
  const byKey = new Map();   // norm(ItemAtrNo) → entry
  const byMain = new Map();  // MainId(upper) → [entry]
  let specCount = 0, excluded = 0, stopped = 0;
  let scanned = 0;
  for (const p of list) {
    const product = p.product || {};
    if (opts.maxProducts && scanned >= opts.maxProducts) break;
    scanned++;
    if (isGlobalExcluded(product)) { excluded++; continue; }
    const tags = parseTags(product.KeyWord);
    const stopTokens = tags.hasStop ? parseStopSpecs(product.Remark) : [];
    const stopAll = tags.hasStop && stopTokens.length === 0;
    const isBox = hasBoxTag(product);
    for (const spec of p.productSpc || []) {
      if (!spec.needpurchase) continue;
      const qty = Number(spec.needpurchaseQty) || 0;
      if (qty <= 0) continue;
      if (tags.hasStop && (stopAll || matchesStopList(spec, stopTokens))) { stopped++; continue; }
      const entry = {
        mainId: product.MainId,
        itemAtrNo: spec.ItemAtrNo,
        demand: qty,
        isBox,
        productGuid: product.ProductGUID,
        specGuid: spec.ProductSpecGUID,
        purchasePrice: spec.PurchasePrice,
        weight: spec.Weight,
        exchangeRateGuid: product.ExchangeRateGUID,
        exchangeRate: product.ExchangeRate,
      };
      byKey.set(norm(spec.ItemAtrNo), entry);
      const mk = String(product.MainId || '').toUpperCase();
      if (!byMain.has(mk)) byMain.set(mk, []);
      byMain.get(mk).push(entry);
      specCount++;
    }
  }
  return { byKey, byMain, specCount, excluded, stopped };
}

function lookupDemand(erp, productCode) {
  const k = norm(productCode);
  if (erp.byKey.has(k)) return erp.byKey.get(k);
  const main = mainOf(productCode);
  const list = erp.byMain.get(main);
  if (list && list.length === 1) return list[0];   // 整品(無 #)單一規格 fallback
  return null;
}

/* ---- join sheet × ERP → specs(給分配)---- */
function buildSpecs(sheetRows, erp) {
  const specs = [];
  const specByKey = new Map();
  const unjoined = [];      // sheet 有貨但 ERP 無需求(或無對映)
  const missingPrice = [];  // 有貨候選但缺單價
  for (const row of sheetRows) {
    const entry = lookupDemand(erp, row.product);
    if (!entry) continue;   // 無 ERP 需求 → 這列這次不採購
    const vendors = {};
    for (const v of VENDORS) {
      const vd = row.vendors[v] || {};
      if (vd.code && vd.code !== '-' && vd.hasStock) {
        vendors[v] = { hasStock: true, unitPrice: vd.unitPrice, boxSize: vd.boxSize, minPcs: vd.minPcs };
        if (!vd.unitPrice) missingPrice.push({ product: row.product, vendor: v });
      }
    }
    const spec = { key: row.product, demand: entry.demand, isBox: entry.isBox, vendors, _erp: entry };
    specs.push(spec);
    specByKey.set(row.product, spec);
  }
  // ERP 有需求但 sheet 找不到對映的(資料維護)
  const sheetKeys = new Set(sheetRows.map((r) => norm(r.product)));
  const sheetMains = new Set(sheetRows.map((r) => mainOf(r.product)));
  for (const [k, e] of erp.byKey) {
    if (!sheetKeys.has(k) && !sheetMains.has(mainOf(e.itemAtrNo || e.mainId))) {
      unjoined.push(e.itemAtrNo || e.mainId);
    }
  }
  return { specs, specByKey, unjoined, missingPrice };
}

/* ---- 組一廠商一單 payload ---- */
function buildVendorPayload(vendor, orders, specByKey, dateStr) {
  const itemView = orders.map((o, i) => {
    const spec = specByKey.get(o.key);
    const e = spec._erp;
    return {
      ProductGUID: e.productGuid,
      ProductSpecGUID: e.specGuid,
      QTY: String(o.qty),
      ExchangeRateGUID: e.exchangeRateGuid || '',
      ExchangeRate: String(e.exchangeRate ?? ''),
      Remark: '',
      // 建單單價用 sheet 該廠商的「每個」價(ERP PurchasePrice 為 0);box 商品已還原成每個
      PurchasePrice: String(perPiecePrice(spec, vendor)),
      weight: String(e.weight ?? 0),
      sort: i + 1,
    };
  });
  return {
    PurchasePlatform: `TW-${vendor}`,         // 採購平台 = TW-廠商
    PurchasePlatformNo: dateNoOf(dateStr),    // 採購平台訂單編號 = 日期 MMDD
    LogisticsCompany: '', LogisticsNo: '',
    ShippingLocationGUID: '', ShippingLocationName: '', ShippingLocationNo: '',
    PurchaseAllPrice: 0, Discount: 0, TotalWeight: 0, TransitFee: 0, PackageFee: 0, TotalPrice: 0,
    Remark: '',
    itemView,
  };
}

/* ---- Phase A:跑 tw/stock_match.py(解析廠商檔 → 比對 → 寫 v)---- */
function runStockMatch(uploadsDir, dateStr, execute) {
  const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, 'tw', 'tw_secrets.json'), 'utf8'));
  const py = process.env.TW_PYTHON || secrets.python_exe || 'python';
  const args = [path.join(__dirname, 'tw', 'stock_match.py'), '--uploads', uploadsDir];
  if (dateStr) args.push('--date', dateStr);
  if (execute) args.push('--execute');
  const r = spawnSync(py, args, {
    cwd: __dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (r.stderr) String(r.stderr).split('\n').forEach((l) => { if (l.trim()) log('  [A] ' + l.trim()); });
  const line = String(r.stdout || '').trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
  let parsed = null;
  try { parsed = JSON.parse(line); } catch {}
  if (r.status !== 0) {
    throw new Error((parsed && parsed.error) ? parsed.error
      : 'Phase A 失敗: ' + String(r.stderr || (r.error && r.error.message) || '').slice(0, 200));
  }
  return parsed;
}

/* ---- execute:把 需求量/採購量 回填 sheet(spawn Python)---- */
function writeBackToSheet(dateStr, specs, alloc) {
  const vendorByKey = {};
  for (const v of VENDORS) for (const o of alloc.orders[v]) vendorByKey[o.key] = { v, qty: o.qty };
  const rows = specs.map((s) => {
    const a = vendorByKey[s.key];
    return { product: s.key, demand: s.demand, vendorQty: a ? { [a.v]: a.qty } : {} };
  });
  const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, 'tw', 'tw_secrets.json'), 'utf8'));
  const py = process.env.TW_PYTHON || secrets.python_exe || 'python';
  const r = spawnSync(py, [path.join(__dirname, 'tw', 'sheet_writeback.py')], {
    cwd: __dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    input: JSON.stringify({ date: dateStr, rows }),
  });
  if (r.status !== 0) throw new Error('sheet_writeback 失敗: ' + (r.stderr || r.error || '').toString().slice(0, 300));
  try { return JSON.parse(r.stdout); } catch { return { raw: String(r.stdout).slice(0, 200) }; }
}

/* ---- execute:把「訂不到」寫入異常紀錄(三家沒貨 / 湊不滿低銷)---- */
function appendTwAnomalies(unshippable, opts) {
  if (!unshippable || !unshippable.length) return 0;
  const dir = path.dirname(ANOMALY_LOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const TYPE = { 'no-stock': 'tw-no-stock', 'below-low-sales': 'tw-below-low-sales' };
  const MSG = {
    'no-stock': (k) => `${k}:三家廠商當週都沒貨,這次訂不到`,
    'below-low-sales': (k, v) => `${k}:只有湊不滿低銷的廠商有貨${v ? '(' + v + ')' : ''},訂不到`,
  };
  const now = Date.now();
  const lines = unshippable.map((u) => JSON.stringify({
    time: now, runId: RUN_ID, mode: 'execute',
    cardinality: opts.cardinality, percent: opts.percent,
    mainId: u.key, productName: '',
    type: TYPE[u.reason] || ('tw-' + u.reason),
    message: (MSG[u.reason] || ((k) => `${k}:訂不到`))(u.key, u.vendor),
    platform: 'tw', tags: ['TW'],
  }));
  fs.appendFileSync(ANOMALY_LOG, lines.join('\n') + '\n');
  return lines.length;
}

async function main() {
  const opts = parseArgs();
  log(`=== TW ${opts.uploads ? '一鍵全流程' : 'Phase B'} — ${opts.execute ? 'EXECUTE' : 'DRY-RUN'} | date ${opts.date} (${dateNoOf(opts.date)}) ===`);

  // 0) Phase A 庫存比對(有 --uploads 才跑):解析廠商檔(或用快取)→ 比對 → 寫 v
  let phaseA = null;
  if (opts.uploads || opts.useCache) {
    log(`=== Phase A 庫存比對(${opts.execute ? 'execute 寫 v' : 'dry-run'})===`);
    phaseA = runStockMatch(opts.uploads, opts.date, opts.execute);
    if (phaseA && phaseA.matched) {
      log(`Phase A: ${phaseA.usedCache ? '用上次快取(免 OCR)' : '本次新解析'} · 有貨打勾 IL${phaseA.matched.IL}/HS${phaseA.matched.HS}/IN${phaseA.matched.IN},寫入 ${phaseA.written_cells || 0} 格`);
    }
  }
  // 欄組 / 採購單日期:有跑 Phase A 用其有效日期(沒上傳則來自快取),否則用 --date
  const effDate = (phaseA && phaseA.date) ? phaseA.date : opts.date;

  // 1) sheet
  const sheet = loadSheet();
  log(`sheet 列 ${sheet.rows.length};有貨欄 ${JSON.stringify(sheet.stockCols)}`);

  // 2) ERP TW 需求
  const { context } = await launchWithSession({ headless: !opts.headed });
  const api = createClient(context);
  let erp;
  try {
    log(`查 ERP 智能採購(Keyword=TW, ${opts.cardinality} × ${opts.percent}%)...`);
    const res = await api.Purchase.intelligentList({
      length: 999, KeywordType: 'Keyword', Keyword: 'TW',
      cardinality: opts.cardinality, percent: opts.percent,
    });
    const list = res.list || [];
    log(`ERP 回 ${list.length} 個 TW 商品`);
    erp = buildErpLookup(list, opts);
    log(`有需求規格 ${erp.specCount}(排除 special/KDS ${erp.excluded}、STOP 跳過 ${erp.stopped})`);
  } catch (e) {
    await context.close();
    throw e;
  }

  // 3) join + 分配
  const { specs, specByKey, unjoined, missingPrice } = buildSpecs(sheet.rows, erp);
  log(`join 出 ${specs.length} 個有需求規格;ERP 有需求但 sheet 無對映 ${unjoined.length}`);
  const alloc = allocate(specs, DEFAULT_LOW_SALES);
  for (const v of VENDORS) {
    log(`  ${v}: ${alloc.orders[v].length} 項  金額 ${Math.round(alloc.vendorTotals[v])}  (低銷 ${DEFAULT_LOW_SALES[v]})`);
  }
  log(`  訂不到 ${alloc.unshippable.length}(三家沒貨/湊不滿低銷)`);

  // 4) PO payloads
  const po = {};
  for (const v of VENDORS) {
    if (alloc.orders[v].length === 0) continue;
    po[v] = buildVendorPayload(v, alloc.orders[v], specByKey, effDate);
  }

  // execute:回填 sheet → POST 建單 → 寫異常紀錄
  const posted = {};
  let writeback = null;
  let anomaliesWritten = 0;
  if (opts.execute) {
    try {
      log('回填 sheet(需求量 / 採購量)...');
      writeback = writeBackToSheet(effDate, specs, alloc);
      log(`  回填 ${writeback.written_cells} 格(${writeback.rows} 列)`);
      for (const v of Object.keys(po)) {
        log(`POST 建單 TW-${v} ${dateNoOf(effDate)}(${po[v].itemView.length} 規格)...`);
        const r = await api.Purchase.add(po[v]);
        const ok = r && r.Status === 'Success';
        posted[v] = { ok, guid: r && (r.PurchaseSheetGUID || r.GUID), status: r && r.Status, err: r && r.ErrorMessage };
        log(`  ${ok ? '✓ ' + (posted[v].guid || '') : '!!! ' + (posted[v].err || posted[v].status)}`);
      }
    } finally {
      await context.close();
    }
    anomaliesWritten = appendTwAnomalies(alloc.unshippable, opts);
    log(`異常紀錄 +${anomaliesWritten}(訂不到)`);
  } else {
    await context.close();
  }

  const result = {
    date: effDate, dateNo: dateNoOf(effDate),
    mode: opts.execute ? 'execute' : 'dry-run',
    erp: { products: (erp.specCount), excluded: erp.excluded, stopped: erp.stopped },
    sheetRows: sheet.rows.length,
    joined: specs.length,
    unjoinedCount: unjoined.length,
    unjoinedSample: unjoined.slice(0, 50),
    missingPrice: missingPrice.slice(0, 50),
    vendorTotals: alloc.vendorTotals,
    lowSales: DEFAULT_LOW_SALES,
    orders: VENDORS.reduce((acc, v) => {
      acc[v] = alloc.orders[v].map((o) => ({ ...o, name: o.key }));
      return acc;
    }, {}),
    unshippable: alloc.unshippable,
    po: Object.keys(po).reduce((acc, v) => {
      acc[v] = { platform: po[v].PurchasePlatform, platformNo: po[v].PurchasePlatformNo,
                 items: po[v].itemView.length, totalQty: po[v].itemView.reduce((s, it) => s + Number(it.QTY), 0) };
      return acc;
    }, {}),
    posted: opts.execute ? posted : null,
    writeback,
    anomaliesWritten,
    phaseA,
  };
  if (opts.debug) result.poPayloads = po;
  process.stdout.write(JSON.stringify(result) + '\n');
  log('done');
}

// 匯出純函數供測試 / 重用(join / 分配 / payload 不碰 IO)
module.exports = {
  buildErpLookup, buildSpecs, buildVendorPayload, lookupDemand,
  dateNoOf, norm, mainOf, isGlobalExcluded, hasBoxTag,
};

if (require.main === module) {
  main().catch((e) => {
    log('[FATAL] ' + e.message);
    process.stdout.write(JSON.stringify({ error: e.message }) + '\n');
    process.exit(1);
  });
}
