// 実行: node tests/chrome-extension/batch-guard.test.js
// 2026-09-27 v2.5.32 竹内「リアプロログインした／重い順から治す」（YUMA のテスト顧客・点検 24／26）:
//   ① 動かないリアプロのタブをそのまま使わない（タブを確かめ・入力を始めた合図が来なければ読み直して1回だけやり直す）
//   ② 代わりの直接入力は先に地域を決め、地域が空なら検索しない
//   ④ 検索日は検索を押せた後に記録・失敗は1回知らせる（0件と言わない）
const fs = require("fs");
const path = require("path");
const G = require("../../chrome-extension/batch-guard.js");
let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }
function ok(name, c) { eq(name, !!c, true); }
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

console.log("\n■ pickRealproTab（main.php のタブを先に）");
{
  const tabs = [
    { id: 1, url: "https://www.realnetpro.com/index.php?login" },
    { id: 2, url: "https://itandibb.com/rent_rooms/list" },
    { id: 3, url: "https://www.realnetpro.com/main.php?method=estate&page=1" },
  ];
  eq("ログインの画面のタブより main.php のタブ", G.pickRealproTab(tabs).id, 3);
  eq("main.php が無ければ他のリアプロのページ（後で開き直す）", G.pickRealproTab(tabs.slice(0, 2)).id, 1);
  eq("リアプロのタブが無い → null（新しく開く）", G.pickRealproTab([{ id: 2, url: "https://itandibb.com/" }]), null);
  eq("似た名前の別のサイトは選ばない", G.pickRealproTab([{ id: 9, url: "https://evil.example/realnetpro.com/main.php" }]), null);
}

console.log("\n■ realproTabPlan（使うか・開き直すか）");
{
  const MAIN = "https://www.realnetpro.com/main.php";
  eq("main.php・content.js と page-script が答える → 使う", G.realproTabPlan({ url: MAIN, pong: true, page: true }).action, "use");
  eq("古い content.js（page を返さない）でも答えれば使う", G.realproTabPlan({ url: MAIN, pong: true, page: null }).action, "use");
  eq("点検 24 の形: 拡張の読み直しの後で content.js が答えない → 開き直す", G.realproTabPlan({ url: MAIN, pong: false, page: null }), { action: "reload", reason: "content_script_dead" });
  eq("点検 26 の形の候補: popup は答えるがページの入力の仕組みが答えない → 開き直す", G.realproTabPlan({ url: MAIN, pong: true, page: false }), { action: "reload", reason: "page_script_dead" });
  eq("main.php でない（ログインの画面・トップ）→ 開き直す", G.realproTabPlan({ url: "https://www.realnetpro.com/", pong: false }), { action: "reload", reason: "not_main_php" });
  eq("場所が分からない → 開き直す", G.realproTabPlan({}).reason, "no_url");
  eq("点検 26 の形: 生きているが背面（hidden）→ 使う・前に出す", G.realproTabPlan({ url: MAIN, pong: true, page: true, vis: "hidden" }), { action: "use", reason: "alive", front: true });
  eq("見えているタブは前に出さない", G.realproTabPlan({ url: MAIN, pong: true, page: true, vis: "visible" }).front, false);
  eq("vis の分からない古い content.js は前に出さない", G.realproTabPlan({ url: MAIN, pong: true }).front, false);
  const bgF = read("background.js");
  ok("background: 使う時も読み直した後も、背面なら前に出す（ウィンドウは触らない）", /if \(plan\.front\) await _bringRealproTabFront/.test(bgF) && /if \(plan2\.front\) await _bringRealproTabFront/.test(bgF) && !/_bringRealproTabFront[\s\S]{0,600}chrome\.windows\.update/.test(bgF));
  ok("content.js: ping に vis を返す", /vis: document\.visibilityState/.test(read("content.js")));
  ok("理由の日本語", /読み直し/.test(G.reasonJa("content_script_dead")) && G.reasonJa("x") === "x");
}

