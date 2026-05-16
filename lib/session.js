// session.js — Ajin ERP 韌性 helper
// 提供：launchWithSession / login / safeGoto / safeAction / startKeepAlive / Checkpoint
//
// 設計目標：長跑自動化（數百筆訂單）跑到一半被踢、token 旋轉、網路抖動
// 都能自動偵測 → 重登 → 重試，並支援 checkpoint 斷點續跑。

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const cfg = require('../secrets');

const LOGIN_PATH_RE = /\/Common\/Login/i;

function ts() {
  return new Date().toISOString().slice(11, 19);
}
function log(tag, msg) {
  console.log(`[${ts()}] [session/${tag}] ${msg}`);
}
function isLoggedOut(url) {
  return LOGIN_PATH_RE.test(String(url || ''));
}
function isTransientError(e) {
  const m = e.message || String(e);
  return /Timeout|timeout|net::ERR|ECONN|ENET|ERR_NETWORK|navigation|Target closed/i.test(m);
}

/* ------------------------------------------------------------------ */
/* login (with in-flight mutex to prevent concurrent re-logins)      */
/* ------------------------------------------------------------------ */

let _loginInFlight = null;

async function login(page, credentials = cfg.credentials) {
  // Mutex：如果已有一個 login 在進行中，所有併發呼叫共用同一個 promise
  if (_loginInFlight) {
    log('login', 'login already in flight — awaiting existing promise');
    return _loginInFlight;
  }
  _loginInFlight = _login(page, credentials).finally(() => {
    _loginInFlight = null;
  });
  return _loginInFlight;
}

async function _login(page, credentials) {
  log('login', '→ navigating to login page');
  await page.goto(cfg.loginUrl, {
    waitUntil: 'domcontentloaded',
    timeout: cfg.resilience.navTimeoutMs,
  });

  // 給頁面 + reCAPTCHA v3 一點時間做 background score 評估
  await page.waitForTimeout(1000);

  const form = page.locator('form').first();
  await form.locator('input[placeholder="商店代碼"]').first().fill(credentials.code);
  await form.locator('input[placeholder="使用者帳號"]').first().fill(credentials.account);
  await form.locator('input[placeholder="密碼"]').first().fill(credentials.password);

  const btn = form
    .locator('button[type="submit"]:visible, button:has-text("登入"):visible')
    .first();

  const navP = page
    .waitForURL((u) => !isLoggedOut(u.toString()), { timeout: 25000 })
    .catch(() => null);
  await btn.click();
  await navP;

  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 });
  } catch {
    /* ignore */
  }

  if (isLoggedOut(page.url())) {
    // 診斷：截圖 + 抓錯誤訊息 + 抓 reCAPTCHA 狀態
    const diagPath = path.join(
      path.dirname(cfg.profileDir),
      `login-failure-${Date.now()}.png`
    );
    try {
      await page.screenshot({ path: diagPath, fullPage: true });
    } catch {}

    const errs = await page
      .locator('.alert, .error, .alert-danger, [class*="error"], .help-block')
      .allInnerTexts()
      .catch(() => []);
    const recaptchaState = await page
      .evaluate(() => {
        const r = document.querySelector('#recaptcha');
        const b = document.querySelector('.grecaptcha-badge');
        return {
          recaptchaInputValue: r ? r.value?.slice(0, 30) + '...' : null,
          badgeVisible: !!b,
        };
      })
      .catch(() => ({}));

    throw new Error(
      `Login failed — still on login page.\n` +
        `  errors: ${errs.filter(Boolean).join(' | ') || '(none visible)'}\n` +
        `  recaptcha: ${JSON.stringify(recaptchaState)}\n` +
        `  screenshot: ${diagPath}`
    );
  }
  log('login', `✓ logged in → ${page.url()}`);
}

/* ------------------------------------------------------------------ */
/* launchWithSession                                                  */
/* ------------------------------------------------------------------ */

