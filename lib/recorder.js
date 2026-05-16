// recorder.js — 攔截使用者操作並寫成 JSONL，方便後續產生自動化腳本
//
// 用法：const { attachRecorder } = require('./lib/recorder');
//        const id = await attachRecorder(context, page);
//
// 攔截的事件：
//   - session-start, page-snapshot
//   - click (含 best selector 候選)
//   - input/change（input/select 的值，密碼會 mask）
//   - navigate (URL 改變)
//   - modal-open / modal-close
//   - request / response (ERP domain，過濾掉 static assets) ← 用於 API reverse engineering
// 所有事件即時寫入 recordings/session-YYYYMMDD-HHmmss.jsonl

const fs = require('fs');
const path = require('path');

// 網路擷取設定
const ERP_HOST_RE = /(srv\d*\.ajinerp\.com|ajinerp\.com)/i;
const SKIP_RESOURCE_TYPES = new Set(['stylesheet', 'image', 'font', 'media', 'manifest', 'other']);
const BODY_CAP_BYTES = 8 * 1024; // 文字/JSON response 留前 8KB
const POST_CAP_BYTES = 16 * 1024; // request body 留更多（form data 通常重要）
const TEXT_CT_RE = /(json|html|xml|text|javascript|x-www-form-urlencoded|plain)/i;

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function attachRecorder(context, page, options = {}) {
  const outDir = options.outDir || path.join(__dirname, '..', 'recordings');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const sessionId = `session-${ts()}`;
  const logFile = path.join(outDir, `${sessionId}.jsonl`);
  const screenshotDir = path.join(outDir, sessionId);
  fs.mkdirSync(screenshotDir, { recursive: true });

  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  let seq = 0;

  function write(ev) {
    seq += 1;
    const line = JSON.stringify({ seq, time: new Date().toISOString(), ...ev });
    stream.write(line + '\n');
    // 同步 echo 到 console 方便觀察
    const summary = formatForConsole(ev, seq);
    if (summary) console.log(summary);
  }

  function formatForConsole(ev, n) {
    const shortUrl = (u) => (u || '').replace(/https?:\/\/[^/]+/, '');
    switch (ev.type) {
      case 'click':
        return `  #${n} CLICK   ${ev.bestSelector}  ⟪${ev.element?.text || ''}⟫`;
      case 'input':
        return `  #${n} INPUT   ${ev.bestSelector}  = ${ev.value}`;
      case 'navigate':
        return `  #${n} NAV     ${ev.from} → ${ev.to}`;
      case 'modal-open':
        return `  #${n} MODAL+  ${ev.title || ''}  (${ev.buttons?.length || 0} buttons)`;
      case 'modal-close':
        return `  #${n} MODAL-`;
      case 'page-snapshot':
        return `  #${n} PAGE    ${ev.title}  (btns:${ev.buttons.length} links:${ev.links.length} inputs:${ev.inputs.length})`;
      case 'session-start':
        return `  #${n} START   ${ev.url}\n         log → ${logFile}`;
      case 'request':
        return `  #${n} ${ev.method.padEnd(6)} → ${shortUrl(ev.url)}${ev.postData ? ` (${ev.postData.length}B body)` : ''}`;
      case 'response':
        return `  #${n} ${String(ev.status).padEnd(6)} ← ${shortUrl(ev.url)}  ${ev.contentType || ''}${ev.bodyTruncated ? ' [trunc]' : ''}`;
      default:
        return null;
    }
  }

  // 暴露給頁面內的 JS 呼叫
  await context.exposeFunction('__recReport', (ev) => write(ev));

  // 注入 init script — 對所有 page（含新開的 tab）都生效
  await context.addInitScript(getInitScriptSource());

  // 初始化 session
  write({
    type: 'session-start',
    url: page.url(),
    viewport: page.viewportSize(),
  });

  // 對當前 page 立即做 snapshot（init script 在 navigation 才會跑）
  await takeSnapshot(page, write, screenshotDir);

  // 監聽 framenavigated（每次 URL 變化做 snapshot）
  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame()) return;
    // 等頁面穩定一下再 snapshot
    setTimeout(() => {
      takeSnapshot(page, write, screenshotDir).catch(() => {});
    }, 1500);
  });

  // context 上新開的 page（如新 tab）也要 instrument
  context.on('page', async (newPage) => {
    write({ type: 'new-page', url: newPage.url() });
    newPage.on('framenavigated', (frame) => {
      if (frame !== newPage.mainFrame()) return;
      setTimeout(() => {
        takeSnapshot(newPage, write, screenshotDir).catch(() => {});
      }, 1500);
    });
  });

  /* --------------- Network capture (ERP domain only) ----------------- */

  // Map request id → request 摘要，方便 response 對應
  const pendingReqs = new Map();

  context.on('request', (req) => {
    try {
      const url = req.url();
      if (!ERP_HOST_RE.test(url)) return;
      if (SKIP_RESOURCE_TYPES.has(req.resourceType())) return;

      let postData = req.postData();
      let postTruncated = false;
      if (postData && postData.length > POST_CAP_BYTES) {
        postData = postData.slice(0, POST_CAP_BYTES);
        postTruncated = true;
      }

      const reqInfo = {
        type: 'request',
        method: req.method(),
        url,
        resourceType: req.resourceType(),
        headers: req.headers(),
        postData,
        postTruncated,
        isNavigation: req.isNavigationRequest(),
      };
      write(reqInfo);

      // 用 url+method+timestamp 當 key (Playwright 沒有公開 request ID)
      pendingReqs.set(req, { method: req.method(), url, t: Date.now() });
    } catch (e) {
      write({ type: 'recorder-error', stage: 'request', error: e.message });
    }
  });

  context.on('response', async (res) => {
    try {
      const url = res.url();
      if (!ERP_HOST_RE.test(url)) return;
      const req = res.request();
      if (SKIP_RESOURCE_TYPES.has(req.resourceType())) return;

      const headers = res.headers();
      const ct = headers['content-type'] || '';
      const status = res.status();

      let body = null;
      let bodyTruncated = false;
      let bodySize = null;

      // 只擷取文字類 body
      if (TEXT_CT_RE.test(ct)) {
        try {
          // 等 response body 可用，最多等 5 秒
          const text = await Promise.race([
            res.text(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('body timeout')), 5000)),
          ]);
          bodySize = text.length;
          if (text.length > BODY_CAP_BYTES) {
            body = text.slice(0, BODY_CAP_BYTES);
            bodyTruncated = true;
          } else {
            body = text;
          }
        } catch (e) {
          body = `[body unavailable: ${e.message}]`;
        }
      } else if (/pdf/i.test(ct)) {
        body = `[PDF binary]`;
        bodySize = parseInt(headers['content-length'] || '0', 10) || null;
      } else if (ct) {
        body = `[binary: ${ct}]`;
      }

      write({
        type: 'response',
        method: req.method(),
        url,
        status,
        contentType: ct,
        headers,
        body,
        bodySize,
        bodyTruncated,
        timing: pendingReqs.get(req) ? Date.now() - pendingReqs.get(req).t : null,
      });
      pendingReqs.delete(req);
    } catch (e) {
      write({ type: 'recorder-error', stage: 'response', error: e.message });
    }
  });

  context.on('requestfailed', (req) => {
    try {
      const url = req.url();
      if (!ERP_HOST_RE.test(url)) return;
      write({
        type: 'request-failed',
        method: req.method(),
        url,
        failure: req.failure()?.errorText,
      });
    } catch {}
  });

  return { sessionId, logFile, screenshotDir };
}