console.log("\n■ locationGate（page-script の decideLocationMode と同じ・none は検索しない）");
{
  eq("点検 24 の形: 区のお客様で city_codes が無い（地域を決める前）→ 検索しない", G.locationGate({ area_mode: "ward", areas: ["大阪市北区", "大阪市福島区"] }), { ok: false, mode: "none" });
  eq("地域を決めた後（北区 27127・福島区 27103）→ 検索する", G.locationGate({ area_mode: "ward", city_codes: ["27127", "27103"] }), { ok: true, mode: "area" });
  eq("区のお客様は駅があっても地域が無ければ検索しない", G.locationGate({ area_mode: "ward", station_names: ["福島"] }).ok, false);
  eq("詳細の区だけでも地域あり", G.locationGate({ area_mode: "ward", detail_ward: "大阪市北区" }).mode, "area");
  eq("駅のお客様: 駅", G.locationGate({ area_mode: "station", station_names: ["梅田"] }).mode, "station");
  eq("駅のお客様: 路線だけ", G.locationGate({ area_mode: "station", route_ids: ["r1"] }).mode, "route");
  eq("駅のお客様で駅も路線も無い → 検索しない", G.locationGate({ area_mode: "station", city_codes: ["27127"] }).ok, false);
  eq("指定なし: 駅 > 路線 > 地域", [G.locationGate({ station_names: ["a"], city_codes: ["1"] }).mode, G.locationGate({ route_ids: ["r"], city_codes: ["1"] }).mode, G.locationGate({ city_codes: ["1"] }).mode], ["station", "route", "area"]);
  eq("何も無い → 検索しない（全件検索の防止）", G.locationGate({}).ok, false);
  // page-script.js の decideLocationMode と決まりが揃っているか（ward は city_codes か detail_ward だけ）
  const ps = read("page-script.js");
  ok("page-script の decideLocationMode（ward: city_codes か detail_ward）と同じ", /c\.area_mode === "ward"\) \{\s*return \(\(c\.city_codes && c\.city_codes\.length > 0\) \|\| c\.detail_ward\) \? "area" : "none";/.test(ps));
}

console.log("\n■ failureNotice（ピックアップ用グループに1回・0件と言わない）");
{
  const n1 = G.failureNotice({ customerName: "YUMA", siteLabel: "リアプロ", error: new Error("リアプロ 検索完了シグナル（fill-done）が90秒以内に届きませんでした。") });
  ok("fill-done の時間切れ → 検索できなかった・0件とは限らない", /^⚠【検索できなかった】YUMAさんのリアプロ検索ができませんでした（条件の入力が時間内に終わりませんでした。ページが遅れて検索を続け、後から物件が届くことがあります・0件とは限りません）$/.test(n1));
  ok("タブが応答しない", /タブが応答しません/.test(G.failureNotice({ customerName: "A", error: new Error("AXLX_TAB_DEAD: リアプロのタブが応答しません（読み直しても・x）") })));
  ok("入力が始まらない", /入力を始めませんでした/.test(G.failureNotice({ customerName: "A", error: new Error("AXLX_NO_FILL_START: …") })));
  ok("地域が決まらない → 全件検索を防ぐため検索していない", /全件検索を防ぐため検索していません/.test(G.failureNotice({ customerName: "A", error: new Error("AXLX_NO_LOCATION: …") })));
  ok("点検 25 の形（ページに触れない）", /ページに触れませんでした/.test(G.failureNotice({ customerName: "A", error: "Cannot access contents of the page. Extension manifest must request permission" })));
  ok("見張り（85秒）", /途中で止まりました/.test(G.failureNotice({ customerName: "A", error: "page-script側エラー（スキップ）: watchdog-timeout: 85秒以内に…" })));
  eq("止めた回（__BATCH_STOPPED__）は知らせない", G.failureNotice({ customerName: "A", error: new Error("__BATCH_STOPPED__") }), null);
  eq("名前が無い時は知らせない（誰か分からない）", G.failureNotice({ customerName: "", error: "x" }), null);
  ok("内部のメッセージ（英語・AXLX_）は載せない", !/AXLX_|Cannot|fill-done/.test(G.failureNotice({ customerName: "A", error: "AXLX_NO_LOCATION: Cannot fill-done" })));
  ok("「0件」とは言わない（🔍【物件0件】にしない）", !/物件0件/.test(n1));
}