async function openContext(profileDir, headless) {
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless,
    viewport: { width: 1440, height: 900 },
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
}

function looksLikeRecaptchaBlock(err) {
  const m = String(err && err.message || err);
  return /recaptcha|Login failed.*login page/i.test(m);
}

// 自動 fallback 機制：headless 登入失敗（reCAPTCHA 觸發）→ 自動切 headed 重試
// 第一次（cookies 失效後）會閃一個 Chrome 視窗，登入完寫回 chrome-profile，
// 之後就全 headless 跑（session 仍有效時）。重開機後 cookies 仍在磁碟上，繼續 headless。
async function launchWithSession(options = {}) {
  const profileDir = options.profileDir || cfg.profileDir;
  const credentials = options.credentials || cfg.credentials;
  const requestedHeadless = options.headless ?? false;
  const allowFallback = options.allowHeadedFallback !== false;  // 預設開

  if (!fs.existsSync(profileDir)) {
    throw new Error(`profile dir not found: ${profileDir}`);
  }

  log('launch', `starting chrome (channel=chrome, headless=${requestedHeadless})`);
  let context = await openContext(profileDir, requestedHeadless);
  let page = context.pages()[0] || (await context.newPage());

  // 主動確認登入態
  await page.goto(cfg.dashboardUrl, {
    waitUntil: 'domcontentloaded',
    timeout: cfg.resilience.navTimeoutMs,
  });

  if (!isLoggedOut(page.url())) {
    log('launch', `session still valid → ${page.url()}`);
    return { context, page };
  }

  log('launch', 'not logged in → running login flow');
  try {
    await login(page, credentials);
    return { context, page };
  } catch (loginErr) {
    if (!requestedHeadless || !allowFallback || !looksLikeRecaptchaBlock(loginErr)) {
      throw loginErr;
    }
    // headless 登入被 reCAPTCHA 擋 — 自動 fallback 開 headed 重試
    log('launch', '⚠ headless login blocked (reCAPTCHA). 自動切換到 headed 模式重試...');
    log('launch', '  (此次會閃一個 Chrome 視窗。下次跑會自動 headless — cookies 已寫入 chrome-profile)');
    try { await context.close(); } catch {}

    context = await openContext(profileDir, false);
    page = context.pages()[0] || (await context.newPage());
    await page.goto(cfg.dashboardUrl, {
      waitUntil: 'domcontentloaded',
      timeout: cfg.resilience.navTimeoutMs,
    });
    if (isLoggedOut(page.url())) {
      await login(page, credentials);
    }
    log('launch', '✓ headed fallback 登入成功 — cookies 已寫入 chrome-profile');
    return { context, page };
  }
}

/* ------------------------------------------------------------------ */
/* safeGoto                                                           */
/* ------------------------------------------------------------------ */

async function safeGoto(page, url, options = {}) {
  const credentials = options.credentials || cfg.credentials;
  const max = options.retries ?? cfg.resilience.actionRetries;
  const timeout = options.timeout || cfg.resilience.navTimeoutMs;

  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      if (isLoggedOut(page.url())) {
        log('safeGoto', `redirected to login during goto(${url}) — re-login`);
        await login(page, credentials);
        continue; // 重試 goto
      }
      return; // 成功
    } catch (e) {
      if (attempt === max) throw e;
      const wait = cfg.resilience.backoffBaseMs * Math.pow(2, attempt);
      log('safeGoto', `goto failed: ${e.message} → retry in ${wait}ms`);
      await page.waitForTimeout(wait);
    }
  }
}

/* ------------------------------------------------------------------ */
/* safeAction                                                         */
/* ------------------------------------------------------------------ */
// 包任何 page 動作。fn 收到 (page)，回傳值會被原樣回傳。
// 偵測：1) 動作完成後 URL 被 302 到 login，2) 動作中拋 transient 錯誤
// 動作：自動重登 + 重試一次

