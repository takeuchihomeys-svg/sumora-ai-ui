"use strict";
/**
 * 2.8.298 竹内さん「0件ヒット時の長い空回り」「約190秒の入力停止」を改善する
 *   ① 0件の空回り: 結果が 0棟0戸 と3回続けて読めたら、行の出るのを待たず 0件で終える（自動の回だけ）
 *   ② 入力停止: 停止（人が手を止める間）の安全弁＋止まった時に「列の何が止まっているか」を点検に残す
 *   実測の元: 監査 #1654（0棟0戸で rows0 が 0.8秒ごとに49回・300秒まで次へ進まず）／
 *            約190秒の入力停止（`賃料下限（1/11）` で止まり、条件入力の上限 300秒が先に切れた）
 */
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const bulk = fs.readFileSync(path.join(EXT, "bulk-dl.js"), "utf8");
const ps = fs.readFileSync(path.join(EXT, "page-script.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra).slice(0, 300) : "")); }
}

// ── ① 0件の判定を、実際のソースから取り出して動かす ──
const start = bulk.indexOf("  var _zeroCount0N = 0;");
const end = bulk.indexOf("  var _pageWaitN = 0;");
const fnSrc = start > 0 && end > start ? bulk.slice(start, end) : "";

function makeChecker(st) {
  const factory = new Function("st", `
    var _autoSendArmed = st.armed;
    var _autoRunCid = st.cid;
    var _searchGraspedMem = st.grasp || null;
    var _sortCursorTimer = null;
    var _pendingAutoSendDispatched = false;
    var _localScreenEvidenceBrief = function () { return st.brief(); };
    var _liveDlStep = function () {};
    var _stampSortFlowAtom = function () {};
    var sent = [];
    var _sendSkipDoneFor = function (cid, why, n) { sent.push({ cid: cid, why: why, n: n }); };
    var chrome = { storage: { session: { remove: function () {} } } };
    ${fnSrc}
    return {
      check: _zeroCount0Check,
      state: function () { return { armed: _autoSendArmed, dispatched: _pendingAutoSendDispatched, sent: sent }; }
    };
  `);
  return factory(st);
}
const brief = (count, pdf) => () => ({ count: count, pdf: pdf, first: "", brief: "" });

console.log("■ ① 0件の判定（0棟0戸が3回続けて読めた時だけ 0件で終える）");
ok("関数を実ソースから取り出せた（配線が消えていない）", fnSrc.length > 200, fnSrc.length);
ok("rows0 の待ちから 0件確認を呼んでいる", /if \(_zeroCount0Check\(why\)\) return false;/.test(bulk));

{
  const c = makeChecker({ armed: true, cid: "cid-1111", brief: brief("0/0", 0) });
  const r1 = c.check("t"), r2 = c.check("t");
  ok("1回・2回目はまだ決めない（読み込み中の一瞬の 0 を取り違えない）", r1 === false && r2 === false && c.state().sent.length === 0);
  const r3 = c.check("t");
  const s = c.state();
  ok("3回目で 0件として終える（true）", r3 === true, r3);
  ok("押さずに終わった合図を1回だけ送る（why=zero_rows_count0・件数0）",
    s.sent.length === 1 && s.sent[0].cid === "cid-1111" && s.sent[0].why === "zero_rows_count0" && s.sent[0].n === 0, s.sent);
  ok("終わった後は自動を閉じる（armed=false・dispatched=true）", s.armed === false && s.dispatched === true, s);
}
{
  // 0/0 → 0/0 → 1/0（行が出始めた）→ 0/0 … 途切れたら数え直す
  let seq = ["0/0", "0/0", "1/0", "0/0", "0/0"]; let i = 0;
  const c = makeChecker({ armed: true, cid: "cid-2", brief: () => ({ count: seq[i++] || "0/0", pdf: 0 }) });
  const res = [c.check(), c.check(), c.check(), c.check(), c.check()];
  ok("途中で件数が出たら数え直す（0/0 が3回続くまで終えない）", res.every((x) => x === false) && c.state().sent.length === 0, res);
}
{
  const c = makeChecker({ armed: true, cid: "cid-3", brief: brief("０/０", 0) });
  c.check(); c.check(); const r = c.check();
  ok("全角の「０棟０戸」も 0/0 と読む", r === true && c.state().sent.length === 1, c.state());
}
{
  const c = makeChecker({ armed: true, cid: "cid-4", brief: brief("0/0", 2) });
  const res = [c.check(), c.check(), c.check(), c.check()];
  ok("PDF の印があるなら 0件として終えない（件数の読みが違う疑い）", res.every((x) => x === false) && c.state().sent.length === 0, res);
}
{
  const c = makeChecker({ armed: false, cid: "cid-5", brief: brief("0/0", 0) });
  const res = [c.check(), c.check(), c.check(), c.check()];
  ok("自動の回でない（armed=false）時は手を出さない", res.every((x) => x === false) && c.state().sent.length === 0, res);
}
{
  const c = makeChecker({ armed: true, cid: null, grasp: null, brief: brief("0/0", 0) });
  const res = [c.check(), c.check(), c.check(), c.check()];
  ok("番号（cid）が分からない時は送らない（取り違え防止）", res.every((x) => x === false) && c.state().sent.length === 0, res);
}
{
  const c = makeChecker({ armed: true, cid: "cid-6", brief: brief("", 0) });
  const res = [c.check(), c.check(), c.check(), c.check()];
  ok("件数が読めない時は 0件 と決めない", res.every((x) => x === false) && c.state().sent.length === 0, res);
}

// ── ② 入力停止: 停止の安全弁と点検の印（page-script.js）──
console.log("■ ② 入力停止（停止の安全弁＋止まった時の点検）");
ok("停止の終わりは1回だけ（_pauseSettled）", /var _pauseSettled = false;[\s\S]{0,260}if \(_pauseSettled\) return;\s*_pauseSettled = true;/.test(ps));
ok("pause＋15秒で必ず次へ（fill_pause_force の印つき）", /setTimeout\(function \(\) \{\s*if \(_pauseSettled\) return;[\s\S]{0,200}fill_pause_force[\s\S]{0,120}\}, pause \+ 15000\);/.test(ps));
ok("止まった時の点検に列の状態（q=…）を残す", /_probe0 = \(typeof _clickQueue/.test(ps) && /\+ " q=" \+ _probe0/.test(ps));
ok("版 2.8.298 が page-script に入っている", /_AXLX_PAGE_VER = "2\.8\.298"/.test(ps));

console.log("");
console.log("結果: " + pass + " 件 OK / " + fail + " 件 NG");
if (fail > 0) process.exit(1);
