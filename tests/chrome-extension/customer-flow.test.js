// 実行: node tests/chrome-extension/customer-flow.test.js
// 2026-09-30 v2.5.42 竹内「AIX 自動検索のところは、リアプロと itandi、お客さんそれぞれ同時に完了するようにする。YUMA ならリアプロと itandi 完了して、
//   次のお客さんに移る等の動きで。また動き方もロボットみたいじゃなくて人間のように」「ページの上限は 5 ページまで上げる」
//   「画面見るところで、前に共有した物件はダウンロードされないようになっているのか読み取って」
//   回す順（お客様 → リアプロ → ITANDI → 次のお客様）・人の間（サイトの間・お客様の間・次のコマンドまで）・ページの上限（拡張とサーバーで同じ 5）・
//   選んだ部屋を点検に残す（見張りが送付済みと照らす）の配線を固定する。サイトには触らない
const fs = require("fs");
const path = require("path");
const R = require("../../chrome-extension/auto-run.js");
let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }
function ok(name, c) { eq(name, !!c, true); }
const ROOT = path.join(__dirname, "../..");
const EXT = path.join(ROOT, "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
const readRoot = (f) => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n");
const seq = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };

console.log("\n■ 回す順（1コマンドの中はお客様 → リアプロ → ITANDI）");
{
  eq("並びはリアプロ → itandi（コマンドの sites が逆でも）", R.orderSites(["itandi", "realnetpro"]), ["realnetpro", "itandi"]);
  eq("重複は1つ・レインズは最後", R.orderSites(["reins", "itandi", "itandi", "realnetpro"]), ["realnetpro", "itandi", "reins"]);
  eq("1サイトはそのまま", R.orderSites(["itandi"]), ["itandi"]);
  eq("空・不正は空", [R.orderSites([]), R.orderSites(null)], [[], []]);
  const bg = read("background.js");
  ok("background: sites は orderSites で並べる", /var sites = \(self\.AxlxAutoRun && self\.AxlxAutoRun\.orderSites\) \? self\.AxlxAutoRun\.orderSites\(command\.sites \|\| \["reins"\]\)/.test(bg));
  const loopI = bg.indexOf("for (var i = 0; i < targets.length; i++) {"), loopJ = bg.indexOf("for (var j = 0; j < custSites.length; j++) {");
  ok("background: お客様のループの中にサイトのループ（サイトごとに全員を回さない）", loopI > 0 && loopJ > loopI && loopJ - loopI < 6000 && bg.indexOf("_runLanesParallel(customer", loopI) < loopJ); // v2.5.43 同時の回（_runLanesParallel）もお客様のループの中
  ok("background: 次のお客様の間（processed_customers）はサイトのループの後", bg.indexOf("processed_customers: i + 1", loopJ) > loopJ);
}

