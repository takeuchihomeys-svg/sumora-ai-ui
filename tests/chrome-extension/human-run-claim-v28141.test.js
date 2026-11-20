// tests/chrome-extension/human-run-claim-v28141.test.js
// 実行: node tests/chrome-extension/human-run-claim-v28141.test.js
// 2026-11-20 竹内さん「そして画面録画してい ここからも原因見つけて改善する」
//   録画の回（run mwoppjwh_y6ev）と search_audits 1545/1546 で判明:
//   ・人が始めた平田さんの自動検索（single・08:24:28）の7秒後に 16時の自動便（auto_schedule）を拾い、同じタブで2本目が始まった
//   ・1本目は所在地を開いた所（08:24:42）で止まり6分後に idle_close、2本目は記録0のまま running
//   ・拾う側は人の自動検索を見ていない／一括側は「別のお客さんの入力中は待つ」より前に 0.7秒で答えないページを読み直す
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const G = require(path.join(dir, "batch-guard.js"));
const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); }
}
const T = 1795163068000;
const single = { trigger: "single", started_at: T - 7000, finished: false, property_customer_id: "3b62b7e1" };

console.log("■ ① 人の回が開いている間は命令を拾わない");
{
  ok("  人の回（single）が7秒前に始まった → 拾わない", G.claimBlockedByHumanRun(single, null, T) === "human_run_open");
  ok("  local も同じ", G.claimBlockedByHumanRun({ ...single, trigger: "local" }, null, T) === "human_run_open");
  ok("  終わった人の回は数えない", G.claimBlockedByHumanRun({ ...single, finished: true }, null, T) === null);
  ok("  一括の回（bulk_queue）は数えない（一括はロックで守る）", G.claimBlockedByHumanRun({ ...single, trigger: "bulk_queue" }, null, T) === null);
  ok("  ⚠ 20分を過ぎた閉じ忘れの回では止め続けない", G.claimBlockedByHumanRun({ ...single, started_at: T - 21 * 60 * 1000 }, null, T) === null);
  ok("  何も無ければ拾う", G.claimBlockedByHumanRun(null, null, T) === null);
}

console.log("\n■ ② ページで入力が進んでいる間も拾わない（記録の無い回の保険）");
{
  ok("  fillRunning → 拾わない", G.claimBlockedByHumanRun(null, { pong: true, fillRunning: true }, T) === "page_fill_running");
  ok("  答えの無いタブは今まで通り（拾う）", G.claimBlockedByHumanRun(null, { pong: false, fillRunning: true }, T) === null);
  ok("  入力していなければ拾う", G.claimBlockedByHumanRun(null, { pong: true, fillRunning: false }, T) === null);
  ok("  理由は日本語で出せる", /人が始めた自動検索/.test(G.reasonJa("human_run_open")) && /入力が進行中/.test(G.reasonJa("page_fill_running")));
}

console.log("\n■ ③ ページが忙しいだけの時、人の回の最中は読み直さない");
{
  const busy = { url: "https://www.realnetpro.com/main.php?method=estate", pong: true, page: false };
  ok("  ページが0.7秒で答えない＝今までは読み直しの判定", G.realproTabPlan(busy).action === "reload" && G.realproTabPlan(busy).reason === "page_script_dead");
  ok("  ⚠ 人の回が進行中なら読み直さない", G.holdReloadForBusyPage(busy, single, T) === true);
  ok("  人の回が無ければ今まで通り読み直してよい", G.holdReloadForBusyPage(busy, null, T) === false);
  ok("  content.js も答えない（本当に死んでいる）なら読み直してよい", G.holdReloadForBusyPage({ ...busy, pong: false }, single, T) === false);
  ok("  ページが答えた時は関係ない", G.holdReloadForBusyPage({ ...busy, page: true }, single, T) === false);
}

console.log("\n■ ④ background が使っている（場所と順番）");
{
  const iPoll = bg.indexOf("async function _pollAndRunBatch()");
  const iBlock = bg.indexOf("claimBlockedByHumanRun(_humanRun, _rpProbe)", iPoll);
  const iFetch = bg.indexOf('"/api/automation/pending"', iPoll);
  ok("  命令を取りに行く前に人の回を見る", iPoll > 0 && iBlock > iPoll && iBlock < iFetch, { iPoll, iBlock, iFetch });
  ok("  拾わない時は return（命令は pending のまま）", /if \(_claimBlock\) \{[\s\S]{0,300}?return;/.test(bg.slice(iBlock)));
  const iEns = bg.indexOf("async function _ensureRealproTab(");
  const iHold = bg.indexOf("holdReloadForBusyPage(probe, _openHumanRun(\"realpro\"))", iEns);
  const iReload = bg.indexOf("chrome.tabs.reload(tab.id)", iEns);
  ok("  読み直す前に人の回を見る", iEns > 0 && iHold > iEns && iHold < iReload, { iEns, iHold, iReload });
  ok("  ページの答えが遅いだけなら2回まで確かめ直す", /for \(var _rp = 0; _rp < 2; _rp\+\+\)/.test(bg.slice(iEns, iReload)));
  ok("  見送りは AXLX_OTHER_FILL_RUNNING（一括の最後にもう1回やり直す扱い）", /AXLX_OTHER_FILL_RUNNING: 人が始めた自動検索が進行中/.test(bg.slice(iEns, iReload)));
  ok("  customer-handoff がこの文をやり直しの対象として読む", /AXLX_OTHER_FILL_RUNNING/.test(fs.readFileSync(path.join(dir, "customer-handoff.js"), "utf8")));
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
