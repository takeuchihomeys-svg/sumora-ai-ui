// 実行: node tests/chrome-extension/update-order-stop.test.js
// 2026-09-30 v2.5.43 竹内「更新順で検索していたら、その更新順以降は見なくて大丈夫」:
//   更新日の表記の読み方（リアプロ「309 4日前」「2時間前」・ITANDI の「更新」の見出しの近くの日付）・前回の検索との比べ・境界・
//   読めない時／前回が分からない時／AD 順の時は止めない・ページをまたぐ持ち越し・bulk-dl／itandi-bulk-dl の配線を固定する
const fs = require("fs");
const path = require("path");
const U = require("../../chrome-extension/update-order-stop.js");
let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }
function ok(name, c, extra) { const v = !!c; v ? pass++ : fail++; console.log((v ? "  ✓ " : "  ✗ ") + name + (v || extra === undefined ? "" : `\n      ${JSON.stringify(extra).slice(0, 400)}`)); }
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

const H = 3600000, D = 24 * H;
const now = Date.parse("2026-09-30T08:00:00Z"); // JST 17:00
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const nw = (t, o) => iso(U.newestPossibleMs(t, now, o));

console.log("\n■ 行の更新日の読み方（一番新しくあり得る時刻＝狭い側に読まない）");
{
  eq("「309 4日前 閲覧済」→ 3日前（暦の日で数えている可能性）", nw("309 4日前 閲覧済"), iso(now - 3 * D));
  eq("「0405 2時間前」→ 2時間前", nw("0405 2時間前"), iso(now - 2 * H));
  eq("「1001 30分前」→ 30分前", nw("1001 30分前"), iso(now - 30 * 60000));
  eq("「1日前」→ 今（止める材料にしない）", nw("101 1日前"), iso(now));
  eq("「2週間前」→ 13日前", nw("401 2週間前"), iso(now - 13 * D));
  eq("「1ヶ月前」→ 29日前", nw("401 1ヶ月前"), iso(now - 29 * D));
  eq("全角の数字も読む", nw("３０９ ４日前"), iso(now - 3 * D));
  eq("読めない → null", nw("309 閲覧済"), null);
  eq("絶対の日付（時刻あり・JST）", nw("2026/09/29 12:34"), "2026-09-29T03:34:00.000Z");
  eq("絶対の日付（日だけ）→ その日の終わり（JST 23:59:59）", nw("2026年9月28日"), "2026-09-28T14:59:59.000Z");
}

console.log("\n■ ITANDI（requireLabel）: 「更新」の見出しの近くだけ読む（入居可能日・築年月・更新料を拾わない）");
{
  const L = { requireLabel: true };
  eq("「3日前に更新」", nw("メゾン難波 101 3日前に更新 6.5万円 25.1㎡", L), iso(now - 2 * D));
  eq("「更新日 2日前」", nw("更新日 2日前", L), iso(now - 1 * D));
  eq("「最終更新: 2026/09/29 12:34」", nw("賃料 6.5万円 最終更新: 2026/09/29 12:34", L), "2026-09-29T03:34:00.000Z");
  eq("「更新日 09/28」（年なし＝今年）", nw("更新日 09/28", L), "2026-09-28T14:59:59.000Z");
  eq("「更新料 1ヶ月 入居 2026/10/01」は読まない（更新料は見出しでない）", nw("更新料 1ヶ月 入居 2026/10/01", L), null);
  eq("「築2005年3月 更新料 1ヶ月」は読まない", nw("築2005年3月 更新料 1ヶ月", L), null);
  eq("「更新料 1ヶ月 … 更新日 2026/09/29」は後ろの見出しを読む", nw("更新料 1ヶ月 保証 更新日 2026/09/29", L), "2026-09-29T14:59:59.000Z");
  eq("見出しが無い行（入居可能日だけ）→ null", nw("入居 2026/10/01 6.5万円", L), null);
}

console.log("\n■ 並び（リアプロの URL と自動便の指定）");
{
  eq("key=ad → AD 順（止めない）", U.orderForRealpro("https://www.realnetpro.com/main.php?key=ad&odr=desc", { sort: "updated" }), "ad");
  eq("午後の便（sort=updated）・key なし → 更新日順", U.orderForRealpro("https://www.realnetpro.com/main.php", { sort: "updated" }), "updated");
  eq("指定なし・key なし → 並びは分からない（行から確かめる）", U.orderForRealpro("https://www.realnetpro.com/main.php", null), "unknown");
  eq("key=price（別の並び）→ other", U.orderForRealpro("https://www.realnetpro.com/main.php?key=price", { sort: "updated" }), "other");
}

