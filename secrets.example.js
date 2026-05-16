// secrets.example.js — 複製此檔成 secrets.js 並填入實際憑證
// secrets.js 已在 .gitignore，不會 commit 到 git
//
// 使用：
//   cp secrets.example.js secrets.js
//   # 編輯 secrets.js 填入你的商店代碼/帳號/密碼

const path = require('path');

module.exports = {
  // ===== ERP 連線 =====
  baseUrl: 'https://srv01.ajinerp.com',
  loginUrl: 'https://srv01.ajinerp.com/Common/Login',
  // 此帳號對 /Home/Dashboard 無權限會 302 到 /Home/Error，改用實際有權限的頁面當起點
  dashboardUrl: 'https://srv01.ajinerp.com/Order/ShopeeReady',

  // ===== Chrome Profile 路徑 =====
  // 啟動 Playwright 時用的 user data dir（複製自系統 Chrome 而來）
  profileDir: path.join(__dirname, 'chrome-profile'),

  // ===== 登入憑證 =====
  credentials: {
    code: 'YOUR_STORE_CODE',          // 商店代碼，如 31743824
    account: 'YOUR_ACCOUNT',          // 使用者帳號
    password: 'YOUR_PASSWORD',        // 密碼
  },

  // ===== 韌性參數 =====
  resilience: {
    keepAliveIntervalMs: 5 * 60 * 1000,   // 5 分鐘 ping 一次防 idle timeout
    actionRetries: 2,                       // safeAction 最多重試 2 次
    backoffBaseMs: 1500,                    // 指數退避起點
    navTimeoutMs: 30000,                    // 導航逾時 30 秒
  },
};
