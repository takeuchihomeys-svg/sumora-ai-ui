// tests/chrome-extension/shot-in-auto-mode-v2756.test.js
// 実行: node tests/chrome-extension/shot-in-auto-mode-v2756.test.js
// 2026-11-14 竹内さん「さっきいれているデータベースをみる」「データベースを見る考えを統括重要にする」
//
//   ★ DBを見て分かった事（版ごとに集計したら一発で分かった）:
//     2.7.50: 写真 167/168件（99%）
//     2.7.55: 写真 0件  ← **私が壊した**
//
//   ⚠ 原因（2つ・どちらも「人が押した時だけ」の条件だった）:
//     ① `startShooting` の見張りが `if (!e.isTrusted) return;` → **拡張の押下を撮らない**
//        ＝ 自動モード（拡張が押す）では**写真が1枚も撮れない**
//     ② `shootAfter` の関所が `if (!_shooting && !watching) return;` → 見張りが止まると写真も止まる
//        （写真は「画面の記録」なので、人の動きを見張っているかとは別の話）
//
//   直した事（このテストで固定する）:
//     ・写真は**人でも拡張でも撮る**（誰が押したかは関係ない）
//     ・`watching` に依存しない（止めるのは `axlxShotOff` だけ＝人が明示的に切った時）
//     ・人の手本との区別は `shot_ops` の `by`（human / auto）で残す
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const rec = read("human-learn-record.js");
const code = rec.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

console.log("■ ① 拡張の押下でも撮る（自動モードで写真が0枚だった原因）");
{
  ok("⚠ isTrusted で弾いていない（撮影）", !/if \(!e \|\| !e\.isTrusted\) return;/.test(code));
  ok("  人でも拡張でも撮る", /shootAfter\(e\.type, e\.target, null\);/.test(code));
  ok("  診断に trusted_/auto_ を残す（どちらか分かる）", /\(e\.isTrusted \? "trusted_" : "auto_"\)/.test(code));
  ok("  wheel も同じ", /e\.isTrusted \? "trusted_wheel" : "auto_wheel"/.test(code));
}

console.log("\n■ ② watching に依存しない（写真は画面の記録）");
{
  ok("⚠ not_shooting で弾いていない", !/if \(!_shooting && !watching\)/.test(code));
  ok("  止めるのは axlxShotOff だけ", /shouldShoot\(\{ axlxShotOff/.test(code) || /axlxShotOff/.test(code));
}

console.log("\n■ ③ 人の手本との区別は残す（by）");
{
  ok("_pushOp に by を渡している", /_pushOp\(e\.type \|\| "click", e\.target, _by\)/.test(code));
  ok("  by は human / auto", /var _by = \(e\.isTrusted === true\) \? "human" : "auto";/.test(code));
}

console.log("\n■ ④ 押した欄と順番は自動モードでも積む");
{
  ok("_pushPoint を呼ぶ", /_pushPoint\(e\.target, _by, e\)/.test(code));
  ok("  順番を持つ", /_orderLive\.push\(name\)/.test(code));
  ok("  field_order に渡す", /add\.order = _orderLive\.slice\(0, 40\)/.test(code));
}

console.log("\n■ ⑤ 構文");
{
  let okSyntax = true;
  try { new Function(rec); } catch (e) { okSyntax = false; }
  ok("human-learn-record.js の構文が通る", okSyntax);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