async function takeSnapshot(page, write, screenshotDir) {
  try {
    const info = await page.evaluate(() => {
      const pick = (el) => {
        const r = el.getBoundingClientRect();
        return {
          text: (el.innerText || el.value || el.textContent || '').trim().slice(0, 80),
          id: el.id || null,
          name: el.getAttribute('name') || null,
          classes: (el.className?.toString() || '').slice(0, 80),
          type: el.getAttribute('type') || null,
          placeholder: el.getAttribute('placeholder') || null,
          href: el.getAttribute('href') || null,
          visible: r.width > 0 && r.height > 0,
        };
      };
      return {
        title: document.title,
        buttons: [...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')]
          .filter((el) => el.offsetParent !== null)
          .slice(0, 80)
          .map(pick),
        links: [...document.querySelectorAll('a[href]')]
          .filter((el) => el.offsetParent !== null)
          .slice(0, 80)
          .map(pick),
        inputs: [...document.querySelectorAll('input, select, textarea')]
          .filter((el) => el.offsetParent !== null && el.type !== 'hidden')
          .slice(0, 50)
          .map(pick),
        modalsOpen: [...document.querySelectorAll('.modal.show, [role="dialog"][aria-modal="true"], .swal2-shown, .modal.in')]
          .map((el) => ({
            text: (el.innerText || '').trim().slice(0, 200),
            classes: (el.className?.toString() || '').slice(0, 80),
          })),
      };
    });
    const url = page.url();
    const shotName = `${Date.now()}.png`;
    await page.screenshot({ path: path.join(screenshotDir, shotName), fullPage: false }).catch(() => {});
    write({ type: 'page-snapshot', url, screenshot: shotName, ...info });
  } catch (e) {
    write({ type: 'snapshot-error', error: e.message });
  }
}

function getInitScriptSource() {
  // 字串化的 init script，會在每個頁面 navigation 前注入
  return /* js */ `
    (() => {
      if (window.__recAttached) return;
      window.__recAttached = true;

      function bestSelector(el) {
        if (!el || !el.tagName) return null;
        const tag = el.tagName.toLowerCase();
        if (el.id) return '#' + el.id;
        const name = el.getAttribute('name');
        if (name) return tag + '[name="' + name + '"]';
        const type = el.getAttribute('type');
        const placeholder = el.getAttribute('placeholder');
        if (placeholder) return tag + '[placeholder="' + placeholder + '"]';
        const text = (el.innerText || el.value || '').trim();
        if (text && text.length < 40) {
          return tag + ':has-text("' + text.replace(/"/g, '\\\\"') + '")';
        }
        if (type) return tag + '[type="' + type + '"]';
        return tag;
      }

      function pickElement(el) {
        if (!el) return null;
        return {
          tag: el.tagName,
          text: (el.innerText || el.value || el.textContent || '').trim().slice(0, 80),
          id: el.id || null,
          name: el.getAttribute('name') || null,
          classes: (el.className?.toString() || '').slice(0, 80),
          type: el.getAttribute('type') || null,
          placeholder: el.getAttribute('placeholder') || null,
          role: el.getAttribute('role') || null,
          href: el.getAttribute('href') || null,
        };
      }

      function flash(el) {
        try {
          const orig = el.style.outline;
          const origOffset = el.style.outlineOffset;
          el.style.outline = '3px solid #ffd700';
          el.style.outlineOffset = '2px';
          setTimeout(() => {
            el.style.outline = orig;
            el.style.outlineOffset = origOffset;
          }, 500);
        } catch {}
      }

      // 在右下角加上錄製指示
      function showBadge() {
        if (document.getElementById('__rec_badge')) return;
        const div = document.createElement('div');
        div.id = '__rec_badge';
        div.textContent = '● REC';
        div.style.cssText = 'position:fixed;bottom:8px;right:8px;background:#d32f2f;color:#fff;padding:4px 10px;border-radius:14px;font:bold 12px monospace;z-index:2147483647;box-shadow:0 2px 6px rgba(0,0,0,.3);pointer-events:none;';
        (document.body || document.documentElement).appendChild(div);
      }
      if (document.body) showBadge();
      else document.addEventListener('DOMContentLoaded', showBadge);

      // Click recorder — capture phase 確保在頁面 stopPropagation 之前抓到
      document.addEventListener('click', (e) => {
        // 找最近的可互動元素
        const interactive = e.target.closest('button, a, input, label, select, [role="button"], [onclick]') || e.target;
        flash(interactive);
        if (!window.__recReport) return;
        try {
          window.__recReport({
            type: 'click',
            url: location.href,
            element: pickElement(interactive),
            bestSelector: bestSelector(interactive),
          });
        } catch {}
      }, true);

      // Input change recorder（防抖：input 結束停 300ms 才報）
      const inputTimers = new WeakMap();
      function reportInput(el) {
        if (!window.__recReport) return;
        let value = el.value;
        // 密碼遮罩
        if (el.type === 'password') value = '*'.repeat(Math.min(value.length, 12));
        try {
          window.__recReport({
            type: 'input',
            url: location.href,
            element: pickElement(el),
            bestSelector: bestSelector(el),
            value,
            inputType: el.type,
          });
        } catch {}
      }
      document.addEventListener('input', (e) => {
        const el = e.target;
        if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT')) return;
        clearTimeout(inputTimers.get(el));
        inputTimers.set(el, setTimeout(() => reportInput(el), 300));
      }, true);
      document.addEventListener('change', (e) => {
        const el = e.target;
        if (!el || (el.tagName !== 'SELECT' && el.type !== 'checkbox' && el.type !== 'radio')) return;
        if (!window.__recReport) return;
        try {
          window.__recReport({
            type: 'change',
            url: location.href,
            element: pickElement(el),
            bestSelector: bestSelector(el),
            value: el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value,
          });
        } catch {}
      }, true);

      // URL 變化（SPA 內部 push state）
      let lastUrl = location.href;
      function checkUrl() {
        if (location.href !== lastUrl) {
          if (window.__recReport) {
            try { window.__recReport({ type: 'navigate', from: lastUrl, to: location.href }); } catch {}
          }
          lastUrl = location.href;
        }
      }
      const _push = history.pushState;
      const _replace = history.replaceState;
      history.pushState = function(){ _push.apply(this, arguments); setTimeout(checkUrl, 0); };
      history.replaceState = function(){ _replace.apply(this, arguments); setTimeout(checkUrl, 0); };
      window.addEventListener('popstate', checkUrl);

      // Modal 偵測（MutationObserver 觀察 body 的新增節點）
      const SEEN_MODALS = new WeakSet();
      function checkModal(node) {
        if (!node || node.nodeType !== 1) return;
        const modalRoots = [];
        if (node.matches && node.matches('.modal.show, .modal.in, [role="dialog"][aria-modal="true"], .swal2-popup, .swal2-shown')) {
          modalRoots.push(node);
        }
        if (node.querySelectorAll) {
          node.querySelectorAll('.modal.show, .modal.in, [role="dialog"][aria-modal="true"], .swal2-popup').forEach(m => modalRoots.push(m));
        }
        modalRoots.forEach((m) => {
          if (SEEN_MODALS.has(m)) return;
          SEEN_MODALS.add(m);
          const title = (m.querySelector('.modal-title, .swal2-title, h1, h2, h3')?.innerText || '').trim();
          const buttons = [...m.querySelectorAll('button, [role="button"], input[type="submit"]')]
            .filter(b => b.offsetParent !== null)
            .map(b => ({
              text: (b.innerText || b.value || '').trim().slice(0, 50),
              selector: bestSelector(b),
            }));
          if (window.__recReport) {
            try {
              window.__recReport({
                type: 'modal-open',
                url: location.href,
                title,
                text: (m.innerText || '').trim().slice(0, 500),
                buttons,
                classes: (m.className?.toString() || '').slice(0, 80),
              });
            } catch {}
          }
        });
      }

      function startMutationObs() {
        if (!document.body) return setTimeout(startMutationObs, 100);
        new MutationObserver((muts) => {
          for (const m of muts) {
            m.addedNodes.forEach(checkModal);
          }
        }).observe(document.body, { childList: true, subtree: true });

        // 初次掃一遍既存的
        document.querySelectorAll('.modal.show, .modal.in, [role="dialog"][aria-modal="true"], .swal2-popup').forEach(checkModal);
      }
      startMutationObs();

      // 鍵盤 ESC + Enter 也記下（很多 Modal 用 keyboard 確認）
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== 'Escape') return;
        if (!window.__recReport) return;
        try {
          window.__recReport({
            type: 'key',
            url: location.href,
            key: e.key,
            element: pickElement(e.target),
          });
        } catch {}
      }, true);
    })();
  `;
}

module.exports = { attachRecorder };
