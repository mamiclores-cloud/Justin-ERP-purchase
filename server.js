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
// EXECUTE 模式跑完會把本次異常匯出到這個資料夾,員工直接到 Windows 檔案總管找
const EXPORT_DIR = path.join(__dirname, '異常紀錄');

/* ============ Anomaly CSV helpers(server-side filter + auto export 共用)============ */
const ANOMALY_TYPE_LABEL = {
  'insufficient-quantity': '數量不足',
  'stop-spec-skipped':     'STOP 故沒訂購',
  'tw-no-stock':           'TW 三家沒貨',
  'tw-below-low-sales':    'TW 湊不滿低銷',
  'tw-data-gap':           'TW 資料缺漏',
};

// 跟 lib/purchase-rules.js 的 CARDINALITY_OPTIONS 對齊;這邊複製一份避免 server.js 載入業務 lib
const CARDINALITY_LABEL = {
  'SafetyStock':   '安全庫存',
  'SalesCount7':   '7日銷量',
  'SalesCount15':  '15日銷量',
  'SalesCount30':  '30日銷量',
  'SalesCount60':  '60日銷量',
  'SalesCount90':  '90日銷量',
};

function csvEsc(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // CSV 規範:含 , " \n 或前後空白 都加雙引號,內部雙引號 → 雙雙引號
  if (/[,"\r\n]/.test(s) || /^\s|\s$/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvFmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 把 anomalies array 變成 CSV 文字(含 UTF-8 BOM,Excel 直開不亂碼)
function buildAnomaliesCsv(list) {
  const headers = ['時間', '模式', '需求算式', '倍率', '貨號', '商品名稱', '異常類型', '異常訊息', '規格', '建議採購量', '規格加總', '門檻', 'Tags', 'RunId'];
  const rows = list.map((a) => [
    csvFmtDate(a.time),
    (a.mode || '').toUpperCase(),
    CARDINALITY_LABEL[a.cardinality] || a.cardinality || '',
    (a.percent !== undefined && a.percent !== null && a.percent !== '') ? `${a.percent}%` : '',
    a.mainId || '',
    a.productName || '',
    ANOMALY_TYPE_LABEL[a.type] || a.type || '',
    a.message || '',
    a.specLabel || (Array.isArray(a.specs) ? a.specs.map((s) => `${s.label} qty=${s.qty}`).join(' | ') : ''),
    a.suggestedQty ?? '',
    a.rawSum ?? '',
    a.threshold ?? '',
    Array.isArray(a.tags) ? a.tags.join(',') : '',
    a.runId || '',
  ].map(csvEsc).join(','));
  return '﻿' + [headers.map(csvEsc).join(',')].concat(rows).join('\r\n');
}

// Job 結束時呼叫:把本次 job 的異常 (filter runId === jobId) 匯出到 EXPORT_DIR
// dry-run / execute 都會匯;沒異常也建一個標「-無異常」的空檔,讓員工有明確結果可查
// 檔名格式:異常紀錄-yyyymmdd-時分.csv  (無異常時加 -無異常 後綴)
function exportJobAnomalies(jobId) {
  try {
    let list = [];
    if (fs.existsSync(ANOMALY_LOG)) {
      list = fs.readFileSync(ANOMALY_LOG, 'utf8')
        .split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((a) => a && a.runId === jobId);
      list.sort((a, b) => b.time - a.time);
    }
    if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const suffix = list.length === 0 ? '-無異常' : '';
    const fname = `異常紀錄-${stamp}${suffix}.csv`;
    const fpath = path.join(EXPORT_DIR, fname);
    fs.writeFileSync(fpath, buildAnomaliesCsv(list));
    return { path: fpath, count: list.length };
  } catch (e) {
    console.error('[export-anomalies] error:', e.message);
    return null;
  }
}

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
  if (params.workflow)    args.push('--workflow', String(params.workflow));
  if (params.platform)    args.push('--platform', String(params.platform));
  if (params.threshold !== undefined && params.threshold !== null && params.threshold !== '') {
    args.push('--threshold', String(params.threshold));
  }
  if (params.recentDays !== undefined && params.recentDays !== null && params.recentDays !== '') {
    args.push('--recent-days', String(params.recentDays));  // 1688 6天內不重複採購（0=關閉）
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

    // Job 跑完自動匯出本次的異常到「異常紀錄/」資料夾(dry-run / execute 都匯,無異常也建空檔)
    if (code === 0) {
      const out = exportJobAnomalies(jobId);
      if (out) {
        const msg = out.count > 0
          ? `[server] 已自動匯出 ${out.count} 筆異常 → ${out.path}`
          : `[server] 本次無異常,已建立紀錄 → ${out.path}`;
        console.log(msg);
        job.logs.push({ time: Date.now(), stream: 'stdout', text: msg });
        job.exportedCsvPath = out.path;
      }
    }

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

/* ============ TW 庫存比對(子系統 A):上傳 + spawn Python helper ============ */
// TW 是混合架構:Node 管 UI / job / 流程,sheet 讀寫 + 廠商檔解析 + 圖片 OCR 交給
// tw/stock_match.py(Python)。設定(sheet id / 金鑰 / python 路徑)放 tw/tw_secrets.json。
const TW_SECRETS_FILE = path.join(__dirname, 'tw', 'tw_secrets.json');
const TW_UPLOAD_ROOT = path.join(__dirname, 'state', 'tw-uploads');
const TW_VENDORS = ['IL', 'HS', 'IN'];

function twSecrets() {
  try { return JSON.parse(fs.readFileSync(TW_SECRETS_FILE, 'utf8')); } catch { return {}; }
}
function twPython() {
  return process.env.TW_PYTHON || twSecrets().python_exe || 'python';
}

// 極簡 multipart/form-data 解析(Buffer-based,支援 binary 檔:圖片 / xls / pdf)
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const bBuf = Buffer.from('--' + (m[1] || m[2]).trim());
  const CRLF2 = Buffer.from('\r\n\r\n');
  const parts = [];
  let start = buffer.indexOf(bBuf);
  if (start < 0) return null;
  start += bBuf.length;
  while (start < buffer.length) {
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break;          // 結束 "--"
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;      // 跳 \r\n
    const next = buffer.indexOf(bBuf, start);
    if (next < 0) break;
    let partEnd = next;
    if (buffer[partEnd - 2] === 0x0d && buffer[partEnd - 1] === 0x0a) partEnd -= 2;
    const headerEnd = buffer.indexOf(CRLF2, start);
    if (headerEnd < 0 || headerEnd > partEnd) { start = next + bBuf.length; continue; }
    const headerStr = buffer.toString('utf8', start, headerEnd);
    const data = buffer.slice(headerEnd + 4, partEnd);
    const nameM = /name="([^"]*)"/i.exec(headerStr);
    const fileM = /filename="([^"]*)"/i.exec(headerStr);
    parts.push({ name: nameM ? nameM[1] : '', filename: fileM ? fileM[1] : null, data });
    start = next + bBuf.length;
  }
  return parts;
}