console.log("\n■ 人の間（毎回ちがう・機械的に同じ間隔にしない・サイトへのアクセスは増やさない）");
{
  ok("同じお客様の次のサイトまでの間は一括の回すべて（自動便だけではない・順の回）", /if \(j > 0 && _AR && !_stopApplies\) \{\s*var _siteGap = _AR\.siteGapMs\(\);/.test(read("background.js")));
  eq("次のコマンドまでの間はお客様の間と同じ幅（15〜60秒・一息 90〜200秒）", [R.nextCommandGapMs(seq([0.9, 0])), R.nextCommandGapMs(seq([0.9, 0.999999])), R.nextCommandGapMs(seq([0.05, 0])), R.nextCommandGapMs(seq([0.05, 0.999999]))], [15000, 60000, 90000, 200000]);
  const vals = new Set(); for (let i = 0; i < 12; i++) vals.add(R.nextCommandGapMs(seq([0.5, i / 12])));
  ok("同じ長さが続かない（12回で12通り）", vals.size === 12);
  const bg = read("background.js");
  const gapCheck = bg.indexOf('chrome.storage.local.get(["batchNextNotBefore"])'), fetchPending = bg.indexOf('fetch(SUMORA_BATCH_API + "/api/automation/pending"');
  ok("background: 次のコマンドまでの間は pending を取りに行く**前**に見る（取ると running になる）", gapCheck > 0 && fetchPending > gapCheck);
  ok("background: 10分より先の値は信じない", /_nb - Date\.now\(\) < 10 \* 60 \* 1000/.test(bg));
  ok("background: 間を置くのは1人1コマンドの回（web_brain・auto_schedule・customer_ids が1人）の後だけ", /\(_src === "web_brain" \|\| _src === "auto_schedule"\) && \(cmd\.customer_ids \|\| \[\]\)\.length === 1/.test(bg));
  ok("background: 間はロックを消す時に一緒に書く（stop_all は置かない）", /batchRunning: null, batchCommandId: null, batchNextNotBefore: _nextGap \? Date\.now\(\) \+ _nextGap : 0/.test(bg) && /cmd\.command_type !== "stop_all" && \(_src/.test(bg));
}

console.log("\n■ ページの上限 5（拡張とサーバーで同じ・1か所の定数）");
{
  eq("拡張の既定 DEFAULT_MAX_PAGES", R.DEFAULT_MAX_PAGES, 5);
  const sched = readRoot("app/lib/auto-search-schedule.ts");
  ok("サーバーの SEARCH_MAX_PAGES も 5", /export const SEARCH_MAX_PAGES = 5;/.test(sched));
  ok("午前・午後の便とも SEARCH_MAX_PAGES", (sched.match(/maxPages: SEARCH_MAX_PAGES,/g) || []).length === 2);
  eq("自動便の指定が無い時は既定へ（pageLimit の fallback）", R.pageLimit(null, R.DEFAULT_MAX_PAGES), 5);
  eq("自動便の指定（max_pages 5）はそのまま", R.pageLimit({ max_pages: 5 }, 3), 5);
  ok("bulk-dl の既定は 5", /\|\| \(_AR\(\) && _AR\(\)\.DEFAULT_MAX_PAGES\) \|\| 5;/.test(read("bulk-dl.js")));
  ok("itandi-bulk-dl も既定は DEFAULT_MAX_PAGES（自動便の指定 → 既定）", /pageLimit\(_autoRunFor\(customerId\), _AR\(\)\.DEFAULT_MAX_PAGES \|\| null\)/.test(read("itandi-bulk-dl.js")));
  const chk = readRoot("app/lib/search-audit-check.ts");
  ok("点検の cut_by_pages は SEARCH_MAX_PAGES と比べる（古い拡張の 3 を見分ける）", /r\.page_limit < SEARCH_MAX_PAGES/.test(chk));
}

console.log("\n■ 選んだ部屋を点検に残す（見張りの C2・C3 が送付済みの部屋と照らす）");
{
  const bd = read("bulk-dl.js");
  ok("bulk-dl: 資料を取りに行く直前に一覧のチェックが入っている行を読む（_rememberPicked）", /_rememberPicked\(state\);/.test(bd) && /function _rememberPicked\(state\)/.test(bd));
  ok("bulk-dl: 建物名と先頭のセルの号室（roomFromRealproCell）・150件まで", /SK\.roomFromRealproCell\(roomCell\)/.test(bd) && /list\.length >= 150/.test(bd));
  ok("bulk-dl: ページをまたいでも残す（setAutoSendState に pickedRooms）", /pickedRooms: state\.pickedRooms \|\| null/.test(bd));
  ok("bulk-dl: 点検の結果に picked_rooms", /r\.picked_rooms = state\.pickedRooms\.slice\(0, 150\)/.test(bd));
  const ib = read("itandi-bulk-dl.js");
  ok("itandi-bulk-dl: 選んだ行を読む（_itRememberPicked・送付済みを外した後）", /_itRememberPicked\(targets\);/.test(ib) && ib.indexOf("_applySentSkipIt(customerId)") < ib.indexOf("_itRememberPicked(targets);"));
  const chk = readRoot("app/lib/search-audit-check.ts");
  ok("サーバーの点検に SENT_SELECTED（選んだ・ダウンロードした部屋 × 送付済み）", /add\("SENT_SELECTED", "warn"/.test(chk) && /sentSelectedOf\(/.test(chk));
  const sw = readRoot("app/lib/screen-watch.ts");
  ok("見張り: ★物件出し★のまとめに1行（sent_notice）・ラベルは変えない", /export function sentSelectedNotice\(/.test(sw) && /sent_notice: sentNotice/.test(sw));
  const sws = readRoot("app/lib/screen-watch-server.ts");
  ok("見張りの記録に飛ばした数・選んだ数（material.sent）", /sent: material\.checkpoint === "done" \? \{ skipped: numOrNull\(row\?\.result\?\.sent_skipped\), selected: numOrNull\(row\?\.result\?\.sent_selected\) \}/.test(sws));
  ok("★物件出し★のまとめの1行に sent_notice", /r\.watch\?\.sent_notice/.test(sws));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
