// 2.8.131: 人の押し方（二重押し・カーソル無しの押し）と、連続のお客さんの止まり・取り違えの穴
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("✓ " + name); } else { fail++; console.log("✗ " + name); } }

const root = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const ps = read("page-script.js");
const pu = read("pointer-ui.js");
const ct = read("content.js");
const bd = read("bulk-dl.js");
const bg = read("background.js");
const ub = read("underbar.js");
const H = require(path.join(root, "customer-handoff.js"));

function body(src, name) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) return "";
  let d = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return "";
}

// ── 人の押し方 ──
ok("押しの中（_fireAt）では深さを数える", /_axFireDepth\+\+; _axFireEl = el;/.test(ps));
ok("_clickEl は押しの中ならカーソルを動かし直さない", /if \(_axFireDepth > 0\) \{ el\.click\(\); return; \}/.test(body(ps, "_clickEl")));
ok("fireClick も押しの中なら1回だけ", /_axFireDepth > 0/.test(body(ps, "fireClick")));
ok("simulateClick も押しの中なら二重に押し込まない", /_axFireDepth > 0/.test(body(ps, "simulateClick")));
ok("隠れた checkbox は見える label へカーソルを動かして押す", /_proxy = _labelForCheckbox\(el\)/.test(ps) && /return _humanPointerClickCore\(_proxy, function \(\) \{ return fire\(el\); \}/.test(ps));
ok("見える物が無い時は点検に hidden_press を残す", /_auditStepP\("hidden_press"/.test(ps));
ok("「検索条件を表示」は1か所・4秒に1回・カーソル経由", /function _axPressShowSidebar\(\)/.test(ps) && /Date\.now\(\) - _axShowBtnAt < 4000/.test(ps));
ok("content.js はページ側へ頼む（カーソル無しで押さない）", /from: "axlx-press-show-sidebar"/.test(ct) && /data-axlx-ps/.test(ct));
// 退役（段階1・2026-11-27）: 1つずつ外しを廃止したため確認対象外 — 次のお客さんの前の片付けは、見えない場所の欄を直接外さない
// 退役（段階1・2026-11-27）: 1つずつ外しを廃止したため確認対象外 — label で外した後すぐ input を押し直さない
ok("次ページ・並べ替えは着いてから少し間を置いて押す", (bd.match(/着いてすぐ押さない/g) || []).length >= 2);

// カーソルの通り道で行・部屋メニューに mousemove を投げない
const mv = new Function("return " + body(pu, "_moveEvTarget"))();
const fakeRow = { closest: (s) => (s === "tr" ? {} : null) };
const fakeMenu = { closest: (s) => (/room_menu/.test(s) ? {} : null) };
const fakeBtn = { closest: () => null };
ok("通り道の行には mousemove を投げない", mv(fakeRow, true) === null);
ok("着いた先の行の要素には投げる（押す相手）", mv(fakeRow, false) === fakeRow);
ok("部屋メニューには投げない", mv(fakeMenu, false) === null);
ok("ふつうの要素には投げる", mv(fakeBtn, true) === fakeBtn);

// ── 連続のお客さん ──
const set = new Set();
ok("OTHER_FILL_RUNNING も1回やり直す", H.busyRetryDecision("AXLX_OTHER_FILL_RUNNING: x", 1, set) === "retry");
ok("SEND_HOLD も1回やり直す", H.busyRetryDecision("AXLX_PIPELINE_SEND_HOLD: x", 2, set) === "retry");
ok("2回目は飛ばす", H.busyRetryDecision("AXLX_PIPELINE_SEND_HOLD: x", 2, set) === "give_up");

const hold = new Function(body(bg, "_sendHoldCid") + "; return _sendHoldCid;")();
ok("送付途中の hold: 新しい物は効く", hold({ cid: "A", at: Date.now() }) === "A");
ok("送付途中の hold: 15分を過ぎた物は効かない", hold({ cid: "A", at: Date.now() - 16 * 60000 }) === null);
ok("送付途中の hold: 時刻の無い旧形式は効かない", hold("A") === null);
ok("送付途中の hold: 完了合図で落とす時は古くても番号を返す", hold("A", true) === "A");

ok("終わった前のお客さんの遅れた合図は次の人の待ちを解かない", /_isRecentlyFinishedCid\(customerId\)/.test(bg) && /batch_done_late_prev/.test(bg));
ok("押さずに終わった合図（skipped）は先回りで覚えない", /!skippedRun && _batchCustomerDoneWaiters\.length === 0/.test(bg));
ok("一括が生きている間はアラームが2本目を始めない", /if \(_batchLoopAlive && !_loopStale\)/.test(bg));
ok("手動の一括も二重に始めない", /_manualBulkAlive = true;/.test(bg) && /error: "batch_running"/.test(bg));
ok("直接入力の予備もお客さんの番号を付ける", /customerId: cid \|\| null \}, "\*"\);/.test(bg));
ok("fill-done の待ちを解く時に見張りも止める", /if \(w\.stopInterval\) clearInterval\(w\.stopInterval\)/.test(bg));

ok("underbar は番号無しの「入力を始めた」を出さない", !/from: "axlx-autofill-initiated"/.test(ub));
ok("ページ側の失敗（見張り切れ・検索画面へ移れない等）は成功として届かない", /no_search_form\|watchdog-timeout\|stuck_superseded\|fill_exception/.test(ct));
ok("3分以上止まった前客は前客の番号で閉じて次へ", /stuck_prev_closed/.test(ps) && /stuck_superseded: /.test(ps));
ok("片方だけ番号が無い＝別の人", /\(_runCid \|\| _newCid\) && String\(_runCid \|\| ""\) !== String\(_newCid \|\| ""\)/.test(ps));
ok("番号の分からない入力中は別のお客さん宛ての clear で壊さない", /cur == null && window\._axFillRunning/.test(ps));
ok("住居検索へ移った後も同じお客さんの入力を続ける", /_resumeFillAfterNav/.test(ps) && /resumedAfterNav: true/.test(ps) && /sessionStorage\.removeItem\(_AX_REFILL_KEY\)/.test(ps));

ok("検索後0件なら0件の終わりの合図（番号は印のお客さん）", /zero_rows_after_search/.test(bd) && /if \(_flag && _flag\.customerId\) _autoRunCid = _flag\.customerId;/.test(bd));
ok("検索結果と読めない時は0件と言わない", /no_rows_not_result_page/.test(bd));
ok("次ページの続きを止める時も終わりの合図", /next_page_stale/.test(bd) && /next_page_customer_changed/.test(bd) && /next_page_not_auto/.test(bd) && /next_page_no_rows/.test(bd));
ok("次ページの印は押す直前に付け直す", /_nextMark\.at = Date\.now\(\)/.test(bd));
ok("次ボタンが外れても黙らない", /次ボタンが外れた/.test(bd));
ok("次の入力で止めた時も止めたお客さんに合図", /halt_new_fill_/.test(bd));
const skipBody = body(bd, "_sendSkipDoneFor");
ok("番号の無い終わりの合図は送らない", /if \(!cid\)/.test(skipBody));

const manifest = JSON.parse(read("manifest.json"));
const ver = (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1];
ok("ページの版と manifest の版が同じ", ver === manifest.version);

console.log(pass + " pass / " + fail + " fail");
process.exit(fail ? 1 : 0);
