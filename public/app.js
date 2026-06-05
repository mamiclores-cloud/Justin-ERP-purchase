// app.js — 智能採購控制台前端 (新 UI + 後端整合)
(() => {
  'use strict';

  /* ============== Helpers ============== */
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === 'class') e.className = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k === 'style') Object.assign(e.style, v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v);
    });
    if (typeof children === 'string') e.textContent = children;
    else if (Array.isArray(children)) children.forEach(c => c && e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return e;
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // log line 染色 (inline style,不動 style.css)
  const LOG_COLOR = {
    stderr:  '#e89a9a',
    success: '#94c79c',
    warn:    '#d8b573',
    create:  '#88c7a3',
    skip:    '#b8b8a8',
  };
  function classifyLog(text) {
    if (/\[CREATE\]/.test(text))                return 'create';
    if (/\[SKIP/.test(text))                    return 'skip';
    if (/✓|Success|completed|done$/i.test(text)) return 'success';
    if (/⚠|WARN/.test(text))                    return 'warn';
    if (/\bERROR\b|\bFATAL\b|!!!/i.test(text))  return 'stderr';
    return '';
  }

  /* ============== Admin defaults (localStorage) ============== */
  const ADMIN_KEY = 'admin-defaults-v1';
  const ADMIN_MODE_KEY = 'admin-mode-v1';
  const DEFAULTS = {
    cardinality: 'SalesCount90',
    percent: 150,
    prefix: 'indo-',
    dest: 'Office',
  };
  function loadAdminDefaults() {
    try {
      const raw = localStorage.getItem(ADMIN_KEY);
      if (!raw) return { ...DEFAULTS };
      return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch { return { ...DEFAULTS }; }
  }
  function saveAdminDefaults(d) {
    try { localStorage.setItem(ADMIN_KEY, JSON.stringify(d)); } catch {}
  }
  function applyAdminDefaultsToForms() {
    const d = loadAdminDefaults();
    $('#adminCardinality').value     = d.cardinality;
    $('#adminPercent').value         = d.percent;
    $('#adminPlatformPrefix').value  = d.prefix;
    $('#adminPlatformDest').value    = d.dest;

    $('#indoCardinality').value     = d.cardinality;
    $('#indoPercent').value         = d.percent;
    $('#indoPlatformPrefix').value  = d.prefix;
    $('#indoPlatformDest').value    = d.dest;

    $('#t1688Cardinality').value    = d.cardinality;
    $('#t1688Percent').value        = d.percent;
    $('#t1688PlatformDest').value   = d.dest;
  }

  /* ============== Tab navigation ============== */
  const tabs    = $$('.tab');
  const panels  = $$('.tabpanel');
  const tabsNav = $('#tabsNav');

  function showPanelOnly(panelId) {
    panels.forEach(p => p.classList.toggle('is-active', p.id === panelId));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function switchTab(name) {
    tabs.forEach(t => t.classList.toggle('is-active', t.dataset.tab === name));
    showPanelOnly(`tab-${name}`);

    if (name === 'exception') {
      loadAnomalies();
      startAnomalyPoll();
    } else {
      stopAnomalyPoll();
    }
    if (name === 'schedule') loadSchedules();
  }

  tabs.forEach(t => t.addEventListener('click', () => {
    if (adminOn) setAdmin(false);
    tabsNav.hidden = false;
    switchTab(t.dataset.tab);
  }));

  /* ============== Admin mode toggle ============== */
  const adminBtn   = $('#adminToggle');
  const adminLabel = $('#adminToggleLabel');
  let adminOn = false;

  function setAdmin(on) {
    if (adminOn === on) return;
    adminOn = on;
    adminBtn.classList.toggle('is-on', on);
    adminLabel.textContent = on ? '退出管理員' : '管理員';
    tabsNav.hidden = on;
    if (on) {
      tabs.forEach(t => t.classList.remove('is-active'));
      showPanelOnly('adminView');
      stopAnomalyPoll();
    } else {
      switchTab('purchase');
    }
    try { localStorage.setItem(ADMIN_MODE_KEY, on ? '1' : '0'); } catch {}
  }
  adminBtn.addEventListener('click', () => setAdmin(!adminOn));

  $('#openStepBtn').addEventListener('click', () => showPanelOnly('tab-step'));
  $('#backFromStep').addEventListener('click', () => showPanelOnly('adminView'));

  /* ============== Admin save ============== */
  $('#adminSaveBtn').addEventListener('click', () => {
    const d = {
      cardinality: $('#adminCardinality').value,
      percent:     Number($('#adminPercent').value) || 150,
      prefix:      $('#adminPlatformPrefix').value.trim(),
      dest:        $('#adminPlatformDest').value.trim(),
    };
    saveAdminDefaults(d);
    applyAdminDefaultsToForms();
    alert('設定已儲存。「智能採購建單」頁面的預設值已更新。');
  });

  /* ============== Schedule: form open/close ============== */
  const scheduleForm  = $('#scheduleForm');
  const scheduleEmpty = $('#scheduleEmpty');
  $('#addScheduleBtn').addEventListener('click', () => openScheduleEditor(null));
  $('#closeScheduleForm').addEventListener('click', closeScheduleEditor);
  $('#cancelScheduleForm').addEventListener('click', closeScheduleEditor);

  /* ============== Schedule: trigger-type dependent fields ============== */
  const triggerType = $('#triggerType');
  function refreshTrigger() {
    const v = triggerType.value;
    $$('[data-trigger]').forEach(node => {
      node.hidden = node.dataset.trigger !== v;
    });
  }
  triggerType.addEventListener('change', refreshTrigger);

  /* ============== Custom datetime picker ============== */
  const dtOpenBtn   = $('#dtPickerOpen');
  const dtLabel     = $('#dtPickerLabel');
  const dtPicker    = $('#dtPicker');
  const dtBackdrop  = $('#dtBackdrop');
  const dtDate      = $('#dtPickerDate');
  const dtTime      = $('#dtPickerTime');
  const schOnceValue = $('#schOnceValue');

  function openDtPicker() {
    if (!dtDate.value) dtDate.value = new Date().toISOString().slice(0, 10);
    dtPicker.hidden = false;
    dtBackdrop.hidden = false;
  }
  function closeDtPicker() {
    dtPicker.hidden = true;
    dtBackdrop.hidden = true;
  }
  dtOpenBtn.addEventListener('click', openDtPicker);
  dtBackdrop.addEventListener('click', closeDtPicker);
  $('#dtPickerCancel').addEventListener('click', closeDtPicker);
  $('#dtPickerConfirm').addEventListener('click', () => {
    if (!dtDate.value || !dtTime.value) { closeDtPicker(); return; }
    dtLabel.textContent = `${dtDate.value}  ${dtTime.value}`;
    dtOpenBtn.classList.add('has-value');
    schOnceValue.value = `${dtDate.value}T${dtTime.value}`;
    closeDtPicker();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !dtPicker.hidden) closeDtPicker();
  });

  /* ============== 一鍵採購 / Step job runner ============== */
  let activeJobId = null;
  let pollTimer = null;
  const logbox      = $('#logbox');
  const logSummary  = $('#logSummary');
  const stopJobBtn  = $('#stopJobBtn');

  function setRunButtonsEnabled(enabled) {
    $('#indoExecuteBtn').disabled  = !enabled;
    $('#t1688ExecuteBtn').disabled = !enabled;
    $('#stepPreviewBtn').disabled  = !enabled;
    $('#stepExecuteBtn').disabled  = !enabled;
    const twAll = $('#twAllExecuteBtn'); if (twAll) twAll.disabled = !enabled;
    const twPbP = $('#twPbPreviewBtn'); if (twPbP) twPbP.disabled = !enabled;
  }

  function clearLogBox(box) {
    if (!box) box = logbox;
    box.textContent = '';
    if (box === logbox) logSummary.textContent = '';
  }

  function appendLog(box, logs) {
    if (!logs || !logs.length) return;
    // 首次注入時清除 "// no output..." placeholder
    if (box.firstChild && box.firstChild.nodeType === Node.TEXT_NODE) {
      box.textContent = '';
    }
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
    logs.forEach(l => {
      const cls = l.stream === 'stderr' ? 'stderr' : classifyLog(l.text);
      const node = document.createElement('div');
      node.textContent = l.text;
      if (cls && LOG_COLOR[cls]) node.style.color = LOG_COLOR[cls];
      if (cls === 'create') node.style.fontWeight = '600';
      box.appendChild(node);
    });
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function setBadge(badge, state) {
    if (!badge) return;
    const map = {
      running:   { text: '● 執行中',   cls: 'badge badge--dry' },
      done:      { text: '● 完成',     cls: 'badge badge--ghost' },
      failed:    { text: '● 失敗',     cls: 'badge badge--ghost' },
      cancelled: { text: '● 已停止',   cls: 'badge badge--ghost' },
      idle:      { text: '● 待執行',   cls: 'badge badge--ghost' },
    };
    const m = map[state] || map.idle;
    badge.textContent = m.text;
    badge.className = m.cls;
    if (state === 'failed') badge.style.color = 'var(--c-danger)';
    else badge.style.color = '';
  }

  async function startJob(params, opts = {}) {
    if (activeJobId) {
      alert('已有任務正在執行中,請先停止或等待完成');
      return;
    }
    const targetBox = opts.box || logbox;
    targetBox.textContent = '';
    appendLog(targetBox, [{ text: `[client] starting ${params.execute ? 'EXECUTE' : 'DRY-RUN'}...`, stream: 'stdout' }]);
    setRunButtonsEnabled(false);
    stopJobBtn.hidden = false;
    setBadge(opts.badge, 'running');

    try {
      const r = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'start failed');
      activeJobId = data.jobId;
      pollJob(targetBox, opts.badge);
    } catch (e) {
      appendLog(targetBox, [{ text: '[client error] ' + e.message, stream: 'stderr' }]);
      finishJob('failed', opts.badge);
    }
  }

  function pollJob(targetBox, badge) {
    if (!activeJobId) return;
    let since = 0;
    async function tick() {
      if (!activeJobId) return;
      try {
        const r = await fetch(`/api/job/${activeJobId}?since=${since}`);
        const data = await r.json();
        appendLog(targetBox, data.logs);
        since = data.totalLogs;
        if (targetBox === logbox) logSummary.textContent = `${data.totalLogs} lines`;
        if (data.state === 'running') {
          pollTimer = setTimeout(tick, 500);
        } else {
          appendLog(targetBox, [{ text: `[client] job ${data.state} (exit=${data.exitCode})`,
            stream: data.state === 'done' ? 'stdout' : 'stderr' }]);
          finishJob(data.state, badge);
          updateAnomalyBadge();
        }
      } catch (e) {
        appendLog(targetBox, [{ text: '[poll error] ' + e.message, stream: 'stderr' }]);
        finishJob('failed', badge);
      }
    }
    tick();
  }

  function finishJob(state, badge) {
    activeJobId = null;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    setRunButtonsEnabled(true);
    stopJobBtn.hidden = true;
    setBadge(badge, state);
  }

  stopJobBtn.addEventListener('click', async () => {
    if (!activeJobId) return;
    await fetch(`/api/stop/${activeJobId}`, { method: 'POST' });
  });
  $('#clearLogBtn').addEventListener('click', () => {
    logbox.textContent = '// no output. execute step to stream logs.';
    logSummary.textContent = '';
  });

  /* ============== Indo / 1688 execute ============== */
  $('#indoExecuteBtn').addEventListener('click', () => {
    const prefix = ($('#indoPlatformPrefix').value || '').toLowerCase();
    if (prefix.startsWith('1688')) {
      alert('Indo 卡的「採購平台前綴」是 1688-，請改用下面的「1688 採購建單」按鈕。');
      return;
    }
    const params = {
      step:        'purchase-create',
      workflow:    'indo',
      execute:     true,
      keyword:     'Indo',
      keywordType: 'Keyword',
      cardinality: $('#indoCardinality').value,
      percent:     $('#indoPercent').value,
      platform:    ($('#indoPlatformPrefix').value || '') + ($('#indoPlatformDest').value || ''),
    };
    if (!params.platform) {
      alert('採購平台不可空 — 請填入「採購平台前綴 + 寄送目的地」');
      return;
    }
    const msg =
      '即將在 ERP 實際建立 Indo 的採購單。\n\n' +
      `算式: ${params.cardinality} × ${params.percent}%\n` +
      `平台: ${params.platform}\n\n` +
      '確定要執行嗎?';
    if (!confirm(msg)) return;
    startJob(params);
  });

  $('#t1688ExecuteBtn').addEventListener('click', () => {
    const params = {
      step:        'purchase-create',
      workflow:    '1688',
      execute:     true,
      cardinality: $('#t1688Cardinality').value,
      percent:     $('#t1688Percent').value,
      platform:    ($('#t1688PlatformPrefix').value || '') + ($('#t1688PlatformDest').value || ''),
    };
    if (!params.platform) {
      alert('採購平台不可空 — 請填入「採購平台前綴 + 寄送目的地」');
      return;
    }
    const msg =
      '即將在 ERP 實際建立 1688 的採購單（含 SKSP 共同採購）。\n\n' +
      `算式: ${params.cardinality} × ${params.percent}%\n` +
      `平台: ${params.platform}\n\n` +
      '確定要執行嗎?';
    if (!confirm(msg)) return;
    startJob(params);
  });

  /* ============== 分步執行 (preview / execute) ============== */
  function bindPlatformKindSync(selectId, prefixId) {
    const sel = $('#' + selectId);
    const pre = $('#' + prefixId);
    sel.addEventListener('change', () => {
      pre.value = sel.value === '1688' ? '1688-' : 'indo-';
    });
  }
  bindPlatformKindSync('stepPlatformKind', 'stepPlatformPrefix');
  function setStepPlatformFields() {
    const isTw = $('#stepPlatformKind').value === 'tw';   // TW 不需平台前綴/目的地
    if ($('#stepPrefixField')) $('#stepPrefixField').hidden = isTw;
    if ($('#stepDestField')) $('#stepDestField').hidden = isTw;
  }
  $('#stepPlatformKind').addEventListener('change', setStepPlatformFields);
  setStepPlatformFields();

  function buildStepParams(execute) {
    const mainId = $('#stepMainId').value.trim();
    const platKind = $('#stepPlatformKind').value;
    const prefix   = ($('#stepPlatformPrefix').value || '').toLowerCase();
    const is1688   = platKind === '1688' || prefix.startsWith('1688');
    return {
      step:        'purchase-create',
      workflow:    is1688 ? '1688' : 'indo',
      execute,
      keyword:     mainId,
      keywordType: 'ProductCode',
      only:        mainId,
      cardinality: $('#stepCardinality').value,
      percent:     $('#stepPercent').value,
      threshold:   is1688 ? 3 : 6,
      platform:    ($('#stepPlatformPrefix').value || '') + ($('#stepPlatformDest').value || ''),
    };
  }

  // 把 TW Phase B 結果摘要寫進分步執行的 log box
  function twResultToLog(box, res, badge) {
    if (!res) return;
    if (res.error) {
      appendLog(box, [{ text: '!!! ' + res.error, stream: 'stderr' }]);
      if (badge) setBadge(badge, 'failed');
      return;
    }
    const lines = [`日期 ${res.date} · 單號 ${res.dateNo} · ERP 需求 ${res.joined} 項 · ${res.mode}`];
    ['IL', 'HS', 'IN'].forEach((v) => {
      const os = (res.orders && res.orders[v]) || [];
      if (!os.length) return;
      const tot = Math.round((res.vendorTotals && res.vendorTotals[v]) || 0);
      const low = (res.lowSales && res.lowSales[v]) || 0;
      const posted = res.posted && res.posted[v];
      lines.push(`${v}: ${os.length} 項 / $${tot}(低銷 ${low})` +
        (posted ? (posted.ok ? ' ✓ 已建單 ' + (posted.guid || '') : ' !!! 建單失敗 ' + (posted.err || posted.status || '')) : ''));
      os.forEach((o) => lines.push(`   ${String(o.key).replace(/\n/g, ' ')} = ${o.qty} 個 / $${o.amount}`));
    });
    if (res.unshippable && res.unshippable.length) {
      lines.push('訂不到 ' + res.unshippable.length + ':' + res.unshippable.map((u) => String(u.key).replace(/\n/g, ' ') + '(' + u.reason + ')').join(', '));
    }
    if (res.missingPrice && res.missingPrice.length) lines.push('缺單價 ' + res.missingPrice.length + ' 項');
    appendLog(box, lines.map((t) => ({ text: t, stream: 'stdout' })));
    if (badge) setBadge(badge, 'done');
  }

  function stepRunnerFactory(mode, badgeId, logId) {
    return () => {
      const mainId = $('#stepMainId').value.trim();
      if (!mainId) {
        alert('請先輸入主貨號 (MainId)');
        $('#stepMainId').focus();
        return;
      }
      const execute = (mode === 'execute');
      const box = $('#' + logId), badge = $('#' + badgeId);

      // TW 分步:走 /api/tw/purchase --only(Phase B,用 sheet 現有有貨試算/建單)
      if ($('#stepPlatformKind').value === 'tw') {
        if (activeJobId) { alert('已有任務執行中,請先停止或等待完成'); return; }
        if (execute && !confirm(`即將在【正式 ERP】建立 ${mainId} 的 TW 採購單(真單,事後要去 ERP 刪),確定?`)) return;
        box.textContent = '';
        appendLog(box, [{ text: `[client] TW 分步 ${execute ? '建單 (EXECUTE)' : '預覽 (DRY-RUN)'} — only ${mainId}`, stream: 'stdout' }]);
        setRunButtonsEnabled(false); stopJobBtn.hidden = false; setBadge(badge, 'running');
        fetch('/api/tw/purchase', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ only: mainId, ignoreLowSales: true, cardinality: $('#stepCardinality').value, percent: $('#stepPercent').value, execute }),
        }).then((r) => r.json()).then((data) => {
          if (!data.jobId) throw new Error(data.error || 'TW 失敗');
          activeJobId = data.jobId;
          pollTwJob(box, (res) => twResultToLog(box, res, badge));
        }).catch((e) => { appendLog(box, [{ text: '[client error] ' + e.message, stream: 'stderr' }]); finishJob('failed', badge); });
        return;
      }

      // Indo / 1688 分步(原邏輯)
      const params = buildStepParams(execute);
      if (execute) {
        if (!params.platform) { alert('採購平台不可空'); return; }
        if (!confirm(`即將在 ERP 建立 ${mainId} 的採購單,確定?`)) return;
      }
      startJob(params, { box, badge });
    };
  }
  $('#stepPreviewBtn').addEventListener('click', stepRunnerFactory('preview', 'stepPreviewBadge', 'stepPreviewLog'));
  $('#stepExecuteBtn').addEventListener('click', stepRunnerFactory('execute', 'stepExecuteBadge', 'stepExecuteLog'));

  /* ============== Anomaly tab ============== */
  let anomalyPollTimer = null;

  function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const pad = n => String(n).padStart(2, '0');
    if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return `${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function typeMeta(type) {
    switch (type) {
      case 'insufficient-quantity': return { label: '數量不足',     cls: 'tag--warn' };
      case 'stop-spec-skipped':     return { label: 'STOP 故沒訂購', cls: 'tag--warn' };
      case 'tw-no-stock':           return { label: 'TW 三家沒貨',   cls: 'tag--warn' };
      case 'tw-below-low-sales':    return { label: 'TW 湊不滿低銷', cls: 'tag--warn' };
      case 'tw-data-gap':           return { label: 'TW 資料缺漏',   cls: 'tag--warn' };
      default:                      return { label: type || '?',    cls: '' };
    }
  }

  function detectPlatformFromAnomaly(a) {
    if (a.platform) return a.platform;            // TW Phase B 直接帶 platform 欄
    const tags = Array.isArray(a.tags) ? a.tags : [];
    if (tags.some(t => /indo/i.test(t)))   return 'indo';
    if (tags.some(t => /1688/i.test(t)))   return '1688';
    if (tags.some(t => /^tw$/i.test(t)))   return 'tw';
    return '';
  }
  function platformLabel(kind) {
    return kind === '1688' ? '1688' : kind === 'indo' ? 'Indo' : kind === 'tw' ? 'TW' : '—';
  }

  function renderAnomalyItem(a) {
    const t = typeMeta(a.type);
    const platKind = detectPlatformFromAnomaly(a);
    const platTag = platKind ? `<span class="tag tag--plat">${platformLabel(platKind)}</span>` : '';
    const modeBadge = (a.mode || '') === 'execute'
      ? '<span class="badge" style="background:#fef2f2;color:#b91c1c;">EXECUTE</span>'
      : '<span class="badge badge--dry">DRY-RUN</span>';

    const detailBits = [];
    if (typeof a.rawSum === 'number' && typeof a.threshold === 'number') {
      detailBits.push(`加總 <code>${a.rawSum}</code> &lt; 門檻 <code>${a.threshold}</code>`);
    }
    if (a.specLabel) {
      const q = (a.suggestedQty !== undefined) ? `(建議 ${a.suggestedQty})` : '';
      detailBits.push(`規格 <code>${escapeHtml(a.specLabel)}</code>${q}`);
    }
    if (Array.isArray(a.specs) && a.specs.length) {
      const list = a.specs.map(s => `<code>${escapeHtml(s.label)} qty=${s.qty}</code>`).join(' · ');
      detailBits.push(`規格 ${list}`);
    }
    if (Array.isArray(a.tags) && a.tags.length) {
      detailBits.push(`tags <code>[${a.tags.map(escapeHtml).join(', ')}]</code>`);
    }

    const title = `${escapeHtml(a.mainId || '')}${a.productName ? ' · ' + escapeHtml(String(a.productName).slice(0, 80)) : ''}`;

    const li = document.createElement('li');
    li.className = 'record';
    li.innerHTML = `
      <div class="record__meta">
        <time>${fmtTime(a.time)}</time>
        <span class="tag ${t.cls}">${t.label}</span>
        ${platTag}
      </div>
      <div class="record__body">
        <p class="record__title">${title}</p>
        <p class="record__desc">${escapeHtml(a.message || '')}</p>
        ${detailBits.length ? `<p class="record__detail">${detailBits.join(' · ')}</p>` : ''}
      </div>
      ${modeBadge}
    `;
    return li;
  }

  async function loadAnomalies() {
    const params = new URLSearchParams();
    const type = $('#anomalyTypeFilter').value;
    const q    = $('#anomalySearch').value.trim();
    if (type) params.set('type', type);
    if (q)    params.set('q', q);
    try {
      const r = await fetch('/api/anomalies' + (params.toString() ? '?' + params.toString() : ''));
      const data = await r.json();
      let list = data.anomalies || [];

      // client-side platform filter (後端 anomaly 沒記 platform 維度,用 tags 猜)
      const platKind = $('#anomalyPlatformFilter').value;
      if (platKind) list = list.filter(a => detectPlatformFromAnomaly(a) === platKind);

      const container = $('#anomalyList');
      container.innerHTML = '';
      if (list.length === 0) {
        const empty = document.createElement('li');
        empty.style.listStyle = 'none';
        empty.style.textAlign = 'center';
        empty.style.padding = '40px 20px';
        empty.style.color = 'var(--c-text-mute)';
        empty.style.background = '#fff';
        empty.style.border = '1px dashed var(--c-border)';
        empty.style.borderRadius = '10px';
        empty.textContent = '尚無異常紀錄。執行採購任務後,數量不足 / STOP 故沒訂購會列在這裡。';
        container.appendChild(empty);
      } else {
        list.forEach(a => container.appendChild(renderAnomalyItem(a)));
      }
      $('#anomalyCount').innerHTML = `<b>${list.length}</b> 筆 <small>dry-run / execute 皆記錄</small>`;
      updateAnomalyBadge();
    } catch (e) {
      console.warn('loadAnomalies failed', e);
    }
  }

  async function updateAnomalyBadge() {
    try {
      const r = await fetch('/api/anomalies');
      const data = await r.json();
      const n = data.total || 0;
      const badge = $('#anomalyTabBadge');
      if (n > 0) {
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    } catch {}
  }

  function startAnomalyPoll() {
    stopAnomalyPoll();
    anomalyPollTimer = setInterval(loadAnomalies, 5000);
  }
  function stopAnomalyPoll() {
    if (anomalyPollTimer) { clearInterval(anomalyPollTimer); anomalyPollTimer = null; }
  }

  $('#anomalyRefreshBtn').addEventListener('click', loadAnomalies);
  $('#anomalyDownloadBtn').addEventListener('click', () => {
    const params = new URLSearchParams();
    const type = $('#anomalyTypeFilter').value;
    const q    = $('#anomalySearch').value.trim();
    if (type) params.set('type', type);
    if (q)    params.set('q', q);
    const a = document.createElement('a');
    a.href = '/api/anomalies.csv' + (params.toString() ? '?' + params.toString() : '');
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  ['#anomalyTypeFilter', '#anomalyPlatformFilter', '#anomalySearch'].forEach(s => {
    $(s).addEventListener('input', loadAnomalies);
    $(s).addEventListener('change', loadAnomalies);
  });

  /* ============== Schedule tab ============== */
  let editingScheduleId = null;
  const WEEKDAY_LABEL = ['日', '一', '二', '三', '四', '五', '六'];

  function fmtAbsTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtRel(ts) {
    if (!ts) return '—';
    const diff = ts - Date.now();
    const abs = Math.abs(diff);
    const m = Math.round(abs / 60000);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    const future = diff > 0;
    if (m < 1)  return future ? '即將' : '剛剛';
    if (m < 60) return `${m} 分鐘${future ? '後' : '前'}`;
    if (h < 24) return `${h} 小時${m % 60 ? ' ' + (m % 60) + ' 分' : ''}${future ? '後' : '前'}`;
    return `${d} 天${future ? '後' : '前'}`;
  }

  function platformKindFromOptions(opts) {
    if (!opts) return 'indo';
    // 優先看 workflow 欄位(新版排程都會帶);舊資料 fallback 從字串判
    if (opts.workflow === 'tw') return 'tw';
    if (opts.workflow === '1688') return '1688';
    if (opts.workflow === 'indo') return 'indo';
    const kw = (opts.keyword || '').toLowerCase();
    if (kw.includes('1688') || (opts.platform || '').toLowerCase().includes('1688')) return '1688';
    return 'indo';
  }

  function describeTrigger(s) {
    if (s.type === 'once') {
      return s.datetime ? `一次性 ${fmtAbsTime(new Date(s.datetime).getTime())}` : '一次性(未設定)';
    }
    if (s.type === 'weekly') {
      const days = Array.isArray(s.weekdays) && s.weekdays.length
        ? s.weekdays.slice().sort((a,b) => a - b).map(d => '週' + WEEKDAY_LABEL[d]).join('、')
        : '(未選日)';
      return `每${days} ${s.time || '--:--'}`;
    }
    return `每日 ${s.time || '--:--'}`;
  }

  async function loadSchedules() {
    try {
      const r = await fetch('/api/schedules');
      const data = await r.json();
      renderSchedules(data.schedules);
    } catch (e) { console.warn('loadSchedules failed', e); }
  }

  function renderSchedules(list) {
    const container = $('#scheduleList');
    container.innerHTML = '';
    if (!list || list.length === 0) {
      scheduleEmpty.hidden = false;
      return;
    }
    scheduleEmpty.hidden = true;
    list.forEach(s => container.appendChild(renderScheduleCard(s)));
  }

  function renderScheduleCard(s) {
    const opts = s.options || {};
    const platKind = platformKindFromOptions(opts);
    const lastRunText = s.lastRun
      ? `${fmtAbsTime(s.lastRun.finishedAt || s.lastRun.startedAt)} (${s.lastRun.state || 'unknown'})`
      : '尚未執行';

    const card = el('div', {
      class: 'card schedule-card' + (s.enabled ? '' : ' is-disabled'),
      style: { opacity: s.enabled ? '1' : '0.55' },
    });
    card.innerHTML = `
      <header class="card__head card__head--row">
        <div>
          <h3 class="card__title">
            <span class="plat-dot plat-dot--${platKind}"></span>
            ${escapeHtml(s.name || '(未命名)')}
          </h3>
          <p class="card__sub">${escapeHtml(describeTrigger(s))} · ${platformLabel(platKind)}</p>
        </div>
        <div class="card__actions">
          <span class="badge ${s.enabled ? 'badge--dry' : 'badge--ghost'}">${s.enabled ? '已啟用' : '已停用'}</span>
        </div>
      </header>
      <div class="grid grid--2" style="font-size:13px;color:var(--c-text-sub);">
        <div><b>採購條件</b><br><code style="font-family:var(--font-mono);background:var(--c-bg-soft);padding:1px 6px;border-radius:4px;">${escapeHtml(opts.cardinality || '')} × ${escapeHtml(String(opts.percent || ''))}%${platKind === 'tw' ? ' · TW(最近上傳的庫存)' : ' · 平台 "' + escapeHtml(opts.platform || '') + '"'}</code></div>
        <div><b>下次執行</b><br>${s.nextRun ? fmtAbsTime(s.nextRun) + ' (' + fmtRel(s.nextRun) + ')' : '—'}</div>
        <div><b>上次執行</b><br>${escapeHtml(lastRunText)}</div>
      </div>
      <div class="card__foot">
        <button class="btn btn--ghost btn--sm" data-action="run">立即執行</button>
        <button class="btn btn--ghost btn--sm" data-action="edit">編輯</button>
        <button class="btn btn--ghost btn--sm" data-action="toggle">${s.enabled ? '停用' : '啟用'}</button>
        <button class="btn btn--danger btn--sm" data-action="delete">刪除</button>
      </div>
    `;
    card.querySelector('[data-action="run"]').addEventListener('click', () => runScheduleNow(s.id));
    card.querySelector('[data-action="edit"]').addEventListener('click', () => openScheduleEditor(s));
    card.querySelector('[data-action="toggle"]').addEventListener('click', () => toggleSchedule(s.id, !s.enabled));
    card.querySelector('[data-action="delete"]').addEventListener('click', () => deleteSchedule(s.id, s.name));
    return card;
  }

  function openScheduleEditor(s) {
    editingScheduleId = s ? s.id : null;
    $('#scheduleFormTitle').textContent = s ? '編輯排程' : '新增排程';

    const opts = (s && s.options) || {};
    const platKind = platformKindFromOptions(opts);

    $('#schName').value         = s ? (s.name || '') : '';
    $('#schPlatformKind').value = platKind;
    $('#triggerType').value     = s ? (s.type || 'daily') : 'daily';

    $('#schDailyTime').value  = (s && s.type === 'daily'  && s.time) ? s.time : '09:00';
    $('#schWeeklyTime').value = (s && s.type === 'weekly' && s.time) ? s.time : '09:00';
    $$('#weekdayChips input[type=checkbox]').forEach(cb => {
      const wd = parseInt(cb.dataset.weekday, 10);
      cb.checked = (s && s.type === 'weekly' && Array.isArray(s.weekdays)) ? s.weekdays.includes(wd) : false;
    });

    schOnceValue.value = (s && s.type === 'once' && s.datetime) ? s.datetime : '';
    if (schOnceValue.value) {
      const m = schOnceValue.value.match(/^(\d{4}-\d{2}-\d{2})T?(\d{2}:\d{2})/);
      if (m) {
        dtDate.value = m[1];
        dtTime.value = m[2];
        dtLabel.textContent = `${m[1]}  ${m[2]}`;
        dtOpenBtn.classList.add('has-value');
      }
    } else {
      dtLabel.textContent = '點此選擇日期時間';
      dtOpenBtn.classList.remove('has-value');
    }

    $('#schCardinality').value    = opts.cardinality   || 'SalesCount30';
    $('#schPercent').value        = opts.percent       || 150;
    $('#schPlatformPrefix').value = opts.platformPrefix || (platKind === '1688' ? '1688-' : 'indo-');
    $('#schPlatformDest').value   = opts.platformDest   || 'Office';
    setSchPlatformFields(platKind);

    refreshTrigger();
    scheduleForm.hidden = false;
    scheduleEmpty.hidden = true;
    scheduleForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#schName').focus();
  }

  function closeScheduleEditor() {
    scheduleForm.hidden = true;
    editingScheduleId = null;
  }

  function setSchPlatformFields(kind) {
    const isTw = kind === 'tw';
    const pf = $('#schPrefixField'), df = $('#schDestField');
    if (pf) pf.hidden = isTw;            // TW 自建 TW-{廠商} 平台,不需前綴/目的地
    if (df) df.hidden = isTw;
    if (!isTw) $('#schPlatformPrefix').value = kind === '1688' ? '1688-' : 'indo-';
  }
  $('#schPlatformKind').addEventListener('change', () => setSchPlatformFields($('#schPlatformKind').value));

  $('#schSaveBtn').addEventListener('click', async () => {
    const platKind = $('#schPlatformKind').value;
    const type = $('#triggerType').value;

    let options;
    if (platKind === 'tw') {
      // TW 排程:用最近上傳的庫存快取 → 分配 + 建單(不需平台前綴/目的地)
      options = {
        execute:     true,
        workflow:    'tw',
        cardinality: $('#schCardinality').value,
        percent:     $('#schPercent').value,
      };
    } else {
      const prefix = $('#schPlatformPrefix').value.trim();
      const dest   = $('#schPlatformDest').value.trim();
      const platform = prefix + dest;
      if (!platform) { alert('採購平台不可空'); return; }
      // 防呆：下拉跟前綴必須一致
      const is1688 = platKind === '1688' || prefix.toLowerCase().startsWith('1688');
      if (is1688 && platKind !== '1688') { alert('前綴是 1688- 但平台下拉選的是 Indo,請統一(改下拉或改前綴)。'); return; }
      if (!is1688 && platKind === '1688') { alert('平台下拉選 1688 但前綴不是 1688-,請統一(改下拉或改前綴)。'); return; }
      options = {
        execute:     true,
        workflow:    is1688 ? '1688' : 'indo',
        keyword:     is1688 ? '' : 'Indo',
        keywordType: is1688 ? 'ALL' : 'Keyword',
        cardinality: $('#schCardinality').value,
        percent:     $('#schPercent').value,
        platform,
        platformPrefix: prefix,
        platformDest:   dest,
      };
    }

    const payload = {
      name: $('#schName').value.trim() || '未命名排程',
      type,
      enabled: true,
      options,
    };
    if (type === 'daily')  payload.time = $('#schDailyTime').value;
    if (type === 'weekly') {
      payload.time = $('#schWeeklyTime').value;
      payload.weekdays = $$('#weekdayChips input[type=checkbox]')
        .filter(cb => cb.checked)
        .map(cb => parseInt(cb.dataset.weekday, 10));
      if (payload.weekdays.length === 0) { alert('請至少選一天'); return; }
    }
    if (type === 'once') {
      if (!schOnceValue.value) { alert('請選擇執行日期時間'); return; }
      payload.datetime = schOnceValue.value;
    }

    const isEdit = !!editingScheduleId;
    const url = isEdit ? `/api/schedules/${editingScheduleId}` : '/api/schedules';
    const method = isEdit ? 'PATCH' : 'POST';
    try {
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'save failed');
      closeScheduleEditor();
      loadSchedules();
    } catch (e) { alert('儲存失敗:' + e.message); }
  });

  async function toggleSchedule(id, enabled) {
    await fetch(`/api/schedules/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    loadSchedules();
  }
  async function deleteSchedule(id, name) {
    if (!confirm(`確定刪除排程「${name}」?此操作無法復原。`)) return;
    await fetch(`/api/schedules/${id}`, { method: 'DELETE' });
    loadSchedules();
  }
  async function runScheduleNow(id) {
    if (!confirm('立即執行此排程?\n會以排程設定的模式觸發 (含 EXECUTE)。')) return;
    const r = await fetch(`/api/schedules/${id}/run`, { method: 'POST' });
    if (r.ok) alert('已觸發。請到「智能採購建單」頁面看執行 LOG,或稍後重新整理本頁看執行結果。');
    else alert('觸發失敗');
    setTimeout(loadSchedules, 2000);
  }

  /* ============== TW 庫存比對 ============== */
  const TW_ADMIN_KEY = 'tw-admin-defaults-v1';
  const TW_DEFAULTS = { showUnmatched: '0', allowExecute: '1' };
  function loadTwDefaults() {
    try { return { ...TW_DEFAULTS, ...JSON.parse(localStorage.getItem(TW_ADMIN_KEY) || '{}') }; }
    catch { return { ...TW_DEFAULTS }; }
  }
  function saveTwDefaults(d) { try { localStorage.setItem(TW_ADMIN_KEY, JSON.stringify(d)); } catch {} }

  function applyTwDefaults() {
    const d = loadTwDefaults();
    const su = $('#twAdminShowUnmatched'); if (su) su.value = d.showUnmatched;
    const ae = $('#twAdminAllowExecute');  if (ae) ae.value = d.allowExecute;
    // 員工一鍵卡:依「允許員工執行」顯示/隱藏執行鈕(關掉則只剩管理員預覽可測)
    const allBtn = $('#twAllExecuteBtn');
    if (allBtn) allBtn.hidden = (d.allowExecute !== '1');
  }

  function bindTwFile(inputId, textId) {
    const inp = $('#' + inputId), txt = $('#' + textId);
    if (!inp) return;
    inp.addEventListener('change', () => {
      const n = inp.files.length;
      txt.textContent = n === 0 ? '點此選擇檔案'
        : (n === 1 ? inp.files[0].name : `已選 ${n} 個檔案`);
      const zone = txt.closest('.filezone');
      if (zone) zone.classList.toggle('has-files', n > 0);
    });
  }
  bindTwFile('twFileIL', 'twFileILText');
  bindTwFile('twFileHS', 'twFileHSText');
  bindTwFile('twFileIN', 'twFileINText');

  // 員工一鍵全流程結果:Phase A(打勾)+ Phase B(分配/建單/回填/異常)
  function renderTwAllResult(res) {
    const box = $('#twAllResult');
    if (!box || !res) return;
    if (res.error) {
      box.innerHTML = `<div class="tw-result__head"><span class="badge" style="background:#fef2f2;color:#b91c1c;">錯誤</span> ${escapeHtml(res.error)}</div>`;
      box.hidden = false; return;
    }
    const a = res.phaseA;
    let html = `<div class="tw-result__head"><span class="badge" style="background:#fef2f2;color:#b91c1c;">EXECUTE</span> <b>${escapeHtml(res.date || '')}</b> · 單號 ${escapeHtml(res.dateNo || '')} · ERP 需求 ${res.joined} 項</div>`;
    if (a && a.matched) {
      html += `<p class="tw-result__cols">① 庫存比對${a.usedCache ? '<b>(沿用上次庫存)</b>' : ''}:有貨打勾 IL <code>${a.matched.IL}</code> / HS <code>${a.matched.HS}</code> / IN <code>${a.matched.IN}</code>(寫入 ${a.written_cells || 0} 格)</p>`;
    }
    html += '<div class="tw-result__grid">';
    ['IL', 'HS', 'IN'].forEach(v => {
      const total = Math.round((res.vendorTotals && res.vendorTotals[v]) || 0);
      const low = (res.lowSales && res.lowSales[v]) || 0;
      const n = (res.orders && res.orders[v] && res.orders[v].length) || 0;
      const posted = res.posted && res.posted[v];
      const tag = posted
        ? (posted.ok ? '<span class="badge badge--dry">已建單</span>' : '<span class="badge" style="background:#fef2f2;color:#b91c1c;">建單失敗</span>')
        : (n && total < low ? '<span class="tag tag--warn">未達低銷</span>' : '');
      html += `<div class="tw-stat"><span class="tw-stat__v">${n}</span><span class="tw-stat__k">${v} 採購單 ${tag}</span><small>金額 ${total} / 低銷 ${low}</small></div>`;
    });
    html += '</div>';
    if (res.writeback) html += `<p class="tw-result__cols">② 回填 sheet:${res.writeback.written_cells || 0} 格(需求量 / 採購量)</p>`;
    if (res.unshippable && res.unshippable.length) {
      const noStock = res.unshippable.filter(u => u.reason === 'no-stock').length;
      const below = res.unshippable.filter(u => u.reason === 'below-low-sales').length;
      html += `<p class="tw-result__cols">訂不到 ${res.unshippable.length}(三家沒貨 ${noStock} · 湊不滿低銷 ${below})· 已記異常 ${res.anomaliesWritten || 0} 筆</p>`;
    }
    if (res.missingPrice && res.missingPrice.length) {
      html += `<p class="tw-result__cols">⚠ 有貨但缺單價 ${res.missingPrice.length} 項(影響湊低銷,建議補 sheet 單價)</p>`;
    }
    const okv = ['IL', 'HS', 'IN'].filter(v => res.posted && res.posted[v] && res.posted[v].ok);
    if (okv.length) html += `<p class="tw-result__cols">✓ 已建採購單:${okv.map(v => 'TW-' + v + ' ' + res.dateNo).join('、')}</p>`;
    box.innerHTML = html;
    box.hidden = false;
  }

  function pollTwJob(box, onResult) {
    if (!activeJobId) return;
    let since = 0;
    async function tick() {
      if (!activeJobId) return;
      try {
        const r = await fetch(`/api/job/${activeJobId}?since=${since}`);
        const data = await r.json();
        appendLog(box, data.logs);
        since = data.totalLogs;
        if (data.state === 'running') {
          pollTimer = setTimeout(tick, 600);
        } else {
          appendLog(box, [{ text: `[client] job ${data.state} (exit=${data.exitCode})`, stream: data.state === 'done' ? 'stdout' : 'stderr' }]);
          if (data.result && typeof onResult === 'function') onResult(data.result);
          finishJob(data.state, null);
        }
      } catch (e) {
        appendLog(box, [{ text: '[poll error] ' + e.message, stream: 'stderr' }]);
        finishJob('failed', null);
      }
    }
    tick();
  }

  // 員工一鍵:上傳三廠商檔 → 全流程(比對打勾 → 分配 → 建單 → 回填 → 異常),直接 EXECUTE
  async function runTwAll() {
    if (activeJobId) { alert('已有任務正在執行中,請先停止或等待完成'); return; }
    const il = $('#twFileIL').files, hs = $('#twFileHS').files, ins = $('#twFileIN').files;
    const total = il.length + hs.length + ins.length;
    const msg = total === 0
      ? '這次沒有上傳新庫存檔 → 將沿用「上次的庫存」直接跑採購建單(免重新比對)。\n確定執行?(若庫存有更新,請先上傳檔案)'
      : `已選 ${total} 個檔(會更新本週庫存)。即將跑完整 TW 採購流程並【實際建立採購單】。\n確定執行?`;
    if (!confirm(msg)) return;

    const box = $('#twAllLog');
    box.textContent = '';
    appendLog(box, [{ text: `[client] ${total === 0 ? '沿用上次庫存' : '上傳 ' + total + ' 檔'},執行 TW 採購建單(全流程)...`, stream: 'stdout' }]);
    $('#twAllResult').hidden = true;
    setRunButtonsEnabled(false);
    stopJobBtn.hidden = false;

    const fd = new FormData();
    for (const f of il) fd.append('IL', f);
    for (const f of hs) fd.append('HS', f);
    for (const f of ins) fd.append('IN', f);
    fd.append('date', $('#twAllDate').value.trim());
    fd.append('cardinality', $('#twAllCardinality').value);
    fd.append('percent', $('#twAllPercent').value);
    fd.append('execute', 'true');

    try {
      const r = await fetch('/api/tw/run-all', { method: 'POST', body: fd });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'TW 執行失敗');
      activeJobId = data.jobId;
      pollTwJob(box, renderTwAllResult);
    } catch (e) {
      appendLog(box, [{ text: '[client error] ' + e.message, stream: 'stderr' }]);
      finishJob('failed', null);
    }
  }

  $('#twAllExecuteBtn').addEventListener('click', runTwAll);

  /* ====== TW Phase B:採購分配 + 建單 ====== */
  function renderTwPbResult(res) {
    const box = $('#twPbResult');
    if (!box || !res) return;
    if (res.error) {
      box.innerHTML = `<div class="tw-result__head"><span class="badge" style="background:#fef2f2;color:#b91c1c;">錯誤</span> ${escapeHtml(res.error)}</div>`;
      box.hidden = false; return;
    }
    const showUnmatched = loadTwDefaults().showUnmatched === '1';
    const modeBadge = res.mode === 'execute'
      ? '<span class="badge" style="background:#fef2f2;color:#b91c1c;">EXECUTE</span>'
      : '<span class="badge badge--dry">DRY-RUN</span>';
    let html = `<div class="tw-result__head">${modeBadge} <b>${escapeHtml(res.date || '')}</b> · 單號 ${escapeHtml(res.dateNo || '')} · ERP 需求 ${res.joined} 項</div>`;
    html += '<div class="tw-result__grid">';
    ['IL', 'HS', 'IN'].forEach(v => {
      const total = Math.round((res.vendorTotals && res.vendorTotals[v]) || 0);
      const low = (res.lowSales && res.lowSales[v]) || 0;
      const n = (res.orders && res.orders[v] && res.orders[v].length) || 0;
      const ok = total >= low && n > 0;
      const poInfo = res.po && res.po[v];
      const posted = res.posted && res.posted[v];
      const tag = posted
        ? (posted.ok ? '<span class="badge badge--dry">已建單</span>' : '<span class="badge" style="background:#fef2f2;color:#b91c1c;">建單失敗</span>')
        : (n && !ok ? '<span class="tag tag--warn">未達低銷</span>' : '');
      html += `<div class="tw-stat"><span class="tw-stat__v" style="${ok || posted ? '' : 'color:#b45309;'}">${n}</span>`
        + `<span class="tw-stat__k">${v} 採購單 ${tag}</span>`
        + `<small>金額 ${total} / 低銷 ${low}${poInfo ? (' · ' + poInfo.totalQty + '個') : ''}</small></div>`;
    });
    html += '</div>';
    if (res.unshippable && res.unshippable.length) {
      const noStock = res.unshippable.filter(u => u.reason === 'no-stock').length;
      const below = res.unshippable.filter(u => u.reason === 'below-low-sales').length;
      html += `<p class="tw-result__cols">訂不到 ${res.unshippable.length} 項:三家沒貨 ${noStock} · 湊不滿低銷 ${below}</p>`;
    }
    if (res.missingPrice && res.missingPrice.length) {
      html += `<p class="tw-result__cols">⚠ 有貨但缺單價 ${res.missingPrice.length} 項(影響湊低銷,建議補 sheet 單價)</p>`;
    }
    if (showUnmatched) {
      if (res.unjoinedCount) {
        const s = res.unjoinedSample || [];
        html += `<details class="tw-unmatched"><summary>ERP 有需求但 sheet 無對映(${res.unjoinedCount},顯示前 ${s.length})</summary><div>${s.map(escapeHtml).join('、')}</div></details>`;
      }
      if (res.missingPrice && res.missingPrice.length) {
        html += `<details class="tw-unmatched"><summary>缺單價明細(${res.missingPrice.length})</summary><div>${res.missingPrice.map(m => escapeHtml(m.product + '(' + m.vendor + ')')).join('、')}</div></details>`;
      }
    }
    box.innerHTML = html;
    box.hidden = false;
  }

  // 管理員測試:分配預覽(dry-run,不上傳、不建單;用 sheet 目前有貨狀態試算)
  async function twPbPreview() {
    if (activeJobId) { alert('已有任務正在執行中,請先停止或等待完成'); return; }
    const box = $('#twPbLog');
    box.textContent = '';
    appendLog(box, [{ text: '[client] TW 分配預覽 (DRY-RUN) ...', stream: 'stdout' }]);
    $('#twPbResult').hidden = true;
    setRunButtonsEnabled(false);
    stopJobBtn.hidden = false;
    try {
      const r = await fetch('/api/tw/purchase', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: $('#twPbDate').value.trim(),
          cardinality: $('#twPbCardinality').value,
          percent: $('#twPbPercent').value,
          execute: false,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'TW 預覽失敗');
      activeJobId = data.jobId;
      pollTwJob(box, renderTwPbResult);
    } catch (e) {
      appendLog(box, [{ text: '[client error] ' + e.message, stream: 'stderr' }]);
      finishJob('failed', null);
    }
  }

  $('#twPbPreviewBtn').addEventListener('click', twPbPreview);

  const twAdminSaveBtn = $('#twAdminSaveBtn');
  if (twAdminSaveBtn) {
    twAdminSaveBtn.addEventListener('click', () => {
      saveTwDefaults({
        showUnmatched: $('#twAdminShowUnmatched').value,
        allowExecute: $('#twAdminAllowExecute').value,
      });
      applyTwDefaults();
      alert('TW 設定已儲存。「智能採購建單 → TW 庫存比對卡」已套用。');
    });
  }

  /* ============== Boot ============== */
  applyAdminDefaultsToForms();
  applyTwDefaults();
  // TW 欄組日期預填今天(YY/MM/DD);helper 留空也會用今天
  (function () {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    const today = `${p(d.getFullYear() % 100)}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
    if ($('#twAllDate')) $('#twAllDate').value = today;
    if ($('#twPbDate')) $('#twPbDate').value = today;
    // 需求算式/倍率沿用管理員預設(員工一鍵卡 + 管理員預覽卡)
    const ad = loadAdminDefaults();
    ['twAll', 'twPb'].forEach((pfx) => {
      const c = $('#' + pfx + 'Cardinality'); if (c) c.value = ad.cardinality;
      const pc = $('#' + pfx + 'Percent'); if (pc) pc.value = ad.percent;
    });
  })();
  refreshTrigger();
  updateAnomalyBadge();
  setInterval(updateAnomalyBadge, 15000);

  let savedAdminMode = false;
  try { savedAdminMode = localStorage.getItem(ADMIN_MODE_KEY) === '1'; } catch {}
  if (savedAdminMode) setAdmin(true);

})();
