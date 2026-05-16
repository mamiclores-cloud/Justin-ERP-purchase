// _keepalive.js — 給 server.js 定時呼叫的 session 檢查腳本
//
// 用 launchWithSession 打開 chrome-profile，goto dashboard。
// 這個動作會：
//   1. 確認 Ajin server 端 session 有效（dashboard 不會 302 到 login）
//   2. ping dashboard 等同於告訴 Ajin「使用者活躍」→ 重設閒置計時器
//   3. cookies 順便被 refresh（如果 server 用 rolling expiration）
//
// 不允許 headed fallback（避免半夜或員工不在時跳出視窗）。
// 若 session 真的失效 → exit 1，server 標記狀態，下次有人實際用時觸發 headed fallback。

const { launchWithSession } = require('./lib/session');
const cfg = require('./secrets');

(async () => {
  let ok = false;
  let msg = '';
  try {
    const { context, page } = await launchWithSession({
      headless: true,
      allowHeadedFallback: false,
    });
    // 雙重保險：再打一次 dashboard 確認沒被踢
    try {
      const r = await context.request.get(cfg.dashboardUrl, { timeout: 15000, maxRedirects: 0 });
      const status = r.status();
      const loc = r.headers()['location'] || '';
      if (status >= 300 && status < 400 && /\/Common\/Login/i.test(loc)) {
        msg = `session expired (302 → ${loc})`;
      } else if (status === 401 || status === 403) {
        msg = `session invalid (HTTP ${status})`;
      } else {
        ok = true;
      }
    } catch (e) {
      msg = 'ping error: ' + e.message;
    }
    await context.close();
  } catch (e) {
    msg = e.message;
  }
  process.stdout.write(ok ? 'VALID\n' : `EXPIRED: ${msg}\n`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  process.stdout.write(`ERROR: ${e.message}\n`);
  process.exit(2);
});
