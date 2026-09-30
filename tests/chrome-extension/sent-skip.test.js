// 実行: node tests/chrome-extension/sent-skip.test.js
// 2026-09-29 v2.5.41 竹内「一度送ったことがある物件はダウンロードもしないようにすれば更に問題なく物件検索できる。人間の動きのように」
//   ＋「更新日もちゃんと確認する」: 送付済みの部屋を一覧で選ばない（sent-skip.js）・更新日の計画を popup の経路にも（auto-run.js）・
//   一覧の更新日の経過を読む（snapshot-core.js）の純関数と配線を固定する（サイトには触らない）
const fs = require("fs");
const path = require("path");
const SK = require("../../chrome-extension/sent-skip.js");
const R = require("../../chrome-extension/auto-run.js");
const S = require("../../chrome-extension/snapshot-core.js");
let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }
function ok(name, c) { eq(name, !!c, true); }
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

console.log("\n■ 号室・更新日の読み（リアプロの一覧の先頭のセル「部屋名更新日」・本番の候補の記録の実物）");
{
  eq("「309 4日前 閲覧済」→ 309", SK.roomFromRealproCell("309 4日前 閲覧済"), "309");
  eq("「0405 4時間前 閲覧済」→ 0405", SK.roomFromRealproCell("0405 4時間前 閲覧済"), "0405");
  eq("「401 1時間前 閲覧済」→ 401", SK.roomFromRealproCell("401 1時間前 閲覧済"), "401");
  eq("号室の無いセル「4日前」→ null（飛ばさない）", SK.roomFromRealproCell("4日前"), null);
  eq("空 → null", SK.roomFromRealproCell(""), null);
  eq("「4日前」→ 4日", SK.ageDaysOfCell("309 4日前 閲覧済"), 4);
  eq("「4時間前」→ 1/6日", SK.ageDaysOfCell("0405 4時間前"), 4 / 24);
  eq("読めない → null", SK.ageDaysOfCell("309 閲覧済"), null);
  eq("号室の正規化（先頭の0）", [SK.normRoom("0405"), SK.normRoom("405"), SK.normRoom("405号室"), SK.normRoom("１０１")], ["405", "405", "405", "101"]);
}

console.log("\n■ 同じ部屋だけ飛ばす（迷ったら飛ばさない）");
{
  const idx = SK.buildIndex([
    { name: "カーサグランテ竹島", room: "309" },
    { name: "日生ロイヤルマンション十三", room: "405" },
    { name: "メゾン ブランカ あびこ南", room: "201" },
    { name: "マスターズレジデンス道頓堀Ⅱ", room: "501" },
    { name: "ブエナビスタ難波サウス", room: "1201" },
    { name: "物件", room: "101" },
    { name: "号室なし", room: "" },
  ]);
  eq("号室の無い行・名前の読めない行は入れない", idx.size, 5);
  ok("同じ建物・同じ号室 → 飛ばす", SK.isSentRoom(idx, "カーサグランテ竹島", "309"));
  ok("号室の先頭の0の違い（0405 と 405）→ 飛ばす", SK.isSentRoom(idx, "日生ロイヤルマンション十三", "0405"));
  ok("空白の違いだけ（メゾンブランカあびこ南）→ 飛ばす", SK.isSentRoom(idx, "メゾンブランカあびこ南", "201"));
  ok("同じ建物の別の部屋 → 飛ばさない", !SK.isSentRoom(idx, "カーサグランテ竹島", "310"));
  ok("棟の違い（Ⅱ と Ⅲ）→ 飛ばさない", !SK.isSentRoom(idx, "マスターズレジデンス道頓堀Ⅲ", "501"));
  ok("似た別の建物（サウスタワー）→ 飛ばさない", !SK.isSentRoom(idx, "ブエナビスタ難波サウスタワー", "1201"));
  ok("号室が読めない行 → 飛ばさない", !SK.isSentRoom(idx, "カーサグランテ竹島", null));
  ok("名前が既定値「物件」→ 飛ばさない", !SK.isSentRoom(idx, "物件", "101"));
  const idxA = SK.buildIndex([{ name: "HOPE CITY天神橋", room: "A0205" }]);
  ok("英字の付く号室は英字ごと（A0205 と B0205 は別・当て込みの疑い 9/29 の形）", SK.isSentRoom(idxA, "HOPE CITY天神橋", "A205") && !SK.isSentRoom(idxA, "HOPE CITY天神橋", "B0205") && !SK.isSentRoom(idxA, "HOPE CITY天神橋", "0205"));
  eq("このお客様・新しい物だけ使う", [
    !!SK.indexFor({ customerId: "c1", rooms: [{ name: "カーサグランテ竹島", room: "309" }], at: 1000 }, "c1", 2000),
    SK.indexFor({ customerId: "c1", rooms: [{ name: "カーサグランテ竹島", room: "309" }], at: 1000 }, "c2", 2000),
    SK.indexFor({ customerId: "c1", rooms: [{ name: "カーサグランテ竹島", room: "309" }], at: 1000 }, "c1", 1000 + SK.TTL_MS + 1),
    SK.indexFor({ customerId: "c1", rooms: [{ name: "カーサグランテ竹島", room: "309" }], at: 1000, staff: true }, "c1", 2000),
  ], [true, null, null, null]);
}

