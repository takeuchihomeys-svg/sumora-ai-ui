// 実行: node tests/chrome-extension/itandi-form-guard.test.js
// v2.5.45 ITANDI の検索が止まる件（2026-09-30 竹内「[batch] error: … itandi auto Error: itandi 検索完了シグナル（fill-done）が245秒以内に届きませんでした」）
//
// 本番の証拠（search_audits 9/26〜9/30・extension_snapshots 12:52〜13:50 の写真とページの文字）:
//   ① ITANDI のリセットのボタンは「条件削除」。旧の探し方（条件全削除/条件クリア/全クリア/クリア）では見つからず、9/26 以降の全ての回が reset_fail
//      → 前のお客様の所在地・駅が積み上がり（13:50 の画面: 所在地4区＋駅25駅）、「該当物件数が多すぎます。3,000件以内…」で検索のボタンが押せない
//   ② 家賃の上限 84,999 円 →「8.4999」→「賃料（上限）は5桁以内で入力して下さい」で検索のボタンが押せない（13:01 R さん）
//   ③ 押せないボタンを click() しても「押せた」→ fill-done は ok、一覧は前の結果（49 戸）のまま → 5分無進捗（batch_timeout）
//   ④ 更新日の欄の後の例外が捨てられて 240秒の watchdog（13:34・13:45・9/28 の区のお客様）→ fill-done の error は中継されず、さらに5分待った
//   ⑤ 同じ自動入力が2回届き（点検の段 location/lines_done/update_days が毎回2つ・fill-done も2回）2本の入力が同じフォームを触っていた
const fs = require("fs");
const path = require("path");
const FG = require("../../chrome-extension/itandi-form-guard.js");
const G = require("../../chrome-extension/batch-guard.js");

