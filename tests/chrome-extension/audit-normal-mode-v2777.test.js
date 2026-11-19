// tests/chrome-extension/audit-normal-mode-v2777.test.js
// 実行: node tests/chrome-extension/audit-normal-mode-v2777.test.js
// 2026-11-15 竹内さん「今弱い部分通常モードの録画の部分から分析して解決できないのか／そこの部分細分まで強化する／土台もひつようならつくる」
//
//   ★ 実測で分かった事（既存の道具の穴）
//     既存の `audit-scene-flows.ts` は **`search_audits`（点検）だけ**を見ていた。
//     通常モードの録画（`human_motion_learn`）には**押した順番が残っている**のに、録画側を分析していなかった。
//     実測: 通常モード単独 51回・検索5回だけ（薄い）／点検は `filled.ops` が 0件（材料なし）。
//     → **2つを別々に見て、足りない所を補い合う**土台を作った（`scripts/audit-normal-mode.ts`）。
//
//   ★ 7つの観点で細かく見る
//     ① 場面ごとの手順（点検／録画／合わせた）
//     ② 手数と通りの数（迷い）
//     ③ 操作の間（待ち・止まり）
//     ④ 押した欄の種類（記録と写真の両方）
//     ⑤ 同じ欄を2回押している（選び直し）
//     ⑥ 手本が無い場面
//     ⑦ 記録の抜け（写真はあるのに操作が付かない・カーソルが動かない・写真学習が走らない）
//
//   ★ 実測の結果（2026-11-15・14日）
//     写真がある        96%
//     操作(ops)がある    4%  ← 一番の穴
//     写真に操作が付く  14%
//     カーソルの動き    24%
//     写真から種類を読む 14%
//     → 解決の道: ①操作の記録の経路 ②mousemove（v2.7.74） ③写真学習 ④次のページの手本
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..");
const src = fs.readFileSync(path.join(dir, "scripts", "audit-normal-mode.ts"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

console.log("■ ① 点検と録画を**別々に**集めて比べる（片方だけ見ない）");
{
  ok("  search_audits を読む（点検）", /from\("search_audits"\)/.test(src));
  ok("  human_motion_learn を読む（録画）", /from\("human_motion_learn"\)/.test(src));
  ok("  ⚠ 録画は normal モードだけ", /\.eq\("mode", "normal"\)/.test(src));
  ok("  点検と録画を**別々に**手順にする", /flowsAudit/.test(src) && /flowsMotion/.test(src));
  ok("  合わせた手順も作る", /flowsAll/.test(src));
  ok("  ⚠ 3つを並べて出す（どこが薄いか分かる）", /点検:.*録画:/s.test(src) || /点検\/録画\/合わせた|点検: \$\{|録画: \$\{/.test(src));
}

console.log("\n■ ② 水増ししない（同じ日・同じ並びは1回）");
{
  ok("  重複を畳むキーを作っている", /const key = String\(r\.created_at\)\.slice\(0, 10\)/.test(src));
  ok("  長い方を残す", /if \(!cur \|\| list\.length > cur\.length\)/.test(src));
  ok("  同じ欄の click→change も畳む（collapseSameField）", /collapseSameField/.test(src));
}

console.log("\n■ ③ 人の手本だけを使う（機械の動きを学ばない）");
{
  ok("  ⚠ by=human だけ通す", /o\.by === undefined \|\| o\.by === null \|\| o\.by === "human"/.test(src));
  ok("  診断の1件（diag）を除く", /o\.k !== "diag"/.test(src));
}

console.log("\n■ ④ 7つの観点が揃っている");
{
  ok("  ① 場面ごとの手順", /describeSceneFlow|場面ごとの手順/.test(src));
  ok("  ② 手数・通り数", /手数|variants|通り/.test(src));
  ok("  ③ 操作の間", /操作の間|中央値/.test(src));
  ok("  ④ 押した欄の種類（記録と写真）", /押した欄の種類/.test(src));
  ok("  ⑤ 同じ欄を2回押している", /同じ欄を2回以上押している/.test(src));
  ok("  ⑥ 手本が無い場面", /手本が無い場面/.test(src));
  ok("  ⑦ 記録の抜け", /記録の抜け/.test(src));
}

console.log("\n■ ⑤ 解決の道を出す（原因→どうするか）");
{
  ok("  「解決の道」を出す", /解決の道/.test(src));
  ok("  ⚠ 操作の記録の経路を疑う", /操作の記録の経路/.test(src));
  ok("  ⚠ mousemove（v2.7.74）を名指し", /mousemove/.test(src));
  ok("  ⚠ 写真学習が走っていないを検出", /写真学習が走っていない/.test(src));
  ok("  次のページの手本が無いを検出", /手本が無い場面/.test(src));
}

console.log("\n■ ⑥ 自動モードに渡す形（教える手順）を出す");
{
  ok("  scenePlaybook を使う", /scenePlaybook/.test(src));
  ok("  自動モードに渡す手順を出す", /自動モードに渡す手順/.test(src));
}

console.log("\n■ ⑦ 読むだけ（--save の時だけ記録）");
{
  ok("  ⚠ 既定では書かない", /if \(doSave\)/.test(src));
  ok("  --save でだけ記録する", /--save/.test(src));
  ok("  記録は learn_improvements へ", /saveImprovement/.test(src));
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
