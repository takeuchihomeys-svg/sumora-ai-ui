// tests/chrome-extension/never-stop-v2752.test.js
// 実行: node tests/chrome-extension/never-stop-v2752.test.js
// 2026-11-14 竹内さん「出来なくても止まらずにそのまま動かすようにする」
//
//   ⚠ これまで「安全弁」のつもりで**止めていた**所が、現場では**物件が1件も出ない**という
//     一番困る結果になっていた（竹内さんの判断: 止まる方が困る）。
//
//   方針（このテストで固定する）:
//     ① 出来なくても**止まらない**（警告を出して続行）
//     ② ただし**黙って続けない**（点検と画面に必ず残す）
//     ③ 本当に危ない時だけ止める:
//        ・スタッフモード（人が選んだ物を勝手に触らない）
//        ・自動入力の最中（別のお客様の一覧を送ってしまう）
//        ・統括が unsafe と言っている時
//        ・停止ボタン（人が止めた）
//        ・押せる行が本当に0件（押す物が無い）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const bd = read("bulk-dl.js");
const code = bd.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

console.log("■ ① 並べ替えが失敗しても止まらない");
{
  ok("⚠ 「自動では押しません」をやめた", !/並べ替えができませんでした。自動では押しません/.test(code));
  ok("  この並びのまま押す", /この並びのまま押します/.test(code));
  ok("  3回試す", /var _maxTry = 3;/.test(code));
}

console.log("\n■ ② 条件が読めなくても止まらない（並べ替えの後）");
{
  ok("⚠ 「自動では押しません」をやめた（条件が読めない時）", !/条件が読めない → 自動では押しません/.test(code));
  ok("  このまま続けると出す", /このまま続けます/.test(code));
  ok("  点検に proceed_unverified を残す", /proceed_unverified/.test(code));
  ok("  ⚠ 止める return をやめた（_adSortBlocked で止めない）", !/_adSortBlocked = true;[\s\S]{0,300}?return;/.test(code));
}

console.log("\n■ ③ 黙って続けない（必ず残す）");
{
  ok("並べ替え失敗を点検に残す", /failed_continue/.test(code));
  ok("条件が読めない事を点検に残す", /proceed_unverified/.test(code));
  ok("画面にも警告を出す", /_nudge\(/.test(code) && /_blockedAfterSortNote\(\)/.test(code));
}

console.log("\n■ ④ 本当に危ない時は止める（安全弁は残す）");
{
  ok("スタッフモードでは押さない", /_staffModeOn\) \{ _nudge\("スタッフモードでは自動で押しません"\)/.test(code));
  ok("自動入力の最中は押さない", /_autofillInProgress/.test(code));
  /**
   * 2026-11-14 竹内さん「自動はとめないようにする」→ 決定が変わった。
   *   ⚠ 旧は「統括が unsafe なら止める」だったが、止まると**物件が1件も出ない**（現場が止まる）。
   *   → **統括では止めない**（警告だけ）。止めるのは人の意思（スタッフモード・停止ボタン）と
   *     自動入力の最中（別のお客様の一覧を送ってしまう）だけ。
   */
  ok("⚠ 統括では止めない（unsafe でも警告だけ・竹内さん 2026-11-14）", /統括では止めません|自動は止めません/.test(code) || /統括が「危ない」と言っています[\s\S]{0,200}?return false;/.test(code));
  ok("押せる行が0件なら止める（押す物が無い）", /no-rows/.test(code));
  ok("停止ボタン（人）は効く", /_autoPdfRun[\s\S]{0,200}?stopped|⏹ 中断/.test(bd));
}

console.log("\n■ ⑤ 構文が壊れていない");
{
  let syntaxOk = true;
  try { new Function(bd); } catch (e) { syntaxOk = false; }
  ok("bulk-dl.js の構文が通る", syntaxOk);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
