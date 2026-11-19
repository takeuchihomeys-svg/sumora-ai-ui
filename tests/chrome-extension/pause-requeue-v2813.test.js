// 実行: node tests/chrome-extension/pause-requeue-v2813.test.js
// v2.8.113 タクヤ audit #1513「沿線選択でとまった」:
//   長い停止（fill_pause）の時に列から取り出した1件を捨てていた → その欄は __axPending だけ残り二度と押せず、
//   沿線の段が「全部チェック待ち」を約40秒回り続けた。あわせて実行記録の段が進捗のたびに重複し、120件の上限で後ろが押し出されていた。
const fs = require("fs");
const path = require("path");
const ps = fs.readFileSync(path.join(__dirname, "../../chrome-extension/page-script.js"), "utf8");
const A = require("../../chrome-extension/search-audit.js");

let pass = 0, fail = 0;
function ok(name, c, detail) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail !== undefined ? "  " + JSON.stringify(detail) : "")); }
}
function between(a, b) {
  const i = ps.indexOf(a);
  if (i < 0) return "";
  const j = ps.indexOf(b, i + a.length);
  return ps.slice(i, j > 0 ? j : i + 4000);
}

console.log("\n■ 長い停止の後もその1件を押す（捨てない）");
const drain = between("function _scheduleClickDrain()", "function isClickQueueBusy()");
const pauseIdx = drain.indexOf("var pause = _longPauseDue(item);");
const pauseBlock = drain.slice(pauseIdx, drain.indexOf("return;", pauseIdx) + 7);
ok("停止の分岐がある", pauseIdx > 0);
ok("止まった1件を列の先頭へ戻す（unshift）", /_clickQueue\.unshift\(item\);/.test(pauseBlock));
ok("戻す前に「止まり済み」の印を付ける", pauseBlock.indexOf("item._pauseDone = true;") >= 0 && pauseBlock.indexOf("item._pauseDone = true;") < pauseBlock.indexOf("_clickQueue.unshift(item);"));
ok("戻した後に忙しい印を外して停止へ入る", pauseBlock.indexOf("_clickQueue.unshift(item);") < pauseBlock.indexOf("_clickBusyItem = null;") && /_holdingPause = true;/.test(pauseBlock));
const lp = between("function _longPauseDue(item)", "function _hesitateThen(");
ok("止まり済みの1件では二度止まらない", /if \(item && item\._pauseDone\) return 0;/.test(lp));

console.log("\n■ 印だけ残った欄を二度と押せない状態にしない");
const cq = between("function clearClickQueue()", "var _axHumanTookOver");
ok("列を空にする時、処理中の1件の印も外す", /_clickBusyItem && _clickBusyItem\.el\) _clickBusyItem\.el\.__axPending = false;/.test(cq));
const enq = between("function enqueueHumanClick(", "el.__axPending = true;");
ok("列にも処理中にも無い印は外して積み直す", /if \(el\.__axPending && !_isElQueuedOrBusy\(el\)\)/.test(enq) && /stale_pending_reset/.test(enq));
ok("_isElQueuedOrBusy が列と処理中の両方を見る", /function _isElQueuedOrBusy\(el\)[\s\S]{0,200}_clickBusyItem\.el === el[\s\S]{0,200}_clickQueue\[qi\]\.el === el/.test(ps));

console.log("\n■ 沿線の待ちが長い時は足りない沿線を記録する");
ok("station_line_wait（10回ごと・未チェックの沿線名）", /_auditStepP\("station_line_wait", window\.__axlxLineWaitN \+ "回待ち 未チェック="/.test(ps));
ok("沿線がそろったら待ち回数を戻す", /try \{ window\.__axlxLineWaitN = 0; \} catch \(_\) \{\}\s*return true;/.test(ps));

console.log("\n■ 実行記録の段が重ならない（実際に動かす）");
const tr = A.createTracker({ post: function () { return Promise.resolve(); } });
const run = tr.begin({ trigger: "single", site: "realpro", customer_id: "c-test", post_started: false });
const s1 = [
  { k: "page_ver", d: "2.8.115", at: 1000 },
  { k: "fill_start", d: "station", at: 1001 },
  { k: "station_line", d: "沿線を選ぶ", at: 1002 },
];
tr.attachProgress(run.run_id, s1);
tr.attachProgress(run.run_id, s1);
tr.attachProgress(run.run_id, s1.concat([{ k: "station_line", d: "沿線を選ぶ", at: 1800 }]));
const pageSteps = run.steps.filter((s) => /^page:/.test(s.k));
ok("同じ一覧を3回送っても page の段は4件（重複なし）", pageSteps.length === 4, pageSteps.map((s) => s.k + "@" + s.at));
ok("同じ名前でも時刻が違う段は残す", pageSteps.filter((s) => s.k === "page:station_line").length === 2);
tr.attachFill(run.run_id, { audit: { v: 1, steps: s1.concat([{ k: "done_error", d: "x", at: 1900 }]) } });
const afterFill = run.steps.filter((s) => /^page:/.test(s.k));
ok("終わりの合図で同じ段を送り直しても重ならない", afterFill.length === 5, afterFill.map((s) => s.k + "@" + s.at));

console.log("\n■ 版");
const mf = JSON.parse(fs.readFileSync(path.join(__dirname, "../../chrome-extension/manifest.json"), "utf8"));
ok("manifest が 2.8.115", mf.version === "2.8.115", mf.version);
ok("_AXLX_PAGE_VER が 2.8.115", /var _AXLX_PAGE_VER = "2\.8\.115";/.test(ps));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