async function safeAction(page, fn, options = {}) {
  const credentials = options.credentials || cfg.credentials;
  const max = options.retries ?? cfg.resilience.actionRetries;
  const label = options.label || 'action';
  let lastErr;

  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      const result = await fn(page);
      if (isLoggedOut(page.url())) {
        log('safeAction', `[${label}] kicked to login post-action → re-login & retry`);
        await login(page, credentials);
        continue;
      }
      return result;
    } catch (e) {
      lastErr = e;
      // 1) 動作中被踢登
      if (isLoggedOut(page.url())) {
        log('safeAction', `[${label}] kicked during action (${e.message}) → re-login & retry`);
        try {
          await login(page, credentials);
        } catch (loginErr) {
          throw new Error(`Re-login failed after kick: ${loginErr.message}`);
        }
        continue;
      }
      // 2) transient 錯誤
      if (isTransientError(e) && attempt < max) {
        const wait = cfg.resilience.backoffBaseMs * Math.pow(2, attempt);
        log('safeAction', `[${label}] transient error: ${e.message} → retry in ${wait}ms`);
        await page.waitForTimeout(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error(`safeAction[${label}] exhausted retries`);
}

/* ------------------------------------------------------------------ */
/* startKeepAlive                                                     */
/* ------------------------------------------------------------------ */
// 背景定期 ping dashboard，避免 idle timeout 把 session 收掉。
// 用 context.request（與 page 共用 cookies）— 不會打斷使用者目前操作的頁面。
// 回傳 stop 函式。

function startKeepAlive(context, options = {}) {
  const credentials = options.credentials || cfg.credentials;
  const interval = options.intervalMs || cfg.resilience.keepAliveIntervalMs;
  let stopped = false;
  let timer;

  const tick = async () => {
    if (stopped) return;
    try {
      const resp = await context.request.get(cfg.dashboardUrl, {
        timeout: 15000,
        maxRedirects: 0,
      });
      const status = resp.status();
      const finalUrl = resp.url();
      if (status >= 300 && status < 400) {
        const loc = resp.headers()['location'] || '';
        if (isLoggedOut(loc)) {
          log('keepalive', `session expired (302 → ${loc}) — re-logging in`);
          const page = context.pages()[0] || (await context.newPage());
          await login(page, credentials);
        } else {
          log('keepalive', `ok (302 to ${loc})`);
        }
      } else if (isLoggedOut(finalUrl) || status === 401 || status === 403) {
        log('keepalive', `session invalid (${status}) — re-logging in`);
        const page = context.pages()[0] || (await context.newPage());
        await login(page, credentials);
      } else {
        log('keepalive', `ok (${status})`);
      }
    } catch (e) {
      log('keepalive', `ping error: ${e.message}`);
    }
    if (!stopped) timer = setTimeout(tick, interval);
  };

  timer = setTimeout(tick, interval);
  log('keepalive', `started (every ${interval / 1000}s)`);
  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    log('keepalive', 'stopped');
  };
}

/* ------------------------------------------------------------------ */
/* Checkpoint                                                         */
/* ------------------------------------------------------------------ */
// 簡單的「已處理 id」記錄器。用 append-only 檔案，crash safe。

class Checkpoint {
  constructor(file) {
    this.file = file;
    this.done = new Set();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file)) {
      fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((id) => this.done.add(id));
    }
  }
  isDone(id) {
    return this.done.has(String(id));
  }
  mark(id) {
    const s = String(id);
    if (this.done.has(s)) return;
    this.done.add(s);
    fs.appendFileSync(this.file, s + '\n');
  }
  size() {
    return this.done.size;
  }
  clear() {
    this.done.clear();
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
  }
}

/* ------------------------------------------------------------------ */
module.exports = {
  launchWithSession,
  login,
  safeGoto,
  safeAction,
  startKeepAlive,
  Checkpoint,
  isLoggedOut,
  isTransientError,
};
