// http-client.js — Ajin ERP 採購端 API 包裝
//
// 用法：
//   const { launchWithSession } = require('./lib/session');
//   const { createClient } = require('./lib/http-client');
//   const { context } = await launchWithSession();
//   const api = createClient(context);
//   const list = await api.Purchase.intelligentList({ KeywordType: 'Keyword', Keyword: 'Indo' });
//
// 本專案只用到三個命名空間：
//   Purchase       — 智能採購清單 + 建立採購單 + 採購完成 + 設定
//   Translocation  — 集運地點選項（採購單 ShippingLocation 下拉用）
//   Supplier       — 供應商選單

const cfg = require('../secrets');

const BASE = cfg.baseUrl; // https://srv01.ajinerp.com

// 把 nested object 序列化成 jQuery .param() 格式
// 因為 ERP 用 form-encoded body 而非 JSON
function jqParam(obj, prefix) {
  const parts = [];
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const v = obj[key];
    const name = prefix ? `${prefix}[${key}]` : key;
    if (v === null || v === undefined) {
      parts.push(`${encodeURIComponent(name)}=`);
    } else if (Array.isArray(v) || (typeof v === 'object' && v.constructor === Object)) {
      parts.push(jqParam(v, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

function isLoggedOut(url) {
  return /\/Common\/Login/i.test(String(url || ''));
}

function createClient(context, options = {}) {
  const req = context.request;
  const onSessionExpired = options.onSessionExpired;
  // 廣泛搜尋 (KeywordType=ALL) + 30/60/90 日銷量 + 150% 倍率時,ERP 端計算量大,
  // 60 秒不夠。實測 SalesCount30 + 150% 偶爾要 70-90 秒。拉到 180 秒比較安全。
  const TIMEOUT_MS = options.timeoutMs || 180000;
  const MAX_RETRIES = options.retries ?? 2;

  async function _retryable(fn, label) {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (attempt < MAX_RETRIES && /Timeout|ECONN|ENET|net::/i.test(e.message)) {
          const wait = 1500 * (attempt + 1);
          console.log(`[${new Date().toISOString().slice(11, 19)}] [http/retry] ${label} failed: ${e.message.slice(0, 80)} → retry in ${wait}ms`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  async function parseResponse(r, method, url) {
    const status = r.status();
    const ct = r.headers()['content-type'] || '';
    if (isLoggedOut(r.url())) {
      if (onSessionExpired) await onSessionExpired();
      throw new Error(`[${method} ${url}] redirected to login (session expired)`);
    }
    if (status >= 400) {
      const text = await r.text().catch(() => '');
      throw new Error(`[${method} ${url}] HTTP ${status}: ${text.slice(0, 300)}`);
    }
    if (/json/i.test(ct)) return await r.json();
    return await r.text();
  }

  async function rawGet(url, params) {
    const query = params ? '?' + jqParam(params) : '';
    const fullUrl = url.startsWith('http') ? url + query : BASE + url + query;
    return _retryable(async () => {
      const r = await req.get(fullUrl, { failOnStatusCode: false, timeout: TIMEOUT_MS });
      return parseResponse(r, 'GET', fullUrl);
    }, `GET ${fullUrl.slice(0, 80)}`);
  }

  async function rawPost(url, body) {
    const fullUrl = url.startsWith('http') ? url : BASE + url;
    const formBody = body ? jqParam(body) : '';
    return _retryable(async () => {
      const r = await req.post(fullUrl, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': BASE + '/Purchase/Intelligent',
          'Origin': BASE,
        },
        data: formBody,
        failOnStatusCode: false,
        timeout: TIMEOUT_MS,
      });
      return parseResponse(r, 'POST', fullUrl);
    }, `POST ${fullUrl.slice(0, 80)}`);
  }

  return {
    get: rawGet,
    post: rawPost,

    /* ============== Purchase / 智能採購 ============== */
    // 建單流程：
    //   1. intelligentList()           → 拿候選商品 + needpurchaseQty
    //   2. (前端用 purchase-rules 計算最終 qty + 篩 STOP)
    //   3. add(PurchaseSheetViewData)  → 建立採購單（純後端，沒有「加入清單」「轉採購單」中間步驟）
    //
    // 註：UI 上「加入清單」「轉採購單」是純前端 state（看 analysis/purchase-intelligent.js:97-145, 226-260），
    //     不打 API。CheckPurchaseForm 唯一驗證 = itemView 非空（line 2680）。
    Purchase: {
      // 智能採購候選清單（含 needpurchaseQty、cardinality 計算後值、KeyWord、Remark）
      // 真實 endpoint = /api/ProductOverview/ProductSpecList
      async intelligentList(params = {}) {
        return rawGet('/api/ProductOverview/ProductSpecList', {
          draw: 1,
          start: 0,
          length: params.length ?? 999,
          'search[value]': '',
          'search[regex]': false,
          status: true,
          datafinish: true,
          sort: 'SupplierName',
          orderby: 'asc',
          cardinality: params.cardinality || 'SalesCount15',
          percent: params.percent ?? 100,
          supplier: params.supplier ?? '',
          KeywordType: params.KeywordType ?? '',
          Keyword: params.Keyword ?? '',
        });
      },
      // 建採購單（對應 analysis/purchase-intelligent.js:737 的 PurchaseSheetViewData）
      async add(payload) {
        return rawPost('/api/PurchaseSheet/add', payload);
      },
      // 現有採購單列表（採購作業 > 採購單）
      // finish: false=採購中 / true=採購完成 / null=全部（同 UI 上排按鈕）
      // 1688「6天內不重複採購」規則用它查採購中清單，
      // 回傳每張單含 PurchaseNo（前 8 碼 = 建單日期 yyyyMMdd）+ itemView[].productMainId
      async list(params = {}) {
        return rawGet('/api/PurchaseSheet/list', {
          draw: 1,
          start: params.start ?? 0,
          length: params.length ?? 999,
          'search[value]': '',
          'search[regex]': false,
          finish: params.finish ?? false,
          KeywordType: params.KeywordType ?? '',
          Keyword: params.Keyword ?? '',
          Start_dd: params.Start_dd ?? '',
          End_dd: params.End_dd ?? '',
        });
      },
      // 採購單詳情
      async data(guid) {
        return rawGet('/api/PurchaseSheet/data', { PurchaseSheetGUID: guid });
      },
      // 採購完成
      async purchaseFinish(items) {
        return rawPost('/api/PurchaseSheet/PurchaseFinish', { list: items });
      },
      // 智能採購預設值（cardinality + percent，UI 的記憶設定）
      async settingData() {
        return rawGet('/api/PurchaseSetting/Data');
      },
      async settingUpdate({ cardinality, percent }) {
        return rawPost('/api/PurchaseSetting/Setting', { cardinality, percent });
      },
    },

    /* ============== Translocation / 集運地點 ============== */
    Translocation: {
      async list(params = {}) {
        return rawGet('/api/Translocation/list', {
          start: 0,
          length: 1000,
          status: true,
          ...params,
        });
      },
    },

    /* ============== Supplier / 供應商 ============== */
    Supplier: {
      async list(params = {}) {
        return rawGet('/api/Supplier/list', {
          draw: 1,
          start: 0,
          length: 999,
          ...params,
        });
      },
      async data(guid) {
        return rawGet('/api/Supplier/data', { SupplierGUID: guid });
      },
      // 給下拉選項用
      async jsonSelect() {
        return rawGet('/api/Supplier/JsonHtmlSelect');
      },
    },
  };
}

module.exports = { createClient, jqParam, isLoggedOut };