function readBodyBuffer(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// spawn tw/stock_match.py 當 job(沿用 jobs dict + log 串流);stdout 最後一行 JSON = 結果
function startTwJob(uploadsDir, opts) {
  const jobId = newJobId();
  const args = [path.join(__dirname, 'tw', 'stock_match.py'), '--uploads', uploadsDir];
  if (opts.date) args.push('--date', opts.date);
  if (opts.execute) args.push('--execute');
  const job = {
    id: jobId, step: 'tw-stock-match', name: 'TW 庫存比對',
    cmdline: twPython() + ' ' + args.join(' '),
    startedAt: Date.now(), state: 'running', logs: [], exitCode: null,
    finishedAt: null, result: null, params: opts,
  };
  jobs[jobId] = job;
  console.log(`[server] starting TW job ${jobId}: ${job.cmdline}`);
  const child = spawn(twPython(), args, {
    cwd: __dirname,
    env: { ...process.env, FORCE_COLOR: '0', PYTHONIOENCODING: 'utf-8' },
  });
  job.process = child; job.pid = child.pid;
  let outBuf = '', errBuf = '', lastJson = null;
  const tryJson = (line) => {
    const t = line.trim();
    if (t.startsWith('{') && t.endsWith('}')) { try { lastJson = JSON.parse(t); } catch {} }
  };
  child.stdout.on('data', (d) => {
    outBuf += d.toString('utf8');
    const lines = outBuf.split('\n'); outBuf = lines.pop();
    lines.forEach((line) => { job.logs.push({ time: Date.now(), stream: 'stdout', text: line }); tryJson(line); });
  });
  child.stderr.on('data', (d) => {
    errBuf += d.toString('utf8');
    const lines = errBuf.split('\n'); errBuf = lines.pop();
    lines.forEach((line) => job.logs.push({ time: Date.now(), stream: 'stderr', text: line }));
  });
  child.on('close', (code) => {
    if (outBuf) { job.logs.push({ time: Date.now(), stream: 'stdout', text: outBuf }); tryJson(outBuf); }
    if (errBuf) job.logs.push({ time: Date.now(), stream: 'stderr', text: errBuf });
    job.result = lastJson;
    job.state = code === 0 ? 'done' : 'failed';
    job.exitCode = code; job.finishedAt = Date.now();
    console.log(`[server] TW job ${jobId} finished, exit=${code}`);
    if (code === 0) markSessionValidFromJob();
  });
  child.on('error', (err) => {
    job.logs.push({ time: Date.now(), stream: 'stderr', text: 'spawn error: ' + err.message });
    job.state = 'failed'; job.exitCode = -1; job.finishedAt = Date.now();
  });
  return jobId;
}

// 把上傳的 multipart parts 存到 state/tw-uploads/{stamp}/{vendor}/,回 { dir, saved }
function saveTwUploads(files) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const uploadsDir = path.join(TW_UPLOAD_ROOT, stamp);
  let saved = 0;
  const byVendor = { IL: 0, HS: 0, IN: 0 };
  files.forEach((f, i) => {
    const vendor = (f.name || '').toUpperCase();
    if (!TW_VENDORS.includes(vendor)) return;
    const vdir = path.join(uploadsDir, vendor);
    fs.mkdirSync(vdir, { recursive: true });
    const base = path.basename(f.filename || ('file' + i)).replace(/[^\w.\-]+/g, '_') || ('file' + i);
    fs.writeFileSync(path.join(vdir, base), f.data);
    saved++; byVendor[vendor]++;
  });
  return { dir: uploadsDir, stamp, saved, byVendor };
}