console.log("\n■ 前回の検索と比べて止める（decideStop）");
{
  const last = now - 2 * D; // 前回の検索＝2日前
  const rows = (arr) => arr.map((t) => ({ newest: t, text: t == null ? "?" : iso(t) }));
  const r1 = U.decideStop({ rows: rows([now - 1 * H, now - 20 * H, now - 3 * D, now - 4 * D]), lastSearchMs: last, nowMs: now, order: "updated" });
  eq("更新日順: 前回より古い最初の行で止める（3行目）", [r1.stopIndex, r1.reason], [2, "older_than_last_search"]);
  const r2 = U.decideStop({ rows: rows([now - 1 * H, last, last - 29 * 60000]), lastSearchMs: last, nowMs: now, order: "updated" });
  eq("境界: 前回と同じ時刻・余裕（30分）の中は止めない", [r2.stopIndex, r2.reason], [-1, "all_newer"]);
  const r3 = U.decideStop({ rows: rows([now - 1 * H, last - 31 * 60000]), lastSearchMs: last, nowMs: now, order: "updated" });
  eq("境界: 余裕を1分でも越えた行で止める", r3.stopIndex, 1);
  eq("前回の検索が分からない → 止めない", U.decideStop({ rows: rows([now - 5 * D]), lastSearchMs: null, nowMs: now, order: "updated" }).stopIndex, -1);
  eq("AD 順 → 止めない（更新日順でない）", U.decideStop({ rows: rows([now - 5 * D]), lastSearchMs: last, nowMs: now, order: "ad" }).reason, "not_update_order:ad");
  eq("読めない行は比べない（null は飛ばして次の行で）", U.decideStop({ rows: rows([null, null, now - 5 * D]), lastSearchMs: last, nowMs: now, order: "updated" }).stopIndex, 2);
  eq("全部読めない → 止めない", U.decideStop({ rows: rows([null, null]), lastSearchMs: last, nowMs: now, order: "updated" }).stopIndex, -1);
  const r4 = U.decideStop({ rows: rows([now - 1 * H, now - 3 * D, now - 1 * H, now - 5 * D]), lastSearchMs: last, nowMs: now, order: "updated" });
  eq("古い行の前に並びが崩れていなければ止める（崩れはその後）", r4.stopIndex, 1);
  const r5 = U.decideStop({ rows: rows([now - 3 * H, now - 1 * H, now - 5 * D]), lastSearchMs: last, nowMs: now, order: "updated" });
  eq("前の行より新しい行が出た（並びが更新日順でない）→ この回はもう止めない", [r5.stopIndex, r5.reason], [-1, "not_sorted"]);
  // 並びが分からない（ITANDI・key なし）: 読めて単調な行が10行そろってから
  const nine = Array.from({ length: 9 }, (_, i) => now - (3 + i) * D);
  eq("並び不明: 読めた行が9行ではまだ止めない", U.decideStop({ rows: rows(nine), lastSearchMs: last, nowMs: now, order: "unknown" }).stopIndex, -1);
  const r6 = U.decideStop({ rows: rows(nine.concat([now - 20 * D, now - 21 * D])), lastSearchMs: last, nowMs: now, order: "unknown" });
  eq("並び不明: 10行目（単調）で止める・印は inferred_order", [r6.stopIndex, r6.carry.stopped.inferred_order], [9, true]);
  // ページをまたぐ持ち越し
  const p1 = U.decideStop({ rows: rows([now - 1 * H, now - 5 * H]), lastSearchMs: last, nowMs: now, order: "updated" });
  eq("1ページ目は全部新しい", p1.stopIndex, -1);
  const p2 = U.decideStop({ rows: rows([now - 10 * H, now - 4 * D]), lastSearchMs: last, nowMs: now, order: "updated", carry: JSON.parse(JSON.stringify(p1.carry)) });
  eq("2ページ目（持ち越しは JSON で保存しても同じ）の2行目で止める", p2.stopIndex, 1);
  const p2b = U.decideStop({ rows: rows([now - 20 * H]), lastSearchMs: last, nowMs: now, order: "updated", carry: { prevNewest: now - 30 * H, readable: 5, monotonic: true, stopped: null } });
  eq("ページをまたいで並びが崩れたら止めない", [p2b.stopIndex, p2b.carry.monotonic], [-1, false]);
  eq("止めた後は already_stopped", U.decideStop({ rows: rows([now - 9 * D]), lastSearchMs: last, nowMs: now, order: "updated", carry: p2.carry }).reason, "already_stopped");
  const rec = U.stopRecord(p2.carry, 2, iso(last), "realpro");
  eq("点検に残す形（ページ・行・止めた行の更新日・前回の時刻）", [rec.site, rec.page, rec.index, rec.newest_at, rec.last_search_at, rec.inferred_order], ["realpro", 2, 1, iso(now - 4 * D), iso(last), false]);
  ok("★物件出し★・ログの1行", /^更新順で前回の検索（2026-09-28 08:00）より古い行で止めた（リアプロ 2ページ目・行「/.test(U.describeStop(rec)), U.describeStop(rec));
}