console.log("\n■ 更新日の計画（auto-run.js payloadForCustomer → optsFromPayload → popup の経路）");
{
  const plan = { v: 1, by_customer: { c1: { days: 3, base_days: 1, gap_hours: 49.2, last_search_at: "2026-09-27T01:00:00Z", widened: true }, c2: { days: null, base_days: 14, gap_hours: 400, last_search_at: null, widened: true } } };
  const pm = { source: "auto_schedule", mode: "pm", rp_update_days: 1, sort: "updated", max_pages: 1, update_days_plan: plan };
  const NOW = Date.parse("2026-09-29T02:12:00Z"); // 計画を作った時と同じ 49.2時間後（テストを今の時刻に依らせない）
  const p1 = R.payloadForCustomer(pm, "c1", NOW);
  eq("午後の便でも計画の値（3）を入れる", R.optsFromPayload(p1), { mode: "pm", rp_update_days: 3, rp_update_days_none: false, sort: "updated", max_pages: 1 });
  eq("14日でも覆えない → 指定なし", R.optsFromPayload(R.payloadForCustomer(pm, "c2", NOW)).rp_update_days_none, true);
  eq("計画の無いお客様は元の payload のまま", R.payloadForCustomer(pm, "c9", NOW) === pm, true);
  const wb = { source: "web_brain", is_wide: false, rp_update_days: 3, update_days_plan: plan };
  eq("web_brain も計画があれば popup に渡す（並び・ページは触らない）", R.optsFromPayload(R.payloadForCustomer(wb, "c1", NOW)), { mode: null, rp_update_days: 3, rp_update_days_none: false, sort: null, max_pages: null });
  eq("計画の無い web_brain は今までどおり null", R.optsFromPayload({ source: "web_brain", rp_update_days: 3 }), null);
  eq("_buildBatchConditions の経路も同じ値（rp_update_days を写す）", R.payloadForCustomer(pm, "c1", NOW).rp_update_days, 3);
  // 2026-09-30 点検の直し: 計画は積んだ時刻で数えている → 検索する時刻で数え直して広げる（狭めない）
  const late = { v: 1, by_customer: { c3: { days: 1, base_days: 1, gap_hours: 23.5, last_search_at: "2026-09-28T01:20:00Z", widened: false } } };
  const am = { source: "auto_schedule", mode: "am", rp_update_days: 1, sort: "ad", max_pages: 3, update_days_plan: late };
  eq("積んだ時 23.5時間でも検索する時 24.9時間 → 3日に広げる", R.payloadForCustomer(am, "c3", Date.parse("2026-09-29T02:15:00Z")).rp_update_days, 3);
  eq("検索する時 24.4時間（余裕 0.5時間の中）→ 1日のまま", R.payloadForCustomer(am, "c3", Date.parse("2026-09-29T01:45:00Z")).rp_update_days, 1);
  eq("狭めない（計画 7日・今 2時間）", R.payloadForCustomer({ source: "web_brain", update_days_plan: { v: 1, by_customer: { c4: { days: 7, last_search_at: "2026-09-29T00:00:00Z" } } } }, "c4", Date.parse("2026-09-29T02:00:00Z")).rp_update_days, 7);
  eq("15日以上空いた → 指定なし", R.payloadForCustomer(am, "c3", Date.parse("2026-10-14T02:00:00Z")).rp_update_days, null);
  eq("前回が分からない（last_search_at なし）→ 計画のまま", R.payloadForCustomer({ source: "web_brain", update_days_plan: { v: 1, by_customer: { c5: { days: 1, last_search_at: null } } } }, "c5", Date.parse("2026-10-14T02:00:00Z")).rp_update_days, 1);
  eq("指定なし（null）の計画はそのまま", R.payloadForCustomer({ source: "web_brain", update_days_plan: { v: 1, by_customer: { c6: { days: null, last_search_at: "2026-09-01T00:00:00Z" } } } }, "c6", Date.parse("2026-10-14T02:00:00Z")).rp_update_days, null);
}

