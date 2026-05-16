// _fetch-options.js — server.js spawn 來拿選單資料的 helper
// 用法： node _fetch-options.js suppliers
//        node _fetch-options.js translocations
// 輸出 JSON 到 stdout

const { launchWithSession } = require('./lib/session');
const { createClient } = require('./lib/http-client');

const target = process.argv[2];
if (!target || !['suppliers', 'translocations'].includes(target)) {
  console.error('usage: node _fetch-options.js <suppliers|translocations>');
  process.exit(1);
}

(async () => {
  const { context } = await launchWithSession({ headless: true, allowHeadedFallback: false });
  const api = createClient(context);
  let out;
  if (target === 'suppliers') {
    const r = await api.Supplier.list({ length: 999 });
    // 回傳簡化結構：{ guid, name, status }
    out = (r.list || r.data || []).map((s) => ({
      guid: s.SupplierGUID || s.guid || s.GUID,
      name: s.Name || s.SupplierName || '',
      status: !!s.Status,
    })).filter((x) => x.guid);
  } else {
    const r = await api.Translocation.list({ length: 1000 });
    // 對應 purchase-intelligent.js:251 的結構：list[].ShippingLocationView
    out = (r.list || []).map((el) => {
      const view = el.ShippingLocationView || el;
      return {
        guid: view.ShippingLocationGUID || '',
        name: view.Name || '',
        deliveryLocation: view.DeliveryLocation || '',
      };
    }).filter((x) => x.guid);
  }
  process.stdout.write(JSON.stringify(out));
  await context.close();
})().catch((e) => {
  console.error('[fetch-options] error:', e.message);
  process.exit(1);
});
