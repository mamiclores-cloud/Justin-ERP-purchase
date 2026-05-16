// server.js — 智能採購控制台後端
// 仿 distribution-print/server.js 結構簡化版（沒有撿貨車 / 列印 / 檔案）
//
// 提供：
//   GET  /                              → public/index.html
//   GET  /api/steps                     → 步驟註冊表
//   POST /api/start                     → 啟動 job (spawn purchase-create.js)
//   GET  /api/job/:id?since=N           → polling log
//   POST /api/stop/:id                  → kill job
//   GET  /api/suppliers                 → 供應商選單（自動 cache 5 分鐘）
//   GET  /api/translocations            → 集運地點選單
//   GET  /api/schedules                 → 列排程
//   POST /api/schedules                 → 新增
//   PATCH/DELETE/run                    → 編輯/刪/立即跑
//   GET  /api/session-status            → session pill
//   POST /api/session-refresh           → 手動觸發 session check

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '3001', 10);  // 避開 distribution-print 的 3000
const PUBLIC_DIR = path.join(__dirname, 'public');
const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
const ANOMALY_LOG = path.join(__dirname, 'state', 'anomalies.jsonl');

/* ============ 步驟註冊表 ============ */
// 智能採購只有一支主腳本，但保留 step 結構讓 UI 一致
const STEPS = {
  'purchase-create': {
    script: 'purchase-create.js',
    name: '智能採購建單',
    desc: '依條件查智能採購候選 → 套商業規則 (NX 倍數 / STOP 跳過) → 加總 ≥ 6 才建單 → POST /api/PurchaseSheet/add',
    safety: '修改類：POST add 會在 ERP 建立採購單',
  },
};

/* ============ Job 管理 ============ */
const jobs = {};
let jobSeq = 0;

function newJobId() { return 'j' + (++jobSeq).toString(36) + Date.now().toString(36); }

// 把前端傳來的 params 轉成 CLI args 給 purchase-create.js
function buildArgs(stepKey, params) {
  const info = STEPS[stepKey];
  if (!info) throw new Error('unknown step: ' + stepKey);

  const args = [info.script];
  if (params.execute) args.push('--execute');
  if (params.headed) args.push('--headed');
  if (params.debug) args.push('--debug');
  if (params.keyword)     args.push('--keyword', String(params.keyword));
  if (params.keywordType) args.push('--keyword-type', String(params.keywordType));
  if (params.supplier)    args.push('--supplier', String(params.supplier));
  if (params.cardinality) args.push('--cardinality', String(params.cardinality));
  if (params.percent !== undefined && params.percent !== null && params.percent !== '') {
    args.push('--percent', String(params.percent));
  }
  if (params.platform)    args.push('--platform', String(params.platform));
  if (params.threshold !== undefined && params.threshold !== null && params.threshold !== '') {
    args.push('--threshold', String(params.threshold));
  }
  if (params.only)        args.push('--only', String(params.only));
  if (params.maxProducts) args.push('--max-products', String(params.maxProducts));
  if (params.pauseMs !== undefined && params.pauseMs !== null && params.pauseMs !== '') {
    args.push('--pause-ms', String(params.pauseMs));
  }
  return args;
}