console.log("\n■ 送付済みの飛ばしとは別（送付済みでも新しく更新された部屋は見る）");
{
  // 送付済みかどうかは decideStop の材料に無い＝新しい行は送付済みでも止めない（飛ばすのは sent-skip.js）
  const last = now - 2 * D;
  const r = U.decideStop({ rows: [{ newest: now - 1 * H, text: "送付済みの部屋（新しく更新）" }, { newest: now - 3 * D, text: "古い" }], lastSearchMs: last, nowMs: now, order: "updated" });
  eq("新しく更新された行（送付済みでも）は止める所の前＝見る", r.stopIndex, 1);
  const src = read("update-order-stop.js");
  ok("コメント: 止めるのは前回より古い行であって送付済みの行ではない", /止めるのは「前回の検索より古い行」であって「送付済みの行」ではない/.test(src));
}

console.log("\n■ bulk-dl・itandi-bulk-dl の配線（静的に確かめる）");
{
  const b = read("bulk-dl.js");
  const iSk = b.indexOf("var _sk0 = _applySentSkip(state, _skCounted);");
  const iUo = b.indexOf("_applyUpdateOrderStop(state);\n", iSk);
  ok("bulk-dl: 送付済みの飛ばしの後に止める（同じページで・資料の URL を集める前）", iSk > 0 && iUo > iSk && iUo < b.indexOf("var urls = getSelectedUrls();", iSk));
  ok("bulk-dl: 止めたら次のページは開かない（ページの上限より前に確かめる）", b.indexOf("if (state.updateStop && hasNextPageBtn()) {") > 0 && b.indexOf("if (state.updateStop && hasNextPageBtn()) {") < b.indexOf("if (state.currentPage >= _maxPages && hasNextPageBtn()) {"));
  ok("bulk-dl: 読み込み直しで選び直しても止めた行から先は選ばない（ポーリングの中）", /_applyUpdateOrderStop\(state\); \/\/ 2026-09-30 v2.5.43 選び直した後も/.test(b));
  ok("bulk-dl: 点検の result に stopped_at_last_search", /if \(state && state\.updateStop\) r\.stopped_at_last_search = state\.updateStop;/.test(b));
  ok("bulk-dl: ページをまたぐ持ち越しを保存", /updateCarry: state\.updateCarry \|\| null \}\);/.test(b));
  ok("bulk-dl: 前回の時刻は background の record（forCustomer の last_search_at）・並びは orderForRealpro・スタッフモードは見ない", /opts\.last_search_at/.test(b) && /U\.orderForRealpro\(location\.href, opts\)/.test(b) && /if \(!U \|\| !state \|\| _staffModeOn \|\| !tracked\.length\) return null;/.test(b));
  ok("bulk-dl: コメント（送付済みの行ではない）", /止めるのは「前回の検索より古い行」であって「送付済みの行」ではない/.test(b));
  const it = read("itandi-bulk-dl.js");
  ok("itandi: 送付済みの飛ばしの後・物件数の上限の前に止める", it.indexOf("var _pageSkipped = _applySentSkipIt(customerId);") < it.indexOf("_applyUpdateOrderStopIt(customerId);\n") && it.indexOf("_applyUpdateOrderStopIt(customerId);\n") < it.indexOf("G.capForPage(_itPicked"));
  ok("itandi: 並びは分からない扱い（order: \"unknown\"）・見出しの近くだけ（requireLabel）", /order: "unknown"/.test(it) && /requireLabel: true/.test(it));
  ok("itandi: 止めたら次のページは開かない・手動の送信は見ない", /if \(!_manual && _itUpdateStop && clickNextPageAvailable\(\)\) \{/.test(it) && /if \(!U \|\| _itManualRun \|\| _staffModeOn/.test(it));
  ok("itandi: 点検の result に stopped_at_last_search", /if \(_itUpdateStop\) r\.stopped_at_last_search = _itUpdateStop;/.test(it));
  ok("itandi: 回の始めに持ち越しを消す", /_itUpdateCarry = null;[^\n]*\n\s*_itUpdateStop = null;/.test(it));
  const bg = read("background.js");
  ok("background: 線は計画の last_by_site から・広げての回と一時調整の回は置かない", /\(!batchIsWide && !searchOverride && self\.AxlxUpdateOrderStop && cmdPayload && cmdPayload\.update_days_plan/.test(bg) && /lastSearchFor\(cmdPayload\.update_days_plan\.by_customer\[String\(effectiveCustomer\.id\)\], batchSite\)/.test(bg));
  const mf = JSON.parse(read("manifest.json"));
  const cs = mf.content_scripts.map((c) => c.js.join(","));
  ok("manifest: bulk-dl・itandi-bulk-dl の前に update-order-stop.js", cs.some((c) => /update-order-stop\.js,bulk-dl\.js$/.test(c)) && cs.some((c) => /update-order-stop\.js,itandi-bulk-dl\.js$/.test(c)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
