// record-workflow.js — 開啟瀏覽器、附加錄製器、保持開啟讓使用者操作
//
// 跑：node record-workflow.js
// 結束：使用者關閉瀏覽器，或在這個 process Ctrl+C
//
// 錄製內容寫到 recordings/session-YYYYMMDD-HHmmss.jsonl
// 同步畫面截圖到 recordings/session-XXX/*.png

const { launchWithSession } = require('./lib/session');
const { attachRecorder } = require('./lib/recorder');

(async () => {
  console.log('=== Workflow Recorder ===');
  console.log('1. 瀏覽器開啟並自動登入');
  console.log('2. 你按照流程操作，每個動作會即時記錄');
  console.log('3. 操作完直接關閉瀏覽器，或在終端按 Ctrl+C\n');

  const { context, page } = await launchWithSession();
  const { sessionId, logFile, screenshotDir } = await attachRecorder(context, page);

  console.log(`\n📼 Recording → ${logFile}\n`);
  console.log(`(右下角紅色 ● REC 表示錄製中)\n`);

  let stopping = false;
  async function stop(reason) {
    if (stopping) return;
    stopping = true;
    console.log(`\n[recorder] stopping (${reason}) — sessionId: ${sessionId}`);
    try { await context.close(); } catch {}
    console.log(`[recorder] log saved: ${logFile}`);
    console.log(`[recorder] screenshots: ${screenshotDir}`);
    process.exit(0);
  }

  context.on('close', () => stop('context closed'));
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // 等到使用者關閉
  await new Promise(() => {});
})().catch((e) => {
  console.error('[recorder][FATAL]', e.message);
  console.error(e.stack);
  process.exit(1);
});