function startJob(stepKey, params) {
  const info = STEPS[stepKey];
  if (!info) throw new Error('unknown step: ' + stepKey);

  const args = buildArgs(stepKey, params);
  const jobId = newJobId();
  const job = {
    id: jobId,
    step: stepKey,
    name: info.name,
    args,
    cmdline: 'node ' + args.join(' '),
    startedAt: Date.now(),
    state: 'running',
    logs: [],
    exitCode: null,
    finishedAt: null,
    params,
  };
  jobs[jobId] = job;

  console.log(`[server] starting job ${jobId}: ${job.cmdline}`);
  const child = spawn('node', args, {
    cwd: __dirname,
    env: { ...process.env, FORCE_COLOR: '0', PURCHASE_RUN_ID: jobId },
  });
  job.process = child;
  job.pid = child.pid;

  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString('utf8');
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    lines.forEach((line) => job.logs.push({ time: Date.now(), stream: 'stdout', text: line }));
  });
  child.stderr.on('data', (d) => {
    stderrBuf += d.toString('utf8');
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    lines.forEach((line) => job.logs.push({ time: Date.now(), stream: 'stderr', text: line }));
  });
  child.on('close', (code) => {
    if (stdoutBuf) job.logs.push({ time: Date.now(), stream: 'stdout', text: stdoutBuf });
    if (stderrBuf) job.logs.push({ time: Date.now(), stream: 'stderr', text: stderrBuf });
    job.state = code === 0 ? 'done' : 'failed';
    job.exitCode = code;
    job.finishedAt = Date.now();
    console.log(`[server] job ${jobId} finished, exit=${code}, logs=${job.logs.length}`);
    if (code === 0) markSessionValidFromJob();
  });
  child.on('error', (err) => {
    job.logs.push({ time: Date.now(), stream: 'stderr', text: 'spawn error: ' + err.message });
    job.state = 'failed';
    job.exitCode = -1;
    job.finishedAt = Date.now();
  });

  return jobId;
}

function stopJob(jobId) {
  const job = jobs[jobId];
  if (!job || job.state !== 'running') return false;
  try { job.process.kill(); job.state = 'cancelled'; job.finishedAt = Date.now(); return true; }
  catch { return false; }
}

/* ============ Supplier / Translocation cache ============ */
const optCache = { suppliers: null, translocations: null, fetchedAt: 0 };
const OPT_TTL = 5 * 60 * 1000;

