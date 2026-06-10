// tw-allocate.js — TW 採購量分配(純函數,不碰 sheet/HTTP/ERP)
//
// 規則來自客戶逐字稿 04/05 + Justin 確認:
//   • 每個有需求量的規格,需求「整筆」分配給一家「當週有貨」的廠商(不拆單)。
//   • 數量計算(每規格 × 候選廠商):
//       - BOX 商品(ERP KeyWord 有 BOX 標籤):訂整箱 → qty = ceil(需求/每箱幾件) 箱 × 每箱幾件,至少 1 箱。
//       - 非 BOX:qty = ceil( max(需求, 最低採購量) / 6 ) * 6  (向上補到最低量、再進位到 6 倍數)。
//   • 金額 = 單價 × qty(單價為每「個」價)。
//   • 低銷門檻:IL 8000 / HS 3000 / IN 5000;某廠商「被分到的總金額 ≥ 低銷」才出貨。
//   • 需求一律要訂(全訂);低銷只是「廠商出不出貨」的門檻。
//   • 多家有貨時只給「其中一家」,選擇優先序(Justin 06/10 確認):
//       ① 採購量最少(最低採購量低 → 最不超量,例 KFD35 demand2:IL最低24<IN最低48 → 給 IL)
//       ② 單價最便宜(缺單價排最後)
//       ③ 低銷分配:未達低銷者優先,順序 IL>IN>HS(IL 填到低銷 8000 再給 IN,再給 HS)
//   • 某廠商湊不滿低銷 → 其(可移動的)規格改分給別家有貨廠商;真的沒人接 → 列「訂不到」。
//
// ★ 多家有貨時的最佳分配是組合最佳化問題;本檔用「可解釋的貪婪 + 可行性回合」啟發式(v1),
//   行為以合成測試驗證,必要時再調整。

const VENDORS = ['IL', 'HS', 'IN'];
const DEFAULT_LOW_SALES = { IL: 8000, HS: 3000, IN: 5000 };
// box 商品的「單價」欄單位依廠商固定:這些廠商填的是「每箱價」,需 ÷每箱數量還原成每個;
// 其餘廠商填「每個價」。實資料(box 品 KFD01/KFD40/KFD72):HS=每箱,IL/IN=每個。
const PER_BOX_VENDORS = new Set(['HS']);

