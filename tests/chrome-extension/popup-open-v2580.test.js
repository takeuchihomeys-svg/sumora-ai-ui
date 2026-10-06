// 実行: node tests/chrome-extension/popup-open-v2580.test.js
// 2026-10-06 v2.5.80
//   ① 竹内「物件検索する際の拡張ツールを開く際も重すぎるので、このあたりも最善の案で改善する」
//   ② 竹内「拡張ツール itandi 駅の部分ひかっていない ちゃんとリアプロ同様に光るようにする」
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const P = require(path.join(dir, "itandi-guide-plan.js"));
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

console.log("── ① 開く時の重さ");
const pp = read("popup.js");
ok("前回の一覧（chrome.storage.local）をすぐ出し、裏で取り直す", /const CUSTOMER_LIST_STORE_KEY = "axlx_customer_list_v1";/.test(pp) && /if \(!shown\) await refresh;/.test(pp));
ok("一覧は軽い形（?view=list）で取る", /\/api\/property-customers\?view=list/.test(pp));
ok("取り直して変わった時だけ描き直す（検索の文字・見ていた場所はそのまま）", /if \(sig !== _customerListSig\)/.test(pp) && /list\.scrollTop = top;/.test(pp));
ok("開いているお客様は取り直した全部の値を残す", /data\[i\] = Object\.assign\(\{\}, data\[i\], selectedCustomer\);/.test(pp));
ok("お客様を開いた時は今まで通り ?id= で全部を取り直す", /property-customers\?id=\$\{encodeURIComponent\(id\)\}/.test(pp));
ok("地名・駅の表は同じ物を2回取らない（差分の同期は1日1回・取った表を渡す）", /loadLearnedMapsCached\(\);/.test(pp) && !/seedMapsIfEmpty\(\)\.then\(\(\) => fetchLearnedMaps\(\)\)/.test(pp) && /void seedMapsIfEmpty\(\{ regions: ok\.data\.regions \}, \{ stations: ok\.data\.stations \}\);/.test(pp));
ok("学習済みの表は前回の物を先に使い、30分より古い時だけ取り直す", /const LEARNED_MAPS_FRESH_MS = 30 \* 60 \* 1000;/.test(pp) && /if \(cached && cached\.data\) _applyLearnedMaps\(cached\.data\);/.test(pp));
ok("background: 1人を探すのに全員を取らない（?id=）", (read("background.js").match(/property-customers\?id=" \+ encodeURIComponent\(String\(_cid\)\)/g) || []).length === 2);
const api = fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "property-customers", "route.ts"), "utf8");
ok("API: ?view=list は重い列を外し、要望の項目の計算をしない・会話は印の分だけ", /const LIST_DROP = \["ai_summary", "ai_summary_json", "personality_profile", "raw_format_text", "condition_summary", "condition_summary_hash"\]/.test(api) && /if \(listView\) \{/.test(api) && /o\.linked_conversation = conv \? \{ id: conv\.id, property_customer_id: conv\.property_customer_id, last_sender/.test(api));
ok("API: 既定（view なし）の形は変えない（want_items・会話の最後の発言はそのまま）", /want_items: itemizeWants\(c as WantsCustomerLike\)/.test(api) && /linked_conversation: convMap\.get\(c\.id\) \?\?/.test(api));
ok("API: 一覧の形でも子の行（2つ目の探し物）の親の会話と家賃の必ずの印は残る", /c\.parent_customer_id \? convMap\.get\(c\.parent_customer_id\)/.test(api) && !/"requirement_strength"/.test(api.match(/const LIST_DROP = \[[^\]]*\]/)[0]));

console.log("── ② ITANDI の路線・駅の小窓");
// 実画面の形（路線・駅選択の小窓・都道府県 近畿／大阪府・路線のチェックの一覧・駅の欄は「路線を選ばなくても検索可能です」）
const linesModal = "路線・駅選択 都道府県 北海道 東北 関東 近畿 大阪府 京都府 路線 絞り込み 東海道新幹線 山陽新幹線 JR東海道本線(JR京都線・JR神戸線) JR東西線 高速電気軌道第1号線(大阪メトロ御堂筋線) 駅 路線を選ばなくても検索可能です 確定";
const areaModal = "所在地選択 都道府県 近畿 大阪府 市区町村 大阪市北区 大阪市都島区 全域 確定";
ok("路線・駅の小窓を所在地の小窓と取り違えない（都道府県の選びがあっても）", P.modalKindFromText(linesModal) === "lines");
ok("所在地の小窓は所在地", P.modalKindFromText(areaModal) === "area");
ok("語で決まらない時は null（旧の見分けに戻す）", P.modalKindFromText("確定 キャンセル") === null);
const ig = read("itandi-guide.js");
ok("案内: 小窓の種類は見出し・文の語で見分ける（regionName だけで決めない）", /function dialogKind\(dlg\)/.test(ig) && /if \(dialogKind\(dlg\) === "area"\) return \{ done: false, target: \[closeBtnOf\(dlg\)\], note: "この方は駅で探します。/.test(ig) && /if \(dialogKind\(dlg\) === "lines"\) return \{ done: false, target: \[closeBtnOf\(dlg\)\], note: "この方は地域（所在地）で探します。/.test(ig));
ok("案内: 選ぶ路線が一覧の下の方でも、一覧の中だけ1回動かして見える所へ（押さない）", /if \(ln\.length\) \{ revealWardOnce\(ln\[0\], "line:"/.test(ig));
ok("案内: 一覧を動かす部品の小窓の探し方の引用符の抜けを直した（旧は毎回例外で一度も動いていなかった）", /el\.closest\('\[role="dialog"\]'\)/.test(ig) && !/el\.closest\(\[role=dialog\]\)/.test(ig));
ok("案内: 路線を選んだ後は駅、その後「確定」（今まで通り）", /return \{ done: false, target: st, note: "光っている駅にチェック/.test(ig) && /target: \[btnByText\(dlg, "確定"\)\], note: "選び終えたら「確定」"/.test(ig));
ok("manifest の版 2.5.82", JSON.parse(read("manifest.json")).version === "2.5.82");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
