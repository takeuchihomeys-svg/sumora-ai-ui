// 実行: node tests/chrome-extension/no-press-before-search-v2703.test.js
// 2026-11-12 竹内さん「自動で検索したら検索も条件入れる前にいま出ている物件のダウンロードを始めてしまうバグがおきる
//   原因見つけて改善するようにする」
//
//   症状（写真）: ポップアップは「h.r の検索条件: リアプロで以下の条件を入力してください／🔍 リアプロで自動検索」の
//   ままなのに、右の枠は「資料を見る（あと5秒）を選択中」＝**すでに一覧の物件を押して回っている**。
//
//   原因: 自動押下の入口（`inject()` の Case C・`_maybeAutoPressOnLoad`）は
//     **「印刷用PDFがある一覧が画面にある」だけ**で押し始めていた。
//     「その一覧が**今のお客様の検索で出た物か**」を確かめていなかった。
//   → 自動入力を始めた瞬間（`axlx-autofill-initiated`＝条件を入れる前）から、
//     画面に残っている**前のお客様の一覧**を押して送ってしまう。
//
//   直し: ① 自動入力の最中（initiated 〜 fill-done）は押さない
//         ② 「自動入力の前に無かった行（＝新しい行）」が1つも無ければ押さない
//         ③ 条件の入力が始まったら、前の一覧で回っている自動押下を止める
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const bd = read("bulk-dl.js");

console.log("■ ① 自動入力の最中（条件を入れる前）は押さない");
{
  ok("印を持つ（_autofillInProgress）", /var _autofillInProgress = false;/.test(bd));
  ok("自動入力の開始で立てる（axlx-autofill-initiated）", /_setFillInProgress\(true\)/.test(bd));
  ok("  「検索を押すまでは押しません」と記録する", /検索を押すまでは画面の一覧を押しません/.test(bd));
  ok("検索を押した合図（fill-done）で解く", /_autofillInProgress = false;\s*\n\s*_setFillInProgress\(false\);/.test(bd));
  ok("_maybeAutoPressOnLoad が最中は止める", /if \(_autofillInProgress\) \{/.test(bd) && /blocked_during_fill/.test(bd));
  ok("inject の自動の枝も最中は通さない", /&& !_autoPdfRun && !_autofillInProgress\) \{/.test(bd));
  ok("「自動で押して送る」を手で押しても最中は断る", /条件の入力中なので押しません/.test(bd) && /reason: "filling"/.test(bd));
  ok("合図が来ないまま固まっても20分で解く（永久に押せなくしない）", /_autofillStuckMs = 20 \* 60 \* 1000/.test(bd));
  ok("  ⚠ sessionStorage には残さない（読み直し後に検索結果を押せなくなるため）", !/axlx_fill_in_progress/.test(bd));
}

console.log("\n■ ② 「新しい行」が無ければ押さない（前のお客様の一覧を送らない）");
{
  ok("自動入力の直前の行を控える（_preAutofillBtns）", /_preAutofillBtns = new Set\(findPrintBtns\(\)/.test(bd));
  ok("inject の自動の枝で新しい行を確かめる", /_hasNewForAuto/.test(bd));
  ok("  新しい行が1つも無ければ押さない", /if \(_preAutofillBtns\.size > 0 && !_hasNewForAuto\) \{/.test(bd));
  ok("  理由を点検に残す（blocked_not_new_rows）", /blocked_not_new_rows/.test(bd));
  ok("  控えが空の時（初回）は今まで通り動く", /_preAutofillBtns\.size > 0/.test(bd));
}

console.log("\n■ ③ 条件の入力が始まったら、前の一覧の自動押下を止める");
{
  ok("回っていたら止める", /if \(_autoPdfRun\) \{\s*\n\s*_autoPdfRun\.stopped = true;/.test(bd));
  ok("  「前の一覧の自動押下を止めます」と記録", /前の一覧の自動押下を止めます/.test(bd));
  ok("  止めるボタンも隠す", /axlx-autopdf-stop-btn/.test(bd));
  ok("  押し始めの印を戻す（新しい検索でまた押せる）", /_pendingAutoSendDispatched = false; \/\/ 新しい検索なので/.test(bd));
}

console.log("\n■ ④ 検索の後の一覧は今まで通り押せる（直しすぎていない）");
{
  ok("fill-done が来たら押せる状態に戻る", /_autofillInProgress = false;/.test(bd));
  ok("fill-done の後は今まで通り構える（_autoSendArmed）", /_autoSendArmed = true;/.test(bd));
  ok("新しい行があれば押し始める（正常な流れは止めない）", /_hasNewBtn/.test(bd) && /_maybeAutoPressOnLoad\(\);/.test(bd));
  ok("関所で止めた合図（gate）では構えない（今まで通り）", /if \(e\.data\.gate\)/.test(bd));
}

console.log("\n■ ⑤ 全物件を送らない安全弁は残っている");
{
  ok("自動モード・スタッフモードの関所", /if \(_autoPdfRun \|\| !_autoModeOn \|\| _staffModeOn\) return;/.test(bd));
  ok("並べ替えの後の条件の確認（v2.7.2）", /_AD_SORT_GRACE_MS/.test(bd) && /_blockedAfterSortNote/.test(bd));
  ok("同じ一覧で二度始めない", /_autoPdfSig/.test(bd));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
