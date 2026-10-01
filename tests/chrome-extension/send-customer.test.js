// 実行: node tests/chrome-extension/send-customer.test.js
// v2.5.48（2026-09-30 検索と見張りのテストで見つかった物・重い順）
//
// 本番の証拠（search_audits 9/30 16:19〜17:37・property_pickups・extension_snapshots #23・#27）:
//   ① 別のお客様の ITANDI の物件が前のお客様に付く:
//      🐥 さん（42a89f52）の回 16:29〜 の一覧 18件と yasuki さん（458cbd41）の回 16:43〜 の 16＋18件が ℳ さん（382d4296）の property_pickups に、
//      YUMA（509cd061）の回 17:18〜 の 15件が yasuki さんに入った。その回の点検の行には itandi_precheck の段が無い（＝見分けの合図も別の人の id で来ていた）。
//      送る相手を「送る直前に popup／storage に聞く」形だったので、前の人が返っても気付けなかった
//   ② 同じ自動入力が2本走る: ITANDI の一括の回すべてに 6〜13秒遅れの trigger=single の行が付き、ページの段が全部そちらに付いた。
//      区のお客様（YUMA・🐥・yasuki）は2本が所在地の窓でぶつかり page:watchdog（240秒）
//   ③ 順の回で ITANDI の背面のタブを前に出さない（YUMA 1回目は資料3件で止まった）
//   ④ リアプロを飛ばした後も fill-done の待ち手が残り、約90秒後に時間切れの写真
//   ⑥ 手の命令がリアプロのログインが切れた PC に渡る
const fs = require("fs");
const path = require("path");
const IG = require("../../chrome-extension/itandi-guard.js");
const SA = require("../../chrome-extension/search-audit.js");
const FG = require("../../chrome-extension/itandi-form-guard.js");
const G = require("../../chrome-extension/batch-guard.js");

