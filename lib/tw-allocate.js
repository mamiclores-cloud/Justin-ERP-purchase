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
//   • 目標:剛好達低銷;多家有貨時優先分給「最需要湊低銷」的廠商。
//   • 某廠商湊不滿低銷 → 其(可移動的)規格改分給別家有貨廠商;真的沒人接 → 列「訂不到」。
//
// ★ 多家有貨時的最佳分配是組合最佳化問題;本檔用「可解釋的貪婪 + 可行性回合」啟發式(v1),
//   行為以合成測試驗證,必要時再調整。

const VENDORS = ['IL', 'HS', 'IN'];
const DEFAULT_LOW_SALES = { IL: 8000, HS: 3000, IN: 5000 };

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
  if (spec.isBox) {
    const bs = Number(vd.boxSize) || 1;
    const boxes = Math.max(1, Math.ceil(demand / bs));
    return boxes * bs;
  }
  const min = Number(vd.minPcs) || 0;
  const base = Math.max(demand, min);
  return Math.ceil(base / 6) * 6;
}

// box 商品的單價單位各廠商不一:單價 ≥ 箱數 → 視為「每箱價」,÷箱數還原成每個。
// (例 KFD01 箱40:IL 9/個、HS 360/箱→9、IN 9.5/個。)非 box 或單價 < 箱數 → 當每個。
function perPiecePrice(spec, v) {
  const vd = spec.vendors[v];
  if (!vd) return 0;
  const up = Number(vd.unitPrice) || 0;
  const bs = Number(vd.boxSize) || 0;
  if (spec.isBox && bs > 0 && up >= bs) return up / bs;
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

  // 2) 彈性:主排序「最需要湊低銷」(離低銷差距最大);gap 平手 → 挑「每個單價最便宜」的廠商。
  //    缺單價(0)當 +∞ 排最後,不讓 $0 假裝最便宜。再平手用廠商固定順序保持穩定。
  const ppOrInf = (s, v) => perPiecePrice(s, v) || Infinity;
  flexible.forEach((s) => {
    const best = cand.get(s.key).slice().sort((a, b) => {
      const gap = (lowSales[b] - totals[b]) - (lowSales[a] - totals[a]);  // gap 大者優先
      if (Math.abs(gap) > 1e-6) return gap;
      const price = ppOrInf(s, a) - ppOrInf(s, b);                        // 平手:單價低者優先
      if (Math.abs(price) > 1e-6) return price;
      return a < b ? -1 : a > b ? 1 : 0;
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

module.exports = { allocate, calcQty, perPiecePrice, parseMinPcs, DEFAULT_LOW_SALES, VENDORS };