// 解析非 BOX 的最低採購量字串("3 PCS" / "12" / "" → 數字;BOX 走另一條)
function parseMinPcs(raw) {
  const m = String(raw || '').match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

// 單一規格在某廠商的採購量(個)
function calcQty(spec, v) {
  const vd = spec.vendors[v];
  if (!vd) return 0;
  const demand = Number(spec.demand) || 0;
  const bs = Number(vd.boxSize) || 0;
  // 盒裝是「分廠」的:BOX 標籤是商品層級,但實際成箱與否看各廠商有沒有填「每箱數量」。
  //   有每箱數量 → 訂整箱(qty = 箱數 × 每箱數量,至少 1 箱)。
  //   沒每箱數量(散裝,如 IN 標 MIN 40 PCS)→ 走散裝規則:max(需求, 最低) 進位 6 倍數。
  if (spec.isBox && bs > 0) {
    const boxes = Math.max(1, Math.ceil(demand / bs));
    return boxes * bs;
  }
  const min = Number(vd.minPcs) || 0;
  const base = Math.max(demand, min);
  return Math.ceil(base / 6) * 6;
}

// box 商品的單價單位「依廠商」固定(PER_BOX_VENDORS=每箱價 → ÷每箱數量還原成每個;其餘=每個價)。
// (例 KFD01 箱40:IL $9/個、IN $9.5/個、HS $360/箱→$9/個。)非 box 一律當每個。
function perPiecePrice(spec, v) {
  const vd = spec.vendors[v];
  if (!vd) return 0;
  const up = Number(vd.unitPrice) || 0;
  const bs = Number(vd.boxSize) || 0;
  if (spec.isBox && PER_BOX_VENDORS.has(v) && bs > 0) return up / bs;
  return up;
}

function amountOf(spec, v) {
  return calcQty(spec, v) * perPiecePrice(spec, v);
}

// specs: [{ key, demand, isBox, vendors: { IL:{hasStock,unitPrice,boxSize,minPcs}, ... } }]
//   vendors 只需列出「有貨且有對照」的廠商(hasStock=true)。
// 回傳:{ orders:{IL:[{key,qty,amount}],...}, vendorTotals, unshippable:[{key,reason,vendor?}] }
function allocate(specs, lowSales = DEFAULT_LOW_SALES) {
  const cand = new Map();   // key -> [vendors with stock]
  specs.forEach((s) => {
    cand.set(s.key, VENDORS.filter((v) => s.vendors[v] && s.vendors[v].hasStock));
  });

  const assign = new Map();             // key -> vendor
  const totals = { IL: 0, HS: 0, IN: 0 };
  const add = (s, v) => { assign.set(s.key, v); totals[v] += amountOf(s, v); };
  const rm = (s) => {
    const v = assign.get(s.key);
    if (v) { totals[v] -= amountOf(s, v); assign.delete(s.key); }
  };

  const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const forced = specs.filter((s) => cand.get(s.key).length === 1).sort(byKey);
  const flexible = specs.filter((s) => cand.get(s.key).length > 1).sort(byKey);

  // 1) 強制(單一有貨廠商)
  forced.forEach((s) => add(s, cand.get(s.key)[0]));

  // 2) 彈性(多家有貨,只給一家)。優先序:
  //    ① 採購量最少(最低採購量低 → 最不超量) ② 單價最便宜(缺價排最後)
  //    ③ 低銷分配:未達低銷者優先、順序 IL>IN>HS(IL 填到低銷再給 IN,再給 HS)
  const ppOrInf = (s, v) => perPiecePrice(s, v) || Infinity;
  const fillRank = (v) => (totals[v] < lowSales[v] ? 0 : 3) + VENDORS.indexOf(v);
  flexible.forEach((s) => {
    const best = cand.get(s.key).slice().sort((a, b) => {
      const qa = calcQty(s, a), qb = calcQty(s, b);
      if (qa !== qb) return qa - qb;                       // ① 採購量少者優先(最不超量)
      const price = ppOrInf(s, a) - ppOrInf(s, b);
      if (Math.abs(price) > 1e-9) return price;            // ② 單價低者優先
      return fillRank(a) - fillRank(b);                    // ③ 低銷分配:未達標優先、IL>IN>HS
    })[0];
    add(s, best);
  });

  // 3) 可行性回合:把「已被分到但總額 < 低銷」的廠商,其可移動(彈性)規格
  //    改塞給「已達標」的候選廠商;反覆到穩定。
  let changed = true, guard = 0;
  while (changed && guard++ < 100) {
    changed = false;
    for (const uv of VENDORS) {
      if (totals[uv] === 0 || totals[uv] >= lowSales[uv]) continue;
      const movable = specs
        .filter((s) => assign.get(s.key) === uv && cand.get(s.key).length > 1)
        .sort(byKey);
      for (const s of movable) {
        const alt = cand.get(s.key)
          .filter((v) => v !== uv && totals[v] >= lowSales[v])
          .sort((a, b) => (ppOrInf(s, a) - ppOrInf(s, b)) || (a < b ? -1 : a > b ? 1 : 0))[0];
        if (alt) { rm(s); add(s, alt); changed = true; }
      }
    }
  }

  // 4) 產出 orders + unshippable
  const orders = { IL: [], HS: [], IN: [] };
  const unshippable = [];
  specs.slice().sort(byKey).forEach((s) => {
    const cs = cand.get(s.key);
    if (cs.length === 0) { unshippable.push({ key: s.key, reason: 'no-stock' }); return; }
    const v = assign.get(s.key);
    if (v && totals[v] >= lowSales[v]) {
      orders[v].push({ key: s.key, vendor: v, qty: calcQty(s, v), amount: amountOf(s, v) });
    } else {
      unshippable.push({ key: s.key, reason: 'below-low-sales', vendor: v });
    }
  });

  return { orders, vendorTotals: totals, unshippable };
}

module.exports = { allocate, calcQty, perPiecePrice, parseMinPcs, DEFAULT_LOW_SALES, PER_BOX_VENDORS, VENDORS };