const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
function ok(name, cond, detail) { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond || !detail ? "" : "\n      " + detail)); }
function eq(name, a, b) { const c = JSON.stringify(a) === JSON.stringify(b); ok(name, c, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

console.log("\n① リセットのボタン（ITANDI の今の文字は「条件削除」）");
ok("条件削除", FG.isResetLabel("条件削除"));
ok("前後の空白", FG.isResetLabel("  条件削除 "));
ok("旧の 条件全削除 も", FG.isResetLabel("条件全削除"));
ok("旧の 条件クリア も", FG.isResetLabel("条件クリア"));
ok("検索 は違う", !FG.isResetLabel("検索"));
ok("保存 は違う", !FG.isResetLabel("保存"));
ok("条件を保存 は違う", !FG.isResetLabel("条件を保存"));
ok("一覧 は違う", !FG.isResetLabel("一覧"));

console.log("\n② 家賃の欄の文字（5文字以内・上限は切り下げ・下限は切り上げ）");
eq("84,999円（上限）→ 8.499（旧 8.4999 は弾かれた）", FG.rentText(84999, "max"), "8.499");
eq("8.4999万（上限）→ 8.499", FG.rentText(8.4999, "max"), "8.499");
eq("85,000円 → 8.5", FG.rentText(85000, "max"), "8.5");
eq("8.5 → 8.5（浮動小数でずれない）", FG.rentText(8.5, "max"), "8.5");
eq("105,000円 → 10.5", FG.rentText(105000, "max"), "10.5");
eq("104,999円 → 10.49", FG.rentText(104999, "max"), "10.49");
eq("70,000円（下限）→ 7", FG.rentText(70000, "min"), "7");
eq("65,000円（下限）→ 6.5", FG.rentText(65000, "min"), "6.5");
eq("64,999円（下限）→ 6.5（切り上げ）", FG.rentText(64999, "min"), "6.5");
eq("64,999円（上限）→ 6.499", FG.rentText(64999, "max"), "6.499");
eq("文字 '8.5万' → 8.5", FG.rentText("8.5万", "max"), "8.5");
eq("文字 '85,000' → 8.5", FG.rentText("85,000", "max"), "8.5");
eq("123.4567万 → 123.4", FG.rentText(123.4567, "max"), "123.4");
eq("0 は null（欄を触らない）", FG.rentText(0, "max"), null);
eq("空は null", FG.rentText("", "max"), null);
eq("読めない文字は null", FG.rentText("abc", "max"), null);
[84999, 8.4999, 99999, 104999, 123456, 9.87654, 7, 6.66666, 250000, 1234567].forEach((v) => {
  const t = FG.rentText(v, "max");
  ok("5文字以内: " + v + " → " + t, t && t.length <= FG.RENT_MAX_LEN);
  const man = v > 1000 ? v / 10000 : v;
  ok("上限は登録より上げない: " + v, parseFloat(t) <= man + 1e-9);
});
[64999, 6.66666, 70001].forEach((v) => {
  const t = FG.rentText(v, "min");
  const man = v > 1000 ? v / 10000 : v;
  ok("下限は登録より下げない: " + v + " → " + t, parseFloat(t) >= man - 1e-9 && t.length <= 5);
});

console.log("\n③ 検索のボタンを押してよいか（9/30 の画面の文字そのまま）");
const shot1308 = ["正しく入力されていない項目があります。メッセージをクリックして該当項目に遷移し、もう一度ご入力ください。", "⊗賃料（上限）は5桁以内で入力して下さい"];
const b1 = FG.searchBlock({ found: true, disabled: true, texts: shot1308 });
eq("13:08 の画面（賃料の5桁）→ invalid", b1 && b1.code, "invalid");
ok("理由は具体的な赤い文（賃料…5桁）", b1 && /賃料.上限.は5桁以内/.test(b1.ja), b1 && b1.ja);
const shot1252 = ["該当物件数が多すぎます。3,000件以内になるように条件を追加してください。"];
const b2 = FG.searchBlock({ found: true, disabled: true, texts: shot1252 });
eq("12:52 の画面（3,000+）→ too_many", b2 && b2.code, "too_many");
eq("押せない状態だけ → disabled", FG.searchBlock({ found: true, disabled: true, texts: [] }).code, "disabled");
eq("押せる・赤い文なし → null", FG.searchBlock({ found: true, disabled: false, texts: [] }), null);
eq("押せる・関係ない文だけ → null", FG.searchBlock({ found: true, disabled: false, texts: ["駅徒歩 分以内", "98 戸（20棟ずつ表示）"] }), null);
eq("ボタンが無い → no_button", FG.searchBlock({ found: false, disabled: false, texts: [] }).code, "no_button");
eq("赤い文があればボタンが押せても押さない（invalid）", FG.searchBlock({ found: true, disabled: false, texts: ["賃料（上限）は5桁以内で入力して下さい"] }).code, "invalid");
eq("state なし → no_button", FG.searchBlock(null).code, "no_button");
ok("待つ長さは 8秒（件数の数え直し）", FG.SEARCH_READY_WAIT_MS === 8000);

console.log("\n⑤ 同じ自動入力の2回目");
const k = FG.fillKey({ rent_max: 85000, ward_names: ["大阪市浪速区"], _audit_run_id: "sa_x" });
ok("同じ条件・300ms 後 → 2回目", FG.isDuplicateFill({ key: k, at: 1000 }, k, 1300));
ok("同じ条件・19ms 後（区のお客様の2本）→ 2回目", FG.isDuplicateFill({ key: k, at: 1000 }, k, 1019));
ok("同じ条件・8秒後 → 新しい依頼", !FG.isDuplicateFill({ key: k, at: 1000 }, k, 9000));
ok("同じ条件・15秒後（ITANDI の入れ直し）→ 新しい依頼", !FG.isDuplicateFill({ key: k, at: 1000 }, k, 16000));
ok("違う条件 → 新しい依頼", !FG.isDuplicateFill({ key: k, at: 1000 }, FG.fillKey({ rent_max: 90000 }), 1100));
ok("前が無い → 新しい依頼", !FG.isDuplicateFill(null, k, 1100));
ok("時計が戻った → 新しい依頼", !FG.isDuplicateFill({ key: k, at: 5000 }, k, 1000));

console.log("\n④ 中継（検索を押す前に止まった回だけ error＝そのサイトを飛ばす）");
eq("skip の失敗 → error で渡す", FG.relayError({ error: "watchdog-timeout", skip: true }), { error: "watchdog-timeout", pageError: "watchdog-timeout" });
eq("skip の無い失敗（古いページ）→ 今まで通り pageError だけ", FG.relayError({ error: "x" }), { error: null, pageError: "x" });
eq("成功 → どちらも null", FG.relayError({}), { error: null, pageError: null });

console.log("\n⑥ ITANDI のタブ（一覧でなければ1回開き直す・だめなら飛ばす）");
const tabs = [{ id: 1, url: "https://itandibb.com/rent_rooms/123" }, { id: 2, url: "https://itandibb.com/rent_rooms/list" }, { id: 3, url: "https://www.realnetpro.com/main.php" }];
eq("一覧のタブを先に", G.pickItandiTab(tabs).id, 2);
eq("一覧が無ければ他の ITANDI", G.pickItandiTab([tabs[0], tabs[2]]).id, 1);
eq("ITANDI が無ければ null", G.pickItandiTab([tabs[2]]), null);
eq("一覧・応答あり → use", G.itandiTabPlan({ url: "https://itandibb.com/rent_rooms/list", pong: true, list: true }).action, "use");
eq("一覧（?付き）・古い版（list なし）→ use", G.itandiTabPlan({ url: "https://itandibb.com/rent_rooms/list?page=2", pong: true, list: null }).action, "use");
eq("物件の詳細 → reload（not_itandi_list）", G.itandiTabPlan({ url: "https://itandibb.com/rent_rooms/123", pong: true }).reason, "not_itandi_list");
eq("ログインの画面 → reload", G.itandiTabPlan({ url: "https://itandibb.com/login", pong: true }).action, "reload");
eq("拡張の読み直しの後（応答なし）→ reload", G.itandiTabPlan({ url: "https://itandibb.com/rent_rooms/list", pong: false }).reason, "content_script_dead");
eq("場所が分からない → reload", G.itandiTabPlan({}).reason, "no_url");
ok("理由の日本語", /検索の画面/.test(G.reasonJa("not_itandi_list")));
const n1 = G.failureNotice({ customerName: "S", siteLabel: "itandi", error: "page-script側エラー（スキップ）: AXLX_SEARCH_BLOCKED: 入力の誤りで検索できない（⊗賃料（上限）は5桁以内で入力して下さい）" });
ok("押せなかった知らせ（0件とは言わない）", /検索のボタンが押せませんでした/.test(n1) && /0件とは限りません/.test(n1), n1);
const n2 = G.failureNotice({ customerName: "S", siteLabel: "itandi", error: "AXLX_TAB_DEAD: ITANDI のタブが検索の画面になりません（開き直しても・…）" });
ok("ITANDI のタブの知らせ", /ITANDI のタブが検索の画面になりません/.test(n2), n2);
const n3 = G.failureNotice({ customerName: "S", siteLabel: "リアプロ", error: "AXLX_TAB_DEAD: リアプロのタブが応答しません（読み直しても・…）" });
ok("リアプロのタブの知らせは今まで通り", /リアプロのタブが応答しません（読み直してもだめでした）/.test(n3), n3);
const n4 = G.failureNotice({ customerName: "S", siteLabel: "itandi", error: "page-script側エラー（スキップ）: watchdog-timeout" });
ok("watchdog は『途中で止まりました』", /条件の入力が途中で止まりました/.test(n4), n4);

console.log("\n⑦ 配線");
const mf = JSON.parse(read("manifest.json"));
eq("manifest の版", mf.version, "2.5.58");
const main = mf.content_scripts.find((c) => c.world === "MAIN" && c.js.indexOf("itandi-page-script.js") >= 0);
eq("itandi のページの中の段に form-guard（page-script より前）", main && main.js, ["human-wait.js", "itandi-update-days.js", "itandi-form-guard.js", "itandi-page-script.js"]);
const ps = read("itandi-page-script.js");
ok("page-script: 条件削除のボタンがあれば isResetLabel で押す（v2.5.46 は無くても1つずつ外す）", /FG\.isResetLabel\(b\.textContent\)/.test(ps) && /_itResetForm\(function \(res\)/.test(ps));
ok("page-script: リセットは確かめの窓でも止まらない（押す間だけ confirm を はい）", /window\.confirm = function/.test(ps) && /finally \{ window\.confirm = _oc; \}/.test(ps));
ok("page-script: 家賃の上限は rentText(…, \"max\")", /rentText\(cond\.rent_max, "max"\)/.test(ps));
ok("page-script: 家賃の下限は rentText(…, \"min\")", /rentText\(cond\.rent_min, "min"\)/.test(ps));
ok("page-script: 押す前に _itWaitSearchReady", ps.indexOf("_itWaitSearchReady(function (why, btn, texts)") > 0 && ps.indexOf("_itWaitSearchReady(function") < ps.indexOf("btn.click(); _searched = true;"));
ok("page-script: 押せない時は AXLX_SEARCH_BLOCKED で返す（押さない）", /_safeDone\("AXLX_SEARCH_BLOCKED: " \+ why\.ja\)/.test(ps));
ok("page-script: 残りの条件の例外を捕まえる（黙って240秒待たない）", /try \{ fillRemainingFields\(cond\); \}\s*catch \(errR\)/.test(ps));
ok("page-script: 失敗は skip:true", /if \(errMsg\) \{ msg\.error = errMsg; msg\.skip = true; \}/.test(ps));
ok("page-script: watchdog も skip:true", /error: "watchdog-timeout", skip: true/.test(ps));
ok("page-script: 返した後の続きは検索を押さない（_dead）", (ps.match(/if \(_dead\) return;/g) || []).length >= 4);
ok("page-script: 同じ依頼の2回目は動かさない", /FG\.isDuplicateFill\(_lastFillReq, _key, _now\)/.test(ps) && /_lastFillReq = \{ key: _key, at: _now \};/.test(ps));
ok("page-script: 点検に search_blocked・reset_btn", /_itAudit\.search_blocked = /.test(ps) && /_itAudit\.reset_btn = /.test(ps));
const ic = read("itandi-content.js");
ok("content: skip の時だけ error で中継", /error: e\.data\.skip && e\.data\.error \? String\(e\.data\.error\) : null/.test(ic));
ok("content: pageError は今まで通り", /pageError: e\.data\.error \|\| null/.test(ic));
ok("content: axlx-ping に答える（一覧か）", /msg\.type === "axlx-ping"/.test(ic) && /list: \/\^\\\/rent_rooms\\\/list\/\.test\(location\.pathname\)/.test(ic));
const bd = read("itandi-bulk-dl.js");
ok("bulk-dl: skip の fill-done では送信を始めない", /if \(e\.data\.skip\) \{ _autofillInitiated = false;/.test(bd) && bd.indexOf("if (e.data.skip)") < bd.indexOf("_autoSendArmed = true;\n    _autofillInitiated = false;"));
const bg = read("background.js");
ok("background: ITANDI は pickItandiTab", /self\.AxlxBatchGuard\.pickItandiTab\(allTabs\)/.test(bg));
ok("background: ITANDI のタブを確かめる", /if \(site === "itandi"\) tab = await _ensureItandiTab\(tab, auditRun, customer && customer\.id\);/.test(bg));
ok("background: 開き直すのは1回（tabs.update が1つ）", (bg.slice(bg.indexOf("async function _ensureItandiTab"), bg.indexOf("async function _webappAutofill")).match(/chrome\.tabs\.update\(/g) || []).length === 1);
ok("background: だめな時は待ち手を閉じて AXLX_TAB_DEAD", /_endFillDoneWaiter\("itandi", String\(customerId\), "ITANDI のタブが検索の画面でない"\)/.test(bg) && /AXLX_TAB_DEAD: ITANDI のタブが検索の画面になりません/.test(bg));
ok("background: fill-done の error は飛ばす（page-script側エラー（スキップ））", /if \(fillDone\.error\) \{\n    throw new Error\("page-script側エラー（スキップ）: " \+ fillDone\.error\);/.test(bg));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