console.log("\n■ background.js の順番（静的に確かめる）");
{
  const bg = read("background.js");
  ok("batch-guard.js を読む", /import "\.\/batch-guard\.js";/.test(bg));
  const af = bg.slice(bg.indexOf("async function _batchAutofill("), bg.indexOf("async function _applyRealproResolved("));
  ok("リアプロのタブは main.php を先に選び、使う前に確かめる", /pickRealproTab\(allTabs\)/.test(af) && af.indexOf("pickRealproTab") < af.indexOf('if (site === "realnetpro") tab = await _ensureRealproTab(tab, auditRun);'));
  const rp = af.slice(af.indexOf('if (site === "realnetpro") {\n'), af.indexOf('} else if (site === "itandi") {'));
  ok("入力を始めた合図を待ち、来なければ読み直して1回だけやり直す（2回まで）", /_attempt < 2 && !_started/.test(rp) && /_createFillStartWaiter\(_cidStr/.test(rp) && /_ensureRealproTab\(tab, auditRun,/.test(rp) && /_restartFillDoneWaiter\("realnetpro", _cidStr\)/.test(rp));
  ok("2回とも始まらなければ検索しない（90秒待たずに閉じる）", /_endFillDoneWaiter\("realnetpro", _cidStr, "入力が始まらない"\);\s*throw new Error\("AXLX_NO_FILL_START/.test(rp));
  const fb = rp.slice(rp.indexOf("if (!_started) {\n"));
  const iResolve = fb.indexOf("await _applyRealproResolved(conds, isWide);");
  const iGate = fb.indexOf("locationGate(conds)");
  const iIntended = fb.indexOf("_auditPostIntended(auditRun, site, conds);");
  const iExec = fb.indexOf("chrome.scripting.executeScript(");
  ok("直接入力: 地域を決める → 地域の確かめ → 入れようとした値の記録 → ページへ渡す の順", iResolve > 0 && iResolve < iGate && iGate < iIntended && iIntended < iExec, { iResolve, iGate, iIntended, iExec });
  ok("直接入力: 地域が空なら AXLX_NO_LOCATION で検索しない", /if \(!_gate\.ok\) \{[\s\S]{0,300}throw new Error\("AXLX_NO_LOCATION/.test(fb));
  ok("popup_fallback の段に理由（lastError）を残す", /"popup_fallback", "switch-customer 未応答 → 直接入力（" \+ \(_lastWhy/.test(rp));
  const rb = bg.slice(bg.indexOf("async function _runBatchSearch"), bg.indexOf("function _recordBulkSearch("));
  const iAuto = rb.indexOf("await _batchAutofill(effectiveCustomer");
  const iScrape = rb.indexOf("_passCount = await _scrapeAndSendRealpro(", iAuto);
  const iRec = rb.indexOf("_recordBulkSearch(customer, batchSite, batchIsWide)");
  ok("検索日は検索を押せた後（_scrapeAndSendRealpro の後）に記録", iAuto > 0 && iScrape > iAuto && iRec > iScrape, { iAuto, iScrape, iRec });
  ok("失敗した1パスの回はピックアップ用グループに1回知らせる（2パスは集計が知らせる）", /if \(!_isMultiPass && self\.AxlxBatchGuard\) \{[\s\S]{0,300}failureNotice\([\s\S]{0,800}group_key: "pickup_group_id"/.test(rb));
  ok("売上番長グループには送らない（この節の通知は pickup_group_id だけ）", !/sales|uriage|group_key: "(?!pickup_group_id)/.test(rb.slice(rb.indexOf("failureNotice"), rb.indexOf("failureNotice") + 800)));
  const mb = bg.slice(bg.indexOf('[manual-bulk-search] (" + (_bi+1)'), bg.indexOf('[manual-bulk-search] ✔ 完了'));
  ok("手動の一括も検索日は送信の完了の後", mb.indexOf("await _scrapeAndSendRealpro(") > 0 && mb.indexOf("_recordBulkSearch(_bc") > mb.indexOf("await _scrapeAndSendRealpro("));
  ok("_pingTab は ok でも応答ありと見る（content.js は ok を返していた）", /resolve\(!!\(resp && \(resp\.pong \|\| resp\.ok\)\)\)/.test(bg));
}

console.log("\n■ content.js・page-script.js（応答と合図）");
{
  const ct = read("content.js"), ps = read("page-script.js");
  ok("content.js: axlx-ping に pong と page を返す", /msg\.type === "axlx-ping"[\s\S]{0,400}sendResponse\(\{ ok: true, pong: true, page: page, vis: document\.visibilityState \}\)/.test(ct));
  ok("content.js: page-script に postMessage で聞く", /from: "axlx-page-ping"/.test(ct) && /"axlx-page-pong"/.test(ct));
  ok("content.js: 入力を始めた合図を background へ中継", /"aixlinx-fill-started"[\s\S]{0,300}type: "axlx-fill-started"/.test(ct));
  ok("page-script.js: page-ping に答える", /"axlx-page-ping"[\s\S]{0,120}from: "axlx-page-pong", id: e\.data\.id/.test(ps));
  const fr = ps.slice(ps.indexOf("function fillRealpro(cond)"));
  ok("page-script.js: 重複の呼び出しでない時だけ（実行中の確かめの後）入力を始めた合図を出す", fr.indexOf("window._axFillRunning = true;") < fr.indexOf("aixlinx-fill-started") && fr.indexOf("aixlinx-fill-started") < fr.indexOf("if (!cond) { notifyDone(); return; }"));
  const mf = JSON.parse(read("manifest.json"));
  ok("manifest の版が 2.5.32 以上", (() => { const v = mf.version.split(".").map(Number); return v[0] > 2 || (v[0] === 2 && (v[1] > 5 || (v[1] === 5 && v[2] >= 32))); })());
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
