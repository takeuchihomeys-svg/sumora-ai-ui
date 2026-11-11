// 実行: node tests/chrome-extension/auto-never-stops-v2690.test.js
// 2026-11-11 竹内さん「案内モードで光る部分のところのことを理解して技術力に差があれば改善するようにする。
//   ちゃんと展開もされるように。あと検索もとまらないように。検索のボタンの場所2か所あることもちゃんと理解する」
//
//   ① 検索ボタンの2か所を、小窓の「確定してリストへ」と取り違えない
//   ② 展開（＋を押して開く）は案内モードと同じ探し方を使う
//   ③ 止まった時に**検索を押さずに終わらない**（条件が入っていれば押す）
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const ps = read("page-script.js");

console.log("■ ① 検索ボタンは2か所（左のサイドバー／小窓の中）を取り違えない");
{
  ok("小窓の中かを見る（_inModal）", /var _inModal = function \(el\)/.test(ps));
  ok("左のサイドバーを優先する（_isSidebar）", /var _isSidebar = function \(el\)/.test(ps));
  ok("押すのは左を先に（goOrder）", /var goOrder = _sidebar\.length \? _sidebar\.concat/.test(ps));
  ok("どちらを押したかを点検に残す（which）", /which: _inModal\(btn\) \? "modal" : \(_isSidebar\(btn\) \? "sidebar" : "unknown"\)/.test(ps));
  // 小窓の中の「確定してリストへ」は別物として扱う
  ok("所在地モーダルは「確定してリストへ」で閉じる（小窓の中のボタン）", /function closeAreaModal\(\)[\s\S]{0,700}確定してリストへ/.test(ps));
  ok("駅モーダルも同じ", /function closeStationModal\(\)[\s\S]{0,700}確定してリストへ/.test(ps));
  ok("その押下も点検に残す（modal_confirm / station_confirm）", /_auditStepP\('modal_confirm'/.test(ps) && /_auditStepP\('station_confirm'/.test(ps));
  ok("小窓の閉じるボタンもカーソルを動かして押す", /_humanPointerClick\(d, function \(\) \{ try \{ d\.click\(\); \} catch \(_\) \{\} \}\)/.test(ps));
}

console.log("\n■ ② 展開（＋を押して開く）は案内モードと同じ探し方");
{
  ok("文字のノードからたどる（_textMatches）", /function _textMatches\(texts, sel\)/.test(ps));
  ok("_findByText がそれを使う", /function _findByText\(list\) \{\s*var hits = _textMatches\(list\)/.test(ps));
  ok("「…＋」の見出しを探す（PLUS_HEAD_RE）", /var PLUS_HEAD_RE = \/\[＋\+\]\$\//.test(ps));
  ok("欄から上へたどって開く（_openerFor）", /function _openerFor\(el\)/.test(ps));
  ok("名前でも探す（_openerForKind）", /function _openerForKind\(name, el\)/.test(ps));
  ok("見えなければ開いて待つ（_ensureFieldVisible）", /function _ensureFieldVisible\(el, name, maxMs\)/.test(ps));
  ok("値の入力の前に開く（setSelVal）", /function setSelVal\(name, val\) \{[\s\S]{0,600}_ensureFieldVisible/.test(ps));
  ok("待つだけでなく開くのを試す（_operateWithPointer）", /if \(attempt === 1\) \{[\s\S]{0,200}_ensureFieldVisible/.test(ps));
}

console.log("\n■ ③ 止まった時に検索を押さずに終わらない");
{
  ok("止まる前に条件を見る（_axGateCheck）", /_gateNow = _axGateCheck\(\)/.test(ps));
  ok("場所が入っていなければ止める（全件検索しない）", /_areaMissing/.test(ps) && /indexOf\('場所'\) === 0/.test(ps));
  ok("条件が入っていれば**検索を押す**", /条件は入っているので\*\*検索を押してから\*\*終わります/.test(ps) && /try \{ clickSearch\(\); \} catch \(_\) \{\}/.test(ps));
  ok("その判断を点検に残す（stall_recover_search）", /_auditStepP\('stall_recover_search'/.test(ps));
  ok("押したらそこで止めない（notifyDone は clickSearch が呼ぶ）", /clickSearch\(\)[\s\S]{0,80}return;   \/\/ clickSearch が notifyDone を呼ぶ/.test(ps));
}

console.log("\n■ ④ 検索前の確認で止めない（v2.6.81）が残っている");
{
  ok("場所だけ止める", /_auditStepP\('gate_stop_area'/.test(ps));
  ok("家賃などは警告して検索する", /_auditStepP\('gate_warn'/.test(ps));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