// spawn tw-purchase.js(Node 主控:ERP 需求 → 分配 → 建單)當 job;stdout 最後一行 JSON = 結果
function startTwPurchaseJob(opts) {
  const jobId = newJobId();
  const args = [path.join(__dirname, 'tw-purchase.js')];
  if (opts.uploads) args.push('--uploads', String(opts.uploads));
  if (opts.useCache) args.push('--use-cache');
  if (opts.only) args.push('--only', String(opts.only));
  if (opts.ignoreLowSales) args.push('--ignore-low-sales');
  if (opts.date) args.push('--date', String(opts.date));
  if (opts.cardinality) args.push('--cardinality', String(opts.cardinality));
  if (opts.percent) args.push('--percent', String(opts.percent));
  if (opts.maxProducts) args.push('--max-products', String(opts.maxProducts));
  if (opts.execute) args.push('--execute');
  const job = {
    id: jobId, step: 'tw-purchase', name: 'TW 採購分配/建單',
    cmdline: 'node ' + args.join(' '),
    startedAt: Date.now(), state: 'running', logs: [], exitCode: null,
    finishedAt: null, result: null, params: opts,
  };
  jobs[jobId] = job;
  console.log(`[server] starting TW purchase job ${jobId}: ${job.cmdline}`);
  const child = spawn('node', args, { cwd: __dirname, env: { ...process.env, FORCE_COLOR: '0', PURCHASE_RUN_ID: jobId } });
  job.process = child; job.pid = child.pid;
  let outBuf = '', errBuf = '', lastJson = null;
  const tryJson = (line) => {
    const t = line.trim();
    if (t.startsWith('{') && t.endsWith('}')) { try { lastJson = JSON.parse(t); } catch {} }
  };
  child.stdout.on('data', (d) => {
    outBuf += d.toString('utf8');
    const ls = outBuf.split('\n'); outBuf = ls.pop();
    ls.forEach((l) => { job.logs.push({ time: Date.now(), stream: 'stdout', text: l }); tryJson(l); });
  });
  child.stderr.on('data', (d) => {
    errBuf += d.toString('utf8');
    const ls = errBuf.split('\n'); errBuf = ls.pop();
    ls.forEach((l) => job.logs.push({ time: Date.now(), stream: 'stderr', text: l }));
  });
  child.on('close', (code) => {
    if (outBuf) { job.logs.push({ time: Date.now(), stream: 'stdout', text: outBuf }); tryJson(outBuf); }
    if (errBuf) job.logs.push({ time: Date.now(), stream: 'stderr', text: errBuf });
    job.result = lastJson;
    job.state = code === 0 ? 'done' : 'failed';
    job.exitCode = code; job.finishedAt = Date.now();
    console.log(`[server] TW purchase job ${jobId} finished, exit=${code}`);
    if (code === 0) markSessionValidFromJob();
  });
  child.on('error', (err) => {
    job.logs.push({ time: Date.now(), stream: 'stderr', text: 'spawn error: ' + err.message });
    job.state = 'failed'; job.exitCode = -1; job.finishedAt = Date.now();
  });
  return jobId;
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
    schedules.map(({ id, name, enabled, type, time, datetime, weekdays, options, lastRun, nextRun }) =>
      ({ id, name, enabled, type, time, datetime, weekdays, options, lastRun, nextRun })), null, 2));
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
  if (s.type === 'weekly') {
    // weekdays: number[] (0=日, 1=一, ..., 6=六,對應 JS Date.getDay())
    const days = Array.isArray(s.weekdays)
      ? s.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : [];
    if (days.length === 0) return null;
    const [h, m] = (s.time || '00:00').split(':').map(Number);
    const now = Date.now();
    // 從今天起找 8 天內最近一個符合 weekday 且時間 > now 的時間點
    for (let offset = 0; offset < 8; offset++) {
      const cand = new Date();
      cand.setDate(cand.getDate() + offset);
      cand.setHours(h, m, 0, 0);
      if (cand.getTime() > now && days.includes(cand.getDay())) return cand.getTime();
    }
    return null;
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
    const o = s.options || {};
    // TW 排程:用最近上傳的庫存快取(不需上傳)→ tw-purchase.js;其餘走 purchase-create.js
    const jobId = (o.workflow === 'tw')
      ? startTwPurchaseJob({ cardinality: o.cardinality, percent: o.percent, execute: true, useCache: true })
      : startJob('purchase-create', o);
    // poll until done
    while (jobs[jobId].state === 'running') await new Promise((r) => setTimeout(r, 1500));
    const j = jobs[jobId];
    s.lastRun = { startedAt, finishedAt: Date.now(), state: j.state, exitCode: j.exitCode, jobId };
  } catch (e) {
    s.lastRun = { startedAt, finishedAt: Date.now(), state: 'failed', error: e.message };
  }
  saveSchedules();
  if ((s.type === 'daily' || s.type === 'weekly') && s.enabled) scheduleFire(s);
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

  // POST /api/tw/run — TW 庫存比對(multipart 上傳三廠商檔 → spawn Python helper)
  if (req.method === 'POST' && urlPath === '/api/tw/run') {
    const ct = req.headers['content-type'] || '';
    if (!/multipart\/form-data/i.test(ct)) {
      return jsonResp(res, 400, { error: '需要 multipart/form-data' });
    }
    try {
      const buf = await readBodyBuffer(req);
      const parts = parseMultipart(buf, ct);
      if (!parts) return jsonResp(res, 400, { error: 'multipart 解析失敗' });
      const fields = {};
      const files = [];
      parts.forEach((p) => { if (p.filename) files.push(p); else fields[p.name] = p.data.toString('utf8'); });
      const { dir, byVendor, saved } = saveTwUploads(files);
      if (saved === 0) return jsonResp(res, 400, { error: '沒有有效的廠商檔(欄位名須為 IL / HS / IN)' });
      const jobId = startTwJob(dir, { date: fields.date || '', execute: fields.execute === 'true' });
      return jsonResp(res, 200, { jobId, saved, byVendor });
    } catch (e) {
      return jsonResp(res, 500, { error: e.message });
    }
  }

  // POST /api/tw/run-all — 員工一鍵:上傳廠商檔 → Phase A 比對寫 v → Phase B 分配+建單+回填+異常
  if (req.method === 'POST' && urlPath === '/api/tw/run-all') {
    const ct = req.headers['content-type'] || '';
    if (!/multipart\/form-data/i.test(ct)) return jsonResp(res, 400, { error: '需要 multipart/form-data' });
    try {
      const buf = await readBodyBuffer(req);
      const parts = parseMultipart(buf, ct);
      if (!parts) return jsonResp(res, 400, { error: 'multipart 解析失敗' });
      const fields = {};
      const files = [];
      parts.forEach((p) => { if (p.filename) files.push(p); else fields[p.name] = p.data.toString('utf8'); });
      const { dir, byVendor, saved } = saveTwUploads(files);
      // saved 可為 0:代表這次沒上傳新檔 → stock_match 會改用上次的庫存快取(免重新 OCR)
      const jobId = startTwPurchaseJob({
        uploads: dir, date: fields.date || '', cardinality: fields.cardinality || '',
        percent: fields.percent || '', execute: fields.execute === 'true',
      });
      return jsonResp(res, 200, { jobId, saved, byVendor });
    } catch (e) {
      return jsonResp(res, 500, { error: e.message });
    }
  }

  // POST /api/tw/purchase — TW Phase B 分配 + 建單(JSON body: date/cardinality/percent/execute)
  if (req.method === 'POST' && urlPath === '/api/tw/purchase') {
    try {
      const body = await readBody(req);
      const p = JSON.parse(body || '{}');
      const jobId = startTwPurchaseJob({
        date: p.date || '', cardinality: p.cardinality || '', percent: p.percent || '',
        maxProducts: p.maxProducts || '', only: p.only || '', ignoreLowSales: !!p.ignoreLowSales, execute: !!p.execute,
      });
      return jsonResp(res, 200, { jobId });
    } catch (e) {
      return jsonResp(res, 500, { error: e.message });
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
      result: job.result || null,
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
        time: s.time, datetime: s.datetime, weekdays: s.weekdays,
        options: s.options, lastRun: s.lastRun, nextRun: s.nextRun,
      })),
    });
  }
  if (req.method === 'POST' && urlPath === '/api/schedules') {
    try {
      const body = await readBody(req);
      const p = JSON.parse(body || '{}');
      if (!p.name || !p.type) return jsonResp(res, 400, { error: 'name and type required' });
      const type = ['daily', 'weekly', 'once'].includes(p.type) ? p.type : 'daily';
      const s = {
        id: uuid(),
        name: String(p.name).slice(0, 60),
        enabled: p.enabled !== false,
        type,
        time: p.time || null,
        datetime: p.datetime || null,
        weekdays: Array.isArray(p.weekdays)
          ? p.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
          : null,
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
      if (p.type !== undefined)     s.type = ['daily', 'weekly', 'once'].includes(p.type) ? p.type : 'daily';
      if (p.time !== undefined)     s.time = p.time;
      if (p.datetime !== undefined) s.datetime = p.datetime;
      if (p.weekdays !== undefined) {
        s.weekdays = Array.isArray(p.weekdays)
          ? p.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
          : null;
      }
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

  // GET /api/anomalies.csv — 匯出 CSV(含 UTF-8 BOM 讓 Excel 開不亂碼)
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

    const csvText = buildAnomaliesCsv(list);
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