async function fetchOptions(name) {
  if (optCache[name] && Date.now() - optCache.fetchedAt < OPT_TTL) return optCache[name];
  // 透過 spawn 一個 small node script 拿（避免 server.js 自己 require playwright 而吃 chrome-profile lock）
  // 簡化：直接呼叫 helper script
  const out = await new Promise((resolve) => {
    const c = spawn('node', ['_fetch-options.js', name], {
      cwd: __dirname,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let buf = '';
    c.stdout.on('data', (d) => (buf += d.toString('utf8')));
    c.stderr.on('data', (d) => (buf += d.toString('utf8')));
    c.on('close', (code) => resolve({ code, buf }));
    c.on('error', (err) => resolve({ code: -1, buf: 'spawn error: ' + err.message }));
  });
  if (out.code !== 0) {
    console.error(`[options] ${name} failed:`, out.buf.slice(-200));
    return null;
  }
  try {
    const data = JSON.parse(out.buf);
    optCache[name] = data;
    optCache.fetchedAt = Date.now();
    return data;
  } catch (e) {
    console.error(`[options] ${name} parse error:`, e.message);
    return null;
  }
}

/* ============ Schedule Engine ============ */
let schedules = [];
const scheduleTimers = {};

function loadSchedules() {
  try {
    if (fs.existsSync(SCHEDULES_FILE)) {
      schedules = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
      console.log(`[schedule] loaded ${schedules.length} schedule(s)`);
    }
  } catch (e) { console.error('[schedule] load error', e.message); schedules = []; }
}
function saveSchedules() {
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(
    schedules.map(({ id, name, enabled, type, time, datetime, options, lastRun, nextRun }) =>
      ({ id, name, enabled, type, time, datetime, options, lastRun, nextRun })), null, 2));
}
function computeNextFire(s) {
  if (s.type === 'once') {
    const t = new Date(s.datetime).getTime();
    return t > Date.now() ? t : null;
  }
  if (s.type === 'daily') {
    const [h, m] = (s.time || '00:00').split(':').map(Number);
    const fire = new Date();
    fire.setHours(h, m, 0, 0);
    if (fire.getTime() <= Date.now()) fire.setDate(fire.getDate() + 1);
    return fire.getTime();
  }
  return null;
}
function scheduleFire(s) {
  if (scheduleTimers[s.id]) { clearTimeout(scheduleTimers[s.id]); delete scheduleTimers[s.id]; }
  if (!s.enabled) { s.nextRun = null; return; }
  const fireAt = computeNextFire(s);
  if (!fireAt) { s.nextRun = null; s.enabled = false; return; }
  s.nextRun = fireAt;
  scheduleTimers[s.id] = setTimeout(() => fireSchedule(s.id), Math.max(0, fireAt - Date.now()));
  console.log(`[schedule] ${s.name} next fire in ${Math.round((fireAt - Date.now()) / 60000)}min`);
}
async function fireSchedule(id) {
  const s = schedules.find((x) => x.id === id);
  if (!s) return;
  console.log(`[schedule] firing ${s.name}`);
  const startedAt = Date.now();
  s.lastRun = { startedAt, state: 'running' };
  saveSchedules();
  try {
    const jobId = startJob('purchase-create', s.options || {});
    // poll until done
    while (jobs[jobId].state === 'running') await new Promise((r) => setTimeout(r, 1500));
    const j = jobs[jobId];
    s.lastRun = { startedAt, finishedAt: Date.now(), state: j.state, exitCode: j.exitCode, jobId };
  } catch (e) {
    s.lastRun = { startedAt, finishedAt: Date.now(), state: 'failed', error: e.message };
  }
  saveSchedules();
  if (s.type === 'daily' && s.enabled) scheduleFire(s);
  else { s.enabled = false; saveSchedules(); }
}
function uuid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function startAllSchedules() { schedules.forEach((s) => scheduleFire(s)); }

/* ============ Session keep-alive ============ */
const SESSION_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const sessionState = {
  lastCheck: null, lastSuccess: null, status: 'unknown', message: '', inProgress: false,
};

async function runSessionCheck(reason = 'scheduled') {
  if (sessionState.inProgress) return;
  const anyRunning = Object.values(jobs).some((j) => j.state === 'running');
  if (anyRunning) { console.log(`[keepalive] skip (${reason}) — job running`); return; }
  sessionState.inProgress = true;
  console.log(`[keepalive] running session check (${reason})...`);
  const t0 = Date.now();
  try {
    const out = await new Promise((resolve) => {
      const c = spawn('node', ['_keepalive.js'], { cwd: __dirname, env: { ...process.env, FORCE_COLOR: '0' } });
      let buf = '';
      c.stdout.on('data', (d) => (buf += d.toString('utf8')));
      c.stderr.on('data', (d) => (buf += d.toString('utf8')));
      c.on('close', (code) => resolve({ code, buf: buf.trim() }));
      c.on('error', (err) => resolve({ code: -1, buf: 'spawn error: ' + err.message }));
    });
    sessionState.lastCheck = Date.now();
    if (out.code === 0) {
      sessionState.status = 'valid'; sessionState.lastSuccess = Date.now(); sessionState.message = '';
      console.log(`[keepalive] valid (${Date.now() - t0}ms)`);
    } else {
      sessionState.status = 'expired'; sessionState.message = (out.buf || '').slice(0, 200);
      console.log(`[keepalive] expired: ${sessionState.message}`);
    }
  } catch (e) {
    sessionState.lastCheck = Date.now(); sessionState.status = 'unknown'; sessionState.message = e.message;
  } finally { sessionState.inProgress = false; }
}
function markSessionValidFromJob() {
  sessionState.lastCheck = Date.now(); sessionState.lastSuccess = Date.now();
  sessionState.status = 'valid'; sessionState.message = '';
}

/* ============ Static / Router ============ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
function serveStatic(req, res) {
  const safeUrl = decodeURIComponent(req.url.split('?')[0]);
  const rel = safeUrl === '/' ? '/index.html' : safeUrl;
  if (rel.includes('..')) { res.writeHead(403); res.end(); return; }
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found: ' + rel);
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  fs.createReadStream(filePath).pipe(res);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}
function jsonResp(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function handleApi(req, res, urlPath) {
  // GET /api/steps
  if (req.method === 'GET' && urlPath === '/api/steps') {
    const list = Object.entries(STEPS).map(([k, v]) => ({ key: k, ...v, script: undefined }));
    return jsonResp(res, 200, { steps: list });
  }

  // POST /api/start
  if (req.method === 'POST' && urlPath === '/api/start') {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body || '{}');
      const jobId = startJob(params.step || 'purchase-create', params);
      return jsonResp(res, 200, { jobId });
    } catch (e) {
      return jsonResp(res, 400, { error: e.message });
    }
  }

  // GET /api/job/:id?since=N
  const mJob = urlPath.match(/^\/api\/job\/([^\/]+)$/);
  if (req.method === 'GET' && mJob) {
    const job = jobs[mJob[1]];
    if (!job) return jsonResp(res, 404, { error: 'job not found' });
    const since = parseInt(new URL(req.url, 'http://x').searchParams.get('since') || '0', 10);
    return jsonResp(res, 200, {
      id: job.id, step: job.step, name: job.name, state: job.state, exitCode: job.exitCode,
      startedAt: job.startedAt, finishedAt: job.finishedAt, cmdline: job.cmdline,
      logs: job.logs.slice(since), totalLogs: job.logs.length,
    });
  }

  // POST /api/stop/:id
  const mStop = urlPath.match(/^\/api\/stop\/([^\/]+)$/);
  if (req.method === 'POST' && mStop) {
    const ok = stopJob(mStop[1]);
    return jsonResp(res, ok ? 200 : 404, { stopped: ok });
  }

  // GET /api/suppliers
  if (req.method === 'GET' && urlPath === '/api/suppliers') {
    const opts = await fetchOptions('suppliers');
    if (!opts) return jsonResp(res, 500, { error: 'failed to fetch suppliers' });
    return jsonResp(res, 200, { suppliers: opts });
  }

  // GET /api/translocations
  if (req.method === 'GET' && urlPath === '/api/translocations') {
    const opts = await fetchOptions('translocations');
    if (!opts) return jsonResp(res, 500, { error: 'failed to fetch translocations' });
    return jsonResp(res, 200, { translocations: opts });
  }

  // Schedule
  if (req.method === 'GET' && urlPath === '/api/schedules') {
    return jsonResp(res, 200, {
      schedules: schedules.map((s) => ({
        id: s.id, name: s.name, enabled: s.enabled, type: s.type,
        time: s.time, datetime: s.datetime, options: s.options,
        lastRun: s.lastRun, nextRun: s.nextRun,
      })),
    });
  }
  if (req.method === 'POST' && urlPath === '/api/schedules') {
    try {
      const body = await readBody(req);
      const p = JSON.parse(body || '{}');
      if (!p.name || !p.type) return jsonResp(res, 400, { error: 'name and type required' });
      const s = {
        id: uuid(),
        name: String(p.name).slice(0, 60),
        enabled: p.enabled !== false,
        type: p.type === 'once' ? 'once' : 'daily',
        time: p.time || null,
        datetime: p.datetime || null,
        options: p.options || {},
        lastRun: null, nextRun: null,
      };
      schedules.push(s);
      scheduleFire(s);
      saveSchedules();
      return jsonResp(res, 200, { schedule: s });
    } catch (e) { return jsonResp(res, 500, { error: e.message }); }
  }
  const mSch = urlPath.match(/^\/api\/schedules\/([^/]+)$/);
  if (req.method === 'PATCH' && mSch) {
    const s = schedules.find((x) => x.id === mSch[1]);
    if (!s) return jsonResp(res, 404, { error: 'not found' });
    try {
      const body = await readBody(req);
      const p = JSON.parse(body || '{}');
      if (p.name !== undefined)     s.name = String(p.name).slice(0, 60);
      if (p.enabled !== undefined)  s.enabled = !!p.enabled;
      if (p.type !== undefined)     s.type = p.type === 'once' ? 'once' : 'daily';
      if (p.time !== undefined)     s.time = p.time;
      if (p.datetime !== undefined) s.datetime = p.datetime;
      if (p.options !== undefined)  s.options = p.options;
      scheduleFire(s); saveSchedules();
      return jsonResp(res, 200, { schedule: s });
    } catch (e) { return jsonResp(res, 500, { error: e.message }); }
  }
  if (req.method === 'DELETE' && mSch) {
    const idx = schedules.findIndex((x) => x.id === mSch[1]);
    if (idx < 0) return jsonResp(res, 404, { error: 'not found' });
    const [removed] = schedules.splice(idx, 1);
    if (scheduleTimers[removed.id]) { clearTimeout(scheduleTimers[removed.id]); delete scheduleTimers[removed.id]; }
    saveSchedules();
    return jsonResp(res, 200, { deleted: removed.id });
  }
  const mRun = urlPath.match(/^\/api\/schedules\/([^/]+)\/run$/);
  if (req.method === 'POST' && mRun) {
    const s = schedules.find((x) => x.id === mRun[1]);
    if (!s) return jsonResp(res, 404, { error: 'not found' });
    fireSchedule(s.id);
    return jsonResp(res, 200, { triggered: s.id });
  }

  /* ============ Anomaly log ============ */
  // Append-only JSONL，每行一筆。用 line index 當 id（刪除是 rewrite 整檔）。
  function readAnomalies() {
    if (!fs.existsSync(ANOMALY_LOG)) return [];
    const text = fs.readFileSync(ANOMALY_LOG, 'utf8');
    return text.split(/\r?\n/)
      .filter(Boolean)
      .map((l, i) => { try { return { id: i, ...JSON.parse(l) }; } catch { return null; } })
      .filter(Boolean);
  }

  if (req.method === 'GET' && urlPath === '/api/anomalies') {
    const u = new URL(req.url, 'http://x');
    const since = parseInt(u.searchParams.get('since') || '0', 10);
    const type  = u.searchParams.get('type') || '';
    const mode  = u.searchParams.get('mode') || '';
    const q     = (u.searchParams.get('q') || '').toLowerCase();
    let list = readAnomalies();
    if (since)  list = list.filter((a) => a.time >= since);
    if (type)   list = list.filter((a) => a.type === type);
    if (mode)   list = list.filter((a) => a.mode === mode);
    if (q)      list = list.filter((a) =>
      (a.mainId || '').toLowerCase().includes(q) ||
      (a.message || '').toLowerCase().includes(q));
    // 新的在前
    list.sort((a, b) => b.time - a.time);
    return jsonResp(res, 200, { anomalies: list, total: list.length });
  }

  // GET /api/anomalies.csv — 匯出 CSV（含 UTF-8 BOM 讓 Excel 開不亂碼）
  if (req.method === 'GET' && urlPath === '/api/anomalies.csv') {
    const u = new URL(req.url, 'http://x');
    const type  = u.searchParams.get('type') || '';
    const mode  = u.searchParams.get('mode') || '';
    const q     = (u.searchParams.get('q') || '').toLowerCase();
    let list = readAnomalies();
    if (type) list = list.filter((a) => a.type === type);
    if (mode) list = list.filter((a) => a.mode === mode);
    if (q)    list = list.filter((a) =>
      (a.mainId || '').toLowerCase().includes(q) ||
      (a.message || '').toLowerCase().includes(q));
    list.sort((a, b) => b.time - a.time);

    const TYPE_LABEL = {
      'insufficient-quantity': '數量不足',
      'stop-spec-skipped':     'STOP 故沒訂購',
    };

    function esc(v) {
      if (v === null || v === undefined) return '';
      const s = String(v);
      // CSV 規範：含 , " \n 或前後空白 都加雙引號，內部雙引號 → 雙雙引號
      if (/[,"\r\n]/.test(s) || /^\s|\s$/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }
    function fmtDate(ms) {
      if (!ms) return '';
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    const headers = ['時間', '模式', '貨號', '商品名稱', '異常類型', '異常訊息', '規格', '建議採購量', '規格加總', '門檻', 'Tags', 'RunId'];
    const rows = list.map((a) => [
      fmtDate(a.time),
      (a.mode || '').toUpperCase(),
      a.mainId || '',
      a.productName || '',
      TYPE_LABEL[a.type] || a.type || '',
      a.message || '',
      // 規格欄位：stop-spec-skipped 用 specLabel；insufficient-quantity 用 specs 陣列
      a.specLabel || (Array.isArray(a.specs) ? a.specs.map((s) => `${s.label} qty=${s.qty}`).join(' | ') : ''),
      a.suggestedQty ?? '',
      a.rawSum ?? '',
      a.threshold ?? '',
      Array.isArray(a.tags) ? a.tags.join(',') : '',
      a.runId || '',
    ].map(esc).join(','));

    const csvText = '﻿' + [headers.map(esc).join(',')].concat(rows).join('\r\n');
    const d = new Date();
    const fname = `anomalies-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}.csv`;
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Cache-Control': 'no-cache',
    });
    res.end(csvText);
    return;
  }

  if (req.method === 'DELETE' && urlPath === '/api/anomalies') {
    if (fs.existsSync(ANOMALY_LOG)) fs.unlinkSync(ANOMALY_LOG);
    return jsonResp(res, 200, { cleared: true });
  }

  // DELETE /api/anomalies/:id — 刪單筆（id = 原始行號）
  const mAnomaly = urlPath.match(/^\/api\/anomalies\/(\d+)$/);
  if (req.method === 'DELETE' && mAnomaly) {
    const idx = parseInt(mAnomaly[1], 10);
    if (!fs.existsSync(ANOMALY_LOG)) return jsonResp(res, 404, { error: 'not found' });
    const lines = fs.readFileSync(ANOMALY_LOG, 'utf8').split(/\r?\n/).filter(Boolean);
    if (idx < 0 || idx >= lines.length) return jsonResp(res, 404, { error: 'not found' });
    lines.splice(idx, 1);
    fs.writeFileSync(ANOMALY_LOG, lines.length ? lines.join('\n') + '\n' : '');
    return jsonResp(res, 200, { deleted: idx });
  }

  // Session
  if (req.method === 'GET' && urlPath === '/api/session-status') {
    return jsonResp(res, 200, {
      lastCheck: sessionState.lastCheck, lastSuccess: sessionState.lastSuccess,
      status: sessionState.status, message: sessionState.message, inProgress: sessionState.inProgress,
      nextCheck: sessionState.lastCheck ? sessionState.lastCheck + SESSION_CHECK_INTERVAL_MS : null,
    });
  }
  if (req.method === 'POST' && urlPath === '/api/session-refresh') {
    runSessionCheck('manual').catch((e) => console.error('[keepalive] manual error', e.message));
    return jsonResp(res, 200, { triggered: true });
  }

  return jsonResp(res, 404, { error: 'no such endpoint' });
}

/* ============ Server ============ */
const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  if (urlPath.startsWith('/api/')) return handleApi(req, res, urlPath);
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('================================');
  console.log('  智能採購控制台');
  console.log('  http://localhost:' + PORT);
  console.log('================================');
  loadSchedules();
  startAllSchedules();
  setTimeout(() => runSessionCheck('startup'), 30 * 1000);
  setInterval(() => runSessionCheck('scheduled'), SESSION_CHECK_INTERVAL_MS);
});

process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e.message); console.error(e.stack); });
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e && e.message ? e.message : e); });
process.on('SIGINT', () => {
  console.log('\nshutting down...');
  Object.values(jobs).forEach((j) => { if (j.process) try { j.process.kill(); } catch {} });
  process.exit(0);
});