const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
function ok(name, cond, detail) { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond || !detail ? "" : "\n      " + detail)); }
function eq(name, a, b) { const c = JSON.stringify(a) === JSON.stringify(b); ok(name, c, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

const M = "382d4296-0000-0000-0000-000000000001";      // ℳ さん（前のお客様）
const HIYO = "42a89f52-0000-0000-0000-000000000002";   // 🐥 さん
const YASUKI = "458cbd41-0000-0000-0000-000000000003";
const YUMA = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
const T0 = Date.parse("2026-09-30T07:29:30Z"); // 16:29:30 JST（🐥 さんの回の始まり）

console.log("\n① 入力を始めた合図の時に、その回のお客様を結ぶ（bindFillCustomer）");
eq("直前に set-fill-customer が来ている → 結ぶ", IG.bindFillCustomer({ id: HIYO, name: "🐥", at: T0 }, T0 + 9000), { id: HIYO, name: "🐥" });
eq("popup の読み直し（6秒）＋人の間の後でも結ぶ（13秒後）", IG.bindFillCustomer({ id: HIYO, name: "🐥", at: T0 }, T0 + 13000), { id: HIYO, name: "🐥" });
eq("上限ちょうど（90秒）は結ぶ", IG.bindFillCustomer({ id: HIYO, name: null, at: T0 }, T0 + IG.FILL_BIND_WINDOW_MS), { id: HIYO, name: null });
eq("上限を過ぎた合図は結ばない（一括の後の手の検索）", IG.bindFillCustomer({ id: HIYO, name: "🐥", at: T0 }, T0 + IG.FILL_BIND_WINDOW_MS + 1), null);
eq("控えが無い（手の検索）", IG.bindFillCustomer(null, T0), null);
eq("id が空", IG.bindFillCustomer({ id: "", name: "x", at: T0 }, T0 + 1), null);
eq("時計が戻った（合図が控えより前）は結ばない", IG.bindFillCustomer({ id: HIYO, at: T0 }, T0 - 5), null);
eq("数の id も文字に", IG.bindFillCustomer({ id: 12, at: T0 }, T0 + 1), { id: "12", name: null });

console.log("\n① 送る相手（sendCustomer）— 本番の取り違えの形そのまま");
// 16:39 の18件: popup／storage の答えは ℳ さん・入力を始めたのは 🐥 さん
eq("popup が ℳ さん・この回は 🐥 さん → 🐥 さんで送る（ℳ さんの名前・条件は使わない）",
  IG.sendCustomer({ name: "ℳ", id: M, conditions: "家賃〜7万・天王寺" }, { id: HIYO, name: "🐥" }),
  { name: "🐥", id: HIYO, conditions: null, source: "batch", mismatch: M });
// 16:51・16:53: yasuki さんの回も ℳ さんが返った（前の前の人）
eq("popup が前の前の人（ℳ さん）・この回は yasuki さん", IG.sendCustomer({ name: "ℳ", id: M, conditions: "x" }, { id: YASUKI, name: "yasuki" }).id, YASUKI);
// 17:30: YUMA の回に yasuki さんが返った
eq("popup が yasuki さん・この回は YUMA", IG.sendCustomer({ name: "yasuki", id: YASUKI, conditions: "x" }, { id: YUMA, name: "YUMAテスト（検索確認）" }),
  { name: "YUMAテスト（検索確認）", id: YUMA, conditions: null, source: "batch", mismatch: YASUKI });
eq("popup も同じ人 → popup の名前・条件をそのまま使う", IG.sendCustomer({ name: "🐥", id: HIYO, conditions: "浪速区・1LDK" }, { id: HIYO, name: "🐥" }),
  { name: "🐥", id: HIYO, conditions: "浪速区・1LDK", source: "batch", mismatch: null });
eq("popup が答えない（id なし）→ この回の人で送る", IG.sendCustomer({ name: null, id: null, conditions: null }, { id: HIYO, name: "🐥" }),
  { name: "🐥", id: HIYO, conditions: null, source: "batch", mismatch: "(none)" });
eq("手の検索（結びなし）→ 今まで通り popup の答え", IG.sendCustomer({ name: "ℳ", id: M, conditions: "c" }, null),
  { name: "ℳ", id: M, conditions: "c", source: "popup", mismatch: null });
eq("手の検索・popup も空 → 空のまま（今まで通り）", IG.sendCustomer({}, null), { name: null, id: null, conditions: null, source: "popup", mismatch: null });
eq("id の型が違っても同じ人（数と文字）", IG.sendCustomer({ name: "a", id: 7, conditions: "c" }, { id: "7", name: "a" }).mismatch, null);

console.log("\n② 同じ切り替えの2回目（popup の入口・isDuplicateSwitch）");
const sw = { customerId: HIYO, site: "itandi", auditRunId: "sa_munsbk96_0q2rt2sk", is_wide: false, areaMode: "ward" };
const k1 = SA.switchKey(sw);
eq("同じ中身は同じ鍵（chrome.runtime.onMessage と underbar の中継）", SA.switchKey(Object.assign({ from: "underbar-parent", action: "switch-customer", customerName: "🐥" }, sw)), k1);
ok("数ミリ秒後の2回目は受けない", SA.isDuplicateSwitch({ key: k1, at: T0 }, k1, T0 + 12));
ok("窓の中（3.9秒）", SA.isDuplicateSwitch({ key: k1, at: T0 }, k1, T0 + 3900));
ok("窓ちょうど（4秒）は通す", !SA.isDuplicateSwitch({ key: k1, at: T0 }, k1, T0 + SA.SWITCH_DUP_WINDOW_MS));
ok("ITANDI の入れ直し（9秒以上後・同じ回）は通す", !SA.isDuplicateSwitch({ key: k1, at: T0 }, k1, T0 + 9000));
ok("別のお客様は通す", !SA.isDuplicateSwitch({ key: k1, at: T0 }, SA.switchKey(Object.assign({}, sw, { customerId: YASUKI })), T0 + 10));
ok("別のサイト（同時の回のリアプロ）は通す", !SA.isDuplicateSwitch({ key: k1, at: T0 }, SA.switchKey(Object.assign({}, sw, { site: "realpro" })), T0 + 10));
ok("別の点検の回は通す", !SA.isDuplicateSwitch({ key: k1, at: T0 }, SA.switchKey(Object.assign({}, sw, { auditRunId: "sa_x" })), T0 + 10));
ok("地域→駅の2パス目（areaMode が違う）は通す", !SA.isDuplicateSwitch({ key: k1, at: T0 }, SA.switchKey(Object.assign({}, sw, { areaMode: "station" })), T0 + 10));
ok("広げての回（is_wide が違う）は通す", !SA.isDuplicateSwitch({ key: k1, at: T0 }, SA.switchKey(Object.assign({}, sw, { is_wide: true })), T0 + 10));
ok("前が無い", !SA.isDuplicateSwitch(null, k1, T0));
ok("時計が戻った時は2回目にしない", !SA.isDuplicateSwitch({ key: k1, at: T0 }, k1, T0 - 1));
ok("点検の回が無い（AIX だけの PC）も同じ人・同じサイトなら2回目", SA.isDuplicateSwitch({ key: SA.switchKey({ customerId: HIYO, site: "itandi" }), at: T0 }, SA.switchKey({ customerId: HIYO, site: "itandi", auditRunId: null }), T0 + 5));

console.log("\n② ページの側の鍵は点検の run_id を入れない（fillKey）");
const cond = { area_mode: "ward", ward_names: ["大阪市北区", "大阪市福島区"], rent_max: 9, floor_plan: "1K、1LDK", walk_minutes: 10 };
eq("run_id だけ違う依頼は同じ鍵（1回目＝一括の回・2回目＝popup が作り直した single）",
  FG.fillKey(Object.assign({}, cond, { _audit_run_id: "sa_muns31df_9gde0hv2" })), FG.fillKey(Object.assign({}, cond, { _audit_run_id: "sa_muns3b1r_8b7ot2i6" })));
eq("run_id が無い依頼とも同じ鍵", FG.fillKey(Object.assign({}, cond, { _audit_run_id: "sa_a" })), FG.fillKey(cond));
ok("条件が違えば別の鍵", FG.fillKey(Object.assign({}, cond, { rent_max: 12 })) !== FG.fillKey(cond));
ok("2回目は動かさない（6秒後・run_id 違い）", FG.isDuplicateFill({ key: FG.fillKey(Object.assign({}, cond, { _audit_run_id: "a" })), at: T0 }, FG.fillKey(Object.assign({}, cond, { _audit_run_id: "b" })), T0 + 6000));
eq("null はそのまま", FG.fillKey(null), "null");
eq("配列はそのまま", FG.fillKey([1, 2]), "[1,2]");

console.log("\n③ ITANDI の背面のタブ（itandiTabPlan の front）");
const LIST = "https://itandibb.com/rent_rooms/list";
eq("背面（hidden）→ 使う＋前に出す", G.itandiTabPlan({ url: LIST, pong: true, list: true, vis: "hidden" }), { action: "use", reason: "alive", front: true });
eq("見えている → 前に出さない", G.itandiTabPlan({ url: LIST, pong: true, list: true, vis: "visible" }), { action: "use", reason: "alive", front: false });
eq("vis が分からない古い中身 → 前に出さない", G.itandiTabPlan({ url: LIST, pong: true, list: true }).front, false);
eq("一覧でない → 開き直す（今まで通り）", G.itandiTabPlan({ url: "https://itandibb.com/rent_rooms/123", pong: true, vis: "hidden" }).action, "reload");

console.log("\n⑥ 拾いに行く前のリアプロのタブ（realproReady）");
eq("main.php のタブがある → true", G.realproReady([{ url: "https://itandibb.com/rent_rooms/list" }, { url: "https://www.realnetpro.com/main.php?method=estate" }]), true);
eq("ログインの画面だけ（本番の写真 #23: index.php）→ false", G.realproReady([{ url: "https://www.realnetpro.com/index.php" }, { url: LIST }]), false);
eq("ログインの画面と main.php の両方 → true", G.realproReady([{ url: "https://www.realnetpro.com/index.php" }, { url: "https://www.realnetpro.com/main.php" }]), true);
eq("リアプロのタブが無い → null（今まで通り拾う）", G.realproReady([{ url: LIST }]), null);
eq("空・壊れた入力 → null", [G.realproReady([]), G.realproReady(null), G.realproReady([{}, null])], [null, null, null]);

console.log("\n配線（読み込み・呼び出し）");
{
  const mf = JSON.parse(read("manifest.json"));
  eq("manifest の版", mf.version, "2.5.54");
  const itCs = mf.content_scripts.find((c) => (c.js || []).includes("itandi-bulk-dl.js"));
  ok("itandi-guard.js は itandi-bulk-dl.js より前", itCs.js.indexOf("itandi-guard.js") >= 0 && itCs.js.indexOf("itandi-guard.js") < itCs.js.indexOf("itandi-bulk-dl.js"));
  const html = read("popup.html");
  ok("popup は search-audit.js を popup.js より前に読む", html.indexOf("search-audit.js") >= 0 && html.indexOf("search-audit.js") < html.indexOf('src="popup.js"'));

  const bd = read("itandi-bulk-dl.js");
  ok("set-fill-customer を受ける", /msg\.type !== "axlx-set-fill-customer"\) return;\s*\n\s*_itFillCtx = /.test(bd));
  ok("入力を始めた合図で結ぶ", /_autofillInitiated = true;[\s\S]{0,260}_itBound = [\s\S]{0,80}bindFillCustomer\(_itFillCtx, Date\.now\(\)\)/.test(bd));
  ok("検索の完了で送る相手を確定", /_autoSendArmed = true;\s*\n\s*_autofillInitiated = false;\s*\n\s*_itRunBound = _itBound;/.test(bd));
  ok("全ページの自動送信は _getSendCustomer（手の送信は manual）", /_getSendCustomer\(_manual, function\(customerName, customerId, customerConditions\)/.test(bd));
  ok("0件の合図も _getSendCustomer", /_getSendCustomer\(false, function\(_n, customerId\)/.test(bd));
  ok("手のボタン（onSendToLine）は今まで通り popup に聞く", /function onSendToLine\(\)[\s\S]{0,420}getCustomerFromPopup\(function \(customerName, customerId, customerConditions\)/.test(bd));
  ok("自動の送信で getCustomerFromPopup を直接呼ぶ所は _getSendCustomer の中と手のボタンだけ", (bd.match(/getCustomerFromPopup\(function/g) || []).length === 2);
  ok("取り違えを直した回は点検に残す（customer_fix）", /_itAuditRes\.customer_fix = _itCustomerFix/.test(bd));

  const bg = read("background.js");
  ok("一括の回: set-fill-customer に名前も載せる", /type: "axlx-set-fill-customer", customerId: String\(customer\.id\), customerName: customer\.customer_name \|\| null/.test(bg));
  ok("ITANDI の背面のタブを前に出す（使う時）", /if \(plan\.action === "use"\) \{\s*\n\s*if \(plan\.front\) await _bringItandiTabFront\(tab, runId, probe\.vis\);/.test(bg));
  ok("ITANDI の背面のタブを前に出す（開き直した後）", /if \(plan2\.front\) await _bringItandiTabFront\(tab, runId, probe2\.vis\);/.test(bg));
  ok("_probeItandiTab が vis を返す", /list: pong && typeof resp\.list === "boolean" \? resp\.list : null, vis: pong && typeof resp\.vis === "string" \? resp\.vis : null/.test(bg));
  ok("itandi-content の ping が vis を返す", /pong: true, list: [^\n]*vis: document\.visibilityState/.test(read("itandi-content.js")));
  ok("前に出すのはタブだけ（窓は触らない）", !/_bringItandiTabFront[\s\S]{0,700}chrome\.windows\.update/.test(bg));
  ok("リアプロを飛ばす時に待ち手を閉じる", /_endFillDoneWaiter\("realnetpro", String\(customerId\), "リアプロのタブが検索の画面でない"\)[\s\S]{0,120}throw new Error\("AXLX_TAB_DEAD: リアプロ/.test(bg));
  ok("最初の確かめにお客様を渡す", /_ensureRealproTab\(tab, auditRun, null, customer && customer\.id\)/.test(bg));
  ok("やり直しの確かめにもお客様を渡す", /"content_script_dead" : "page_script_dead", _cidStr\)/.test(bg));
  ok("拾いに行く前に rp=0", /realproReady\(await chrome\.tabs\.query\(\{\}\)\) === false\) _qs\.push\("rp=0"\)/.test(bg));

  const pp = read("popup.js");
  // 受け口は underbar の中継の1本（動きは switch-once.test.js で確かめる）
  ok("受け口は underbar の中継の1本（_runSwitchCustomer）", /action === "switch-customer"\) \{[\s\S]{0,200}_runSwitchCustomer\(e\.data\)/.test(pp));
  ok("chrome.runtime.onMessage の受け口は無い", !/msg\.type === "axlx-switch-customer"/.test(pp));
  ok("2回目の見分けは実際に押す直前（控えは1つ）", (pp.match(/_lastSwitchSeen = \{ key: key, at: now \}/g) || []).length === 1 && (pp.match(/_isDupSwitch\(d\)\)/g) || []).length === 1);
  ok("background の個別の ITANDI は宣言済みの名前（_custName）を渡す", /customerId: String\(_cid\), customerName: _custName \}/.test(bg) && !/_customer && _customer\.customer_name/.test(bg));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