console.log("\n■ 一覧の更新日の経過（snapshot-core.readDom → 見張りの C2）");
{
  const a = S.updateAgesOf(["309 4日前 閲覧済\t\t無", "0405 4時間前 閲覧済", "検索条件: 3日前から", "1001 30分前"]);
  eq("号室＋N前の行だけ数える", a && a.n, 3);
  eq("最大は4日", a && a.max_days, 4);
  const doc = { body: { innerText: "全 120 件\n309 9日前 閲覧済\n401 1時間前" }, title: "リアプロ", querySelectorAll: () => [], getElementById: () => null };
  const dom = S.readDom(doc, { href: "https://www.realnetpro.com/main.php" });
  eq("リアプロの画面だけ update_ages", dom.update_ages && dom.update_ages.n, 2);
  eq("ITANDI の画面は null", S.readDom(doc, { href: "https://itandibb.com/rent_rooms/list" }).update_ages, null);
  eq("見張りの本文に載る", S.watchBody("results", {}, dom).dom.update_ages.n, 2);
}

console.log("\n■ 配線（拡張の再読み込み後に効く所）");
{
  const bg = read("background.js");
  ok("background: sent-skip.js を読み込む", /import "\.\/sent-skip\.js";/.test(bg));
  ok("background: 1人ごとに送付済みの部屋を読む（計画の写しの直後）", /var _custPayload = [\s\S]{0,600}await _loadSentRooms\(effectiveCustomer\.id, batchSite\);/.test(bg));
  ok("background: スタッフモードは空（飛ばさない）", /if \(await isStaffModeOn\(\)\) \{ rec\.staff = true; \}/.test(bg));
  ok("background: 計画の payload を自動入力と直接入力の両方に", /_batchAutofill\(effectiveCustomer, batchSite, batchIsWide, _custPayload, _batchAudit\)/.test(bg) && (bg.match(/_buildBatchConditions\(effectiveCustomer, batchIsWide, _custPayload\)/g) || []).length === 2);
  ok("background: 飛ばした数を merge-pdfs へ（リアプロ・ITANDI）", (bg.match(/ext_sent_skipped: msg\.sent_skipped \|\| null/g) || []).length === 2);
  ok("background: 全部送付済みの時は「0件」と言わない", /🔍【新しい物件なし】/.test(bg));
  const bd = read("bulk-dl.js");
  ok("bulk-dl: 全選択の直後に送付済みの部屋を外す", /tracked\.forEach\(function \(t\) \{ t\.cb\.checked = true; \}\);\s*updateBar\(\);\s*\/\/ 2026-09-29 v2\.5\.41[^\n]*\n\s*var _skCounted = tracked\.length > 0;\s*var _sk0 = _applySentSkip\(state, _skCounted\);/.test(bd));
  ok("bulk-dl: 待ちの経路（4秒のポーリング）でも外す", /tracked\.forEach\(function \(t\) \{ t\.cb\.checked = true; \}\);\s*updateBar\(\);\s*_applySentSkip\(state, !_skCounted && tracked\.length > 0\);/.test(bd));
  ok("bulk-dl: スタッフモードは飛ばさない", /var idx = _staffModeOn \? null : SK\.indexFor\(/.test(bd));
  ok("bulk-dl: 点検に sent_skipped・update_ages", /r\.sent_skipped = state\.sentSkipped/.test(bd) && /r\.update_ages = state\.updateAges/.test(bd));
  ok("bulk-dl: 次のページへ数を持ち越す", /sentSkipped: state\.sentSkipped \|\| 0, updateAges: state\.updateAges \|\| null/.test(bd));
  const ib = read("itandi-bulk-dl.js");
  ok("itandi-bulk-dl: 全選択の直後に外す（資料のモーダルを開かない）", /var _pageSkipped = _applySentSkipIt\(customerId\);/.test(ib));
  ok("itandi-bulk-dl: スタッフモードは飛ばさない", /SK && !_staffModeOn \? SK\.indexFor\(/.test(ib));
  const mf = JSON.parse(read("manifest.json"));
  const cs = mf.content_scripts.map((c) => c.js.join(","));
  ok("manifest: リアプロ・ITANDI の一括の前に sent-skip.js", cs.includes("send-pairing.js,auto-run.js,sent-skip.js,update-order-stop.js,bulk-dl.js") && cs.includes("send-pairing.js,auto-run.js,sent-skip.js,itandi-row-parse.js,itandi-guard.js,update-order-stop.js,itandi-bulk-dl.js"));
  eq("manifest の版", mf.version, "2.5.49");
  const sa = read("search-audit.js");
  ok("search-audit: 日時の欄は伏せない（v2.5.40 までは「＊＊＊T…」になっていた）", /DATE_FIELDS\[k\] && ISO_RE\.test\(v\.trim\(\)\)/.test(sa));
  const A = require("../../chrome-extension/search-audit.js");
  eq("写しの日時がそのまま残る", A.snapshotCustomer({ last_property_sent_at: "2026-09-26T02:50:40.434+00:00", preferences: "電話 090-1234-5678" }), { last_property_sent_at: "2026-09-26T02:50:40.434+00:00", preferences: "電話 ＊＊＊" });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
