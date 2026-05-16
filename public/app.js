// app.js — 智能採購控制台前端
(() => {
  'use strict';

  let activeJobId = null;
  let pollTimer = null;

  /* ========== DOM helpers ========== */
  function $(sel, parent = document) { return parent.querySelector(sel); }
  function $$(sel, parent = document) { return Array.from(parent.querySelectorAll(sel)); }
  function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === 'class') e.className = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k === 'style') Object.assign(e.style, v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v);
    });
    if (typeof children === 'string') e.textContent = children;
    else if (Array.isArray(children)) children.forEach((c) => c && e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return e;
  }
  function classifyLogLine(text) {
    if (/\[CREATE\]/.test(text)) return 'log-line--create';
    if (/\[SKIP/.test(text))     return 'log-line--skip';
    if (/✓|Success|completed|done$/i.test(text)) return 'log-line--success';
    if (/⚠|WARN/.test(text))    return 'log-line--warn';
    if (/\bERROR\b|\bFATAL\b|!!!/i.test(text)) return 'log-line--stderr';
    return '';
  }

  /* ========== Tab 切換 ========== */
  $$('.tabs--top .tab').forEach((t) => {
    t.addEventListener('click', () => {
      const target = t.dataset.tab;
      $$('.tabs--top .tab').forEach((x) => x.classList.toggle('is-active', x === t));
      $$('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.id === 'tab-' + target));
      if (target === 'schedule')  loadSchedules();
      if (target === 'anomalies') { loadAnomalies(); startAnomalyPoll(); }
      else stopAnomalyPoll();
    });
  });

  /* ========== Sub-tab 切換（智能採購內部）========== */
  $$('.tabs--sub .tab').forEach((t) => {
    t.addEventListener('click', () => {
      const target = t.dataset.subtab;
      if (!target) return;
      const group = t.parentElement;
      $$('.tab', group).forEach((x) => x.classList.toggle('is-active', x === t));
      const panelParent = group.parentElement;
      $$('.sub-panel', panelParent).forEach((p) => p.classList.toggle('is-active', p.id === 'subtab-' + target));
    });
  });

  /* ========== 採購平台組字串預覽（一鍵完成）========== */
  function updatePlatformPreview() {
    const prefix = $('#platformPrefix').value || '';
    const dest = $('#platformDest').value || '';
    $('#platformPreview').value = prefix + dest;
  }
  $('#platformPrefix').addEventListener('input', updatePlatformPreview);
  $('#platformDest').addEventListener('input', updatePlatformPreview);
  updatePlatformPreview();

  /* ========== 採購平台組字串預覽（分步執行）========== */
  function updateStepPlatformPreview() {
    const prefix = $('#stepPlatformPrefix').value || '';
    const dest = $('#stepPlatformDest').value || '';
    $('#stepPlatformPreview').value = prefix + dest;
  }
  $('#stepPlatformPrefix').addEventListener('input', updateStepPlatformPreview);
  $('#stepPlatformDest').addEventListener('input', updateStepPlatformPreview);
  updateStepPlatformPreview();

  /* ========== 通用 view（一鍵 vs 分步共用 run 邏輯）========== */

  function makeOneClickView() {
    return {
      name: 'oneclick',
      statusPill: $('#runStatus'),
      logPanel:   $('#logPanel'),
      logSummary: $('#logSummary'),
      buttons: [$('#btnDryRun'), $('#btnExecute')],
      stopBtn: $('#btnStop'),
    };
  }

  function makeStepView(stepCard) {
    return {
      name: 'step:' + stepCard.dataset.stepId,
      statusPill: $('[data-role="status"]', stepCard),
      statusLabel: $('[data-role="status-label"]', stepCard),
      logPanel:   $('[data-role="log"]', stepCard),
      logSummary: null,
      buttons: $$('[data-step-action]', stepCard).filter((b) => b.dataset.stepAction !== 'stop'),
      stopBtn: $('[data-step-action="stop"]', stepCard),
    };
  }

  function setViewStatus(view, state, label) {
    const pill = view.statusPill;
    if (!pill) return;
    pill.className = 'status status--' + state;
    if (view.statusLabel) {
      view.statusLabel.textContent = label;
    } else {
      pill.innerHTML = `<span class="status__dot"></span>${label}`;
    }
  }

  function appendLogTo(view, logs) {
    if (!logs || !logs.length) return;
    const log = view.logPanel;
    const wasAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    logs.forEach((l) => {
      const cls = 'log-line' + (l.stream === 'stderr' ? ' log-line--stderr' : ' ' + classifyLogLine(l.text));
      log.appendChild(el('div', { class: cls }, l.text));
    });
    if (wasAtBottom) log.scrollTop = log.scrollHeight;
  }

  /* ========== 一鍵完成：收集表單 ========== */
  function collectOneClickParams(execute) {
    return {
      step: 'purchase-create',
      execute: !!execute,
      keyword:     $('#keyword').value.trim(),
      keywordType: $('#keywordType').value,
      cardinality: $('#cardinality').value,
      percent:     $('#percent').value,
      platform:    $('#platformPreview').value,
    };
  }

  /* ========== 分步執行：收集表單 ========== */
  function collectStepParams(execute) {
    const mainId = $('#stepMainId').value.trim();
    return {
      step: 'purchase-create',
      execute: !!execute,
      // 用主貨號當 keyword + ProductCode 搜尋（server-side 精準過濾）
      keyword:     mainId,
      keywordType: 'ProductCode',
      // 同時加 --only 做 client-side 二次過濾（雙保險）
      only:        mainId,
      cardinality: $('#stepCardinality').value,
      percent:     $('#stepPercent').value,
      platform:    $('#stepPlatformPreview').value,
    };
  }

  function refreshModeBadge() {
    const badge = $('#modeBadge');
    if (window.__lastWasExecute) {
      badge.textContent = 'EXECUTE MODE';
      badge.style.background = '#fef2f2'; badge.style.color = '#b91c1c'; badge.style.borderColor = '#fecaca';
    } else {
      badge.textContent = 'DRY-RUN MODE';
      badge.style.background = ''; badge.style.color = ''; badge.style.borderColor = '';
    }
  }

  async function startRun(view, params, execute) {
    if (activeJobId) { alert('已有任務正在執行中，請先停止或等待完成'); return; }

    if (execute && !params.platform) {
      alert('採購平台不可空 — 請填入「採購平台前綴 + 寄送目的地」');
      return;
    }
    if (execute) {
      const onlyText = params.only ? `\n限定貨號: ${params.only}` : '';
      const msg = `WARNING — EXECUTE 模式會實際在 ERP 建立採購單。\n\n` +
                  `關鍵字: ${params.keyword || '(空)'} (${params.keywordType})\n` +
                  `算式: ${params.cardinality} × ${params.percent}%\n` +
                  `平台: ${params.platform}` + onlyText +
                  `\n\n確定執行？`;
      if (!confirm(msg)) return;
    }

    view.logPanel.innerHTML = '';
    appendLogTo(view, [{ text: `[client] starting ${execute ? 'EXECUTE' : 'DRY-RUN'} (${view.name})...`, stream: 'stdout' }]);
    setViewStatus(view, 'running', execute ? 'EXECUTE' : 'DRY-RUN');
    view.buttons.forEach((b) => { b.disabled = true; });
    if (view.stopBtn) view.stopBtn.style.display = '';
    window.__lastWasExecute = execute;
    refreshModeBadge();

    try {
      const r = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'start failed');
      activeJobId = data.jobId;
      pollJob(view);
    } catch (e) {
      appendLogTo(view, [{ text: '[client error] ' + e.message, stream: 'stderr' }]);
      finishRun(view, 'failed', '失敗');
    }
  }

  function pollJob(view) {
    if (!activeJobId) return;
    let since = 0;
    async function tick() {
      if (!activeJobId) return;
      try {
        const r = await fetch(`/api/job/${activeJobId}?since=${since}`);
        const data = await r.json();
        appendLogTo(view, data.logs);
        since = data.totalLogs;
        if (view.logSummary) view.logSummary.textContent = `${data.totalLogs} lines`;
        if (data.state === 'running') {
          pollTimer = setTimeout(tick, 500);
        } else {
          appendLogTo(view, [{ text: `[client] job ${data.state} (exit=${data.exitCode})`,
                              stream: data.state === 'done' ? 'stdout' : 'stderr' }]);
          finishRun(view, data.state, data.state);
        }
      } catch (e) {
        appendLogTo(view, [{ text: '[poll error] ' + e.message, stream: 'stderr' }]);
        finishRun(view, 'failed', '失敗');
      }
    }
    tick();
  }

  function finishRun(view, state, label) {
    activeJobId = null;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    setViewStatus(view, state, label);
    view.buttons.forEach((b) => { b.disabled = false; });
    if (view.stopBtn) view.stopBtn.style.display = 'none';
  }

  /* ========== 一鍵完成 binding ========== */
  $('#btnDryRun').addEventListener('click', () => startRun(makeOneClickView(), collectOneClickParams(false), false));
  $('#btnExecute').addEventListener('click', () => startRun(makeOneClickView(), collectOneClickParams(true),  true));
  $('#btnStop').addEventListener('click', async () => {
    if (!activeJobId) return;
    await fetch(`/api/stop/${activeJobId}`, { method: 'POST' });
  });
  $('#btnClearLog').addEventListener('click', () => {
    $('#logPanel').innerHTML = '';
    $('#logSummary').textContent = '';
  });

  /* ========== 分步執行 binding ========== */
  $$('.step[data-step-id]').forEach((card) => {
    const view = makeStepView(card);
    $$('[data-step-action]', card).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.stepAction;
        if (action === 'stop') {
          if (!activeJobId) return;
          await fetch(`/api/stop/${activeJobId}`, { method: 'POST' });
          return;
        }
        const mainId = $('#stepMainId').value.trim();
        if (!mainId) {
          alert('請先輸入主貨號 (MainId)');
          $('#stepMainId').focus();
          return;
        }
        const execute = (action === 'execute');
        startRun(makeStepView(card), collectStepParams(execute), execute);
      });
    });
  });

  /* ========== Schedule tab ========== */
  let editingScheduleId = null;
  function fmtRelativeTime(ts) {
    if (!ts) return '—';
    const diff = ts - Date.now();
    const abs = Math.abs(diff);
    const m = Math.round(abs / 60000);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    const future = diff > 0;
    if (m < 1) return future ? '即將' : '剛剛';
    if (m < 60) return `${m} 分鐘${future ? '後' : '前'}`;
    if (h < 24) return `${h} 小時${m % 60 ? ' ' + (m % 60) + ' 分' : ''}${future ? '後' : '前'}`;
    return `${d} 天${future ? '後' : '前'}`;
  }
  function fmtAbsoluteTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }
  async function loadSchedules() {
    const r = await fetch('/api/schedules');
    const data = await r.json();
    renderSchedules(data.schedules);
  }
  function renderSchedules(list) {
    const c = $('#scheduleList');
    c.innerHTML = '';
    if (!list || list.length === 0) {
      c.appendChild(el('div', { class: 'schedule-empty' }, '尚無排程。點「+ 新增排程」建立第一個自動執行任務。'));
      return;
    }
    list.forEach((s) => c.appendChild(renderScheduleCard(s)));
  }
  function renderScheduleCard(s) {
    const card = el('div', { class: 'schedule-card' + (s.enabled ? '' : ' is-disabled') });
    const statusClass = s.enabled ? 'status--running' : 'status--idle';
    const statusLabel = s.enabled ? '已啟用' : '已停用';
    const lastRunText = s.lastRun ? `${fmtAbsoluteTime(s.lastRun.finishedAt || s.lastRun.startedAt)} (${s.lastRun.state || 'unknown'})` : '尚未執行';
    const triggerText = s.type === 'daily' ? `每日 ${s.time || '--:--'}` : `一次性 ${s.datetime ? fmtAbsoluteTime(new Date(s.datetime).getTime()) : '--'}`;
    const opts = s.options || {};
    const condText = `${opts.keywordType || 'Keyword'}=${opts.keyword || '(空)'}  ${opts.cardinality || '?'} × ${opts.percent || '?'}%`;
    const modeText = opts.execute ? 'EXECUTE' : 'DRY-RUN';

    card.innerHTML = `
      <div class="schedule-card__head">
        <span class="status ${statusClass}"><span class="status__dot"></span>${statusLabel}</span>
        <h3 class="schedule-card__name"></h3>
      </div>
      <div class="schedule-card__meta">
        <div><strong>條件</strong><code></code></div>
        <div><strong>採購平台</strong><code></code></div>
        <div><strong>觸發</strong><code></code></div>
        <div><strong>模式</strong><code></code></div>
        <div><strong>下次執行</strong><code></code></div>
        <div><strong>上次執行</strong><code></code></div>
      </div>
    `;
    card.querySelector('.schedule-card__name').textContent = s.name;
    const codes = card.querySelectorAll('code');
    codes[0].textContent = condText;
    codes[1].textContent = opts.platform || '—';
    codes[2].textContent = triggerText;
    codes[3].textContent = modeText;
    codes[4].textContent = s.nextRun ? `${fmtAbsoluteTime(s.nextRun)} (${fmtRelativeTime(s.nextRun)})` : '—';
    codes[5].textContent = lastRunText;

    const actions = el('div', { class: 'schedule-card__actions' }, [
      el('button', { class: 'btn btn--ghost', onclick: () => runScheduleNow(s.id) }, '立即執行'),
      el('button', { class: 'btn btn--ghost', onclick: () => editSchedule(s) }, '編輯'),
      el('button', { class: 'btn btn--ghost', onclick: () => toggleSchedule(s.id, !s.enabled) }, s.enabled ? '停用' : '啟用'),
      el('button', { class: 'btn btn--danger', onclick: () => deleteSchedule(s.id, s.name) }, '刪除'),
    ]);
    card.appendChild(actions);
    return card;
  }
  function openEditor(s) {
    editingScheduleId = s?.id || null;
    const opts = s?.options || {};
    $('#schName').value = s?.name || '';
    $('#schType').value = s?.type || 'daily';
    $('#schTime').value = s?.time || '09:00';
    $('#schDatetime').value = s?.datetime || '';
    $('#schKeywordType').value = opts.keywordType || 'Keyword';
    $('#schKeyword').value = opts.keyword || '';
    $('#schCardinality').value = opts.cardinality || 'SalesCount30';
    $('#schPercent').value = opts.percent ?? 150;
    $('#schPlatform').value = opts.platform || '';
    $('#schExecute').checked = !!opts.execute;
    onTypeChange();
    $('#scheduleEditor').style.display = '';
    $('#schName').focus();
  }
  function closeEditor() { editingScheduleId = null; $('#scheduleEditor').style.display = 'none'; }
  function onTypeChange() {
    const t = $('#schType').value;
    $('#schTimeField').style.display = t === 'daily' ? '' : 'none';
    $('#schDatetimeField').style.display = t === 'once' ? '' : 'none';
  }
  async function saveSchedule() {
    const payload = {
      name: $('#schName').value.trim() || '未命名排程',
      type: $('#schType').value,
      time: $('#schTime').value,
      datetime: $('#schDatetime').value,
      enabled: true,
      options: {
        execute:     $('#schExecute').checked,
        keywordType: $('#schKeywordType').value,
        keyword:     $('#schKeyword').value.trim(),
        cardinality: $('#schCardinality').value,
        percent:     $('#schPercent').value,
        platform:    $('#schPlatform').value.trim(),
      },
    };
    const isEdit = !!editingScheduleId;
    const url = isEdit ? `/api/schedules/${editingScheduleId}` : '/api/schedules';
    const method = isEdit ? 'PATCH' : 'POST';
    try {
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'save failed');
      closeEditor(); loadSchedules();
    } catch (e) { alert('儲存失敗：' + e.message); }
  }
  async function editSchedule(s) { openEditor(s); }
  async function toggleSchedule(id, enabled) {
    await fetch(`/api/schedules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
    loadSchedules();
  }
  async function deleteSchedule(id, name) {
    if (!confirm(`確定刪除排程「${name}」？此操作無法復原。`)) return;
    await fetch(`/api/schedules/${id}`, { method: 'DELETE' });
    loadSchedules();
  }
  async function runScheduleNow(id) {
    if (!confirm('立即執行此排程？\n會以排程設定的模式（含可能的 EXECUTE）觸發。')) return;
    const r = await fetch(`/api/schedules/${id}/run`, { method: 'POST' });
    if (r.ok) alert('已觸發。請到「智能採購建單」分頁觀察進度（或重新整理本頁看上次執行欄位）。');
    else alert('觸發失敗');
    setTimeout(loadSchedules, 2000);
  }
  $('#scheduleNew').addEventListener('click', () => openEditor(null));
  $('#schCancel').addEventListener('click', closeEditor);
  $('#schSave').addEventListener('click', saveSchedule);
  $('#schType').addEventListener('change', onTypeChange);

  /* ========== Anomaly tab ========== */
  let anomalyPollTimer = null;
  let anomalyLastTotal = -1;

  function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    if (sameDay) return `今天 ${hh}:${mm}:${ss}`;
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mo}/${dd} ${hh}:${mm}`;
  }

  function typeChipMeta(type) {
    switch (type) {
      case 'insufficient-quantity':  return { label: '數量不足',     cls: 'insufficient' };
      case 'stop-spec-skipped':      return { label: 'STOP 故沒訂購', cls: 'stop-skipped' };
      default:                       return { label: type || '?',    cls: '' };
    }
  }

  function renderAnomalyCard(a) {
    const meta = typeChipMeta(a.type);
    const modeCls = a.mode === 'execute' ? 'anomaly-card__mode--execute' : '';
    const detail = (() => {
      const parts = [];
      // 數量不足：加總 + 門檻 + 規格清單
      if (typeof a.rawSum === 'number' && typeof a.threshold === 'number') {
        parts.push(`加總 <code>${a.rawSum}</code> &lt; 門檻 <code>${a.threshold}</code>`);
      }
      // STOP 故沒訂購：規格 + 建議量
      if (a.specLabel) {
        const q = (a.suggestedQty !== undefined) ? `（建議 ${a.suggestedQty}）` : '';
        parts.push(`規格 <code>${a.specLabel}</code>${q}`);
      }
      if (Array.isArray(a.tags) && a.tags.length) {
        parts.push(`tags <code>[${a.tags.join(', ')}]</code>`);
      }
      if (Array.isArray(a.specs) && a.specs.length) {
        const list = a.specs.map((s) => `${s.label} qty=${s.qty}`).join(' · ');
        parts.push(`規格 ${list}`);
      }
      return parts.join('　');
    })();

    const card = el('div', { class: 'anomaly-card anomaly-card--' + meta.cls });
    card.innerHTML = `
      <div class="anomaly-card__time"></div>
      <span class="anomaly-card__type anomaly-card__type--${meta.cls}"></span>
      <div class="anomaly-card__body">
        <div class="anomaly-card__mainid"></div>
        <div class="anomaly-card__message"></div>
        ${detail ? `<div class="anomaly-card__detail">${detail}</div>` : ''}
      </div>
      <div class="anomaly-card__meta">
        <span class="anomaly-card__mode ${modeCls}"></span>
        <button class="anomaly-card__delete" title="刪除這筆">✕</button>
      </div>
    `;
    card.querySelector('.anomaly-card__time').textContent = fmtTime(a.time);
    card.querySelector('.anomaly-card__type').textContent = meta.label;
    card.querySelector('.anomaly-card__mainid').textContent = a.mainId + (a.productName ? '  ·  ' + a.productName.slice(0, 50) : '');
    card.querySelector('.anomaly-card__message').textContent = a.message || '';
    card.querySelector('.anomaly-card__mode').textContent = (a.mode || '').toUpperCase();
    card.querySelector('.anomaly-card__delete').addEventListener('click', () => deleteAnomaly(a.id));
    return card;
  }

  function buildAnomalyQuery() {
    const type = $('#anomalyTypeFilter').value;
    const mode = $('#anomalyModeFilter').value;
    const q    = $('#anomalySearch').value.trim();
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (mode) params.set('mode', mode);
    if (q)    params.set('q', q);
    return params.toString();
  }

  async function loadAnomalies() {
    try {
      const qs = buildAnomalyQuery();
      const r = await fetch('/api/anomalies' + (qs ? '?' + qs : ''));
      const data = await r.json();
      const list = data.anomalies || [];
      $('#anomalyCount').textContent = `${list.length} 筆`;
      const container = $('#anomalyList');
      container.innerHTML = '';
      if (list.length === 0) {
        container.appendChild(el('div', { class: 'anomaly-empty' },
          '尚無異常紀錄。執行採購任務後，數量不足 / STOP / POST 失敗會自動列在這裡。'));
      } else {
        list.forEach((a) => container.appendChild(renderAnomalyCard(a)));
      }
      // 更新 tab 上的紅色 badge（總數，不過濾）
      updateAnomalyBadge();
    } catch (e) {
      console.warn('load anomalies failed', e);
    }
  }

  async function updateAnomalyBadge() {
    // 拿總數（不帶 filter）
    try {
      const r = await fetch('/api/anomalies');
      const data = await r.json();
      const n = data.total || 0;
      const badge = $('#anomalyTabBadge');
      if (n > 0) {
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
      anomalyLastTotal = n;
    } catch {}
  }

  function startAnomalyPoll() {
    stopAnomalyPoll();
    anomalyPollTimer = setInterval(() => {
      // 若 tab 還在 active 才整 load；否則只更新 badge
      const onTab = $('#tab-anomalies').classList.contains('is-active');
      if (onTab) loadAnomalies();
      else updateAnomalyBadge();
    }, 5000);
  }
  function stopAnomalyPoll() {
    if (anomalyPollTimer) { clearInterval(anomalyPollTimer); anomalyPollTimer = null; }
  }

  async function deleteAnomaly(id) {
    if (!confirm('刪除這筆異常紀錄？')) return;
    await fetch(`/api/anomalies/${id}`, { method: 'DELETE' });
    loadAnomalies();
  }
  async function clearAllAnomalies() {
    if (!confirm('清空全部異常紀錄？此操作無法復原。')) return;
    await fetch('/api/anomalies', { method: 'DELETE' });
    loadAnomalies();
  }

  function downloadAnomaliesCsv() {
    const qs = buildAnomalyQuery();
    // 用簡單的 <a download> 觸發瀏覽器下載，URL 帶當前 filter
    const url = '/api/anomalies.csv' + (qs ? '?' + qs : '');
    const a = document.createElement('a');
    a.href = url;
    a.download = '';   // 讓瀏覽器吃 server 給的 Content-Disposition filename
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  $('#btnAnomalyRefresh').addEventListener('click', loadAnomalies);
  $('#btnAnomalyDownload').addEventListener('click', downloadAnomaliesCsv);
  $('#btnAnomalyClear').addEventListener('click', clearAllAnomalies);
  ['#anomalyTypeFilter', '#anomalyModeFilter', '#anomalySearch'].forEach((sel) => {
    $(sel).addEventListener('input', loadAnomalies);
    $(sel).addEventListener('change', loadAnomalies);
  });

  // boot：背景定期更新 badge（不需要 polling list，只看總數）
  updateAnomalyBadge();
  setInterval(updateAnomalyBadge, 15000);

  /* ========== Session status pill ========== */
  function fmtAgo(ts) {
    if (!ts) return '--';
    const diff = Date.now() - ts;
    const m = Math.round(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }
  async function refreshSessionStatus() {
    try {
      const r = await fetch('/api/session-status');
      const data = await r.json();
      const pill = $('#sessionStatus');
      let status = data.status || 'unknown';
      if (data.inProgress) status = 'checking';
      pill.dataset.status = status;
      const ago = fmtAgo(data.lastSuccess || data.lastCheck);
      $('.session-pill__text', pill).textContent = `session: ${status} · ${ago}`;
    } catch (e) {
      const pill = $('#sessionStatus');
      pill.dataset.status = 'unknown';
      $('.session-pill__text', pill).textContent = 'session: error';
    }
  }
  $('#sessionStatus').addEventListener('click', async () => {
    const pill = $('#sessionStatus');
    pill.dataset.status = 'checking';
    $('.session-pill__text', pill).textContent = 'session: checking...';
    await fetch('/api/session-refresh', { method: 'POST' }).catch(() => {});
    setTimeout(refreshSessionStatus, 6000);
  });
  refreshSessionStatus();
  setInterval(refreshSessionStatus, 60 * 1000);

  /* ========== Boot ========== */
  refreshModeBadge();
})();
