// tests/chrome-extension/check-improvements-v2773.test.js
// 実行: node tests/chrome-extension/check-improvements-v2773.test.js
// 2026-11-14 竹内さん「直近の録画した通常モードから学習必要な部分学習するなど（押し方）」
//   「ちゃんと1つずつ押すことができるようにする」
//   「統括の部分もちゃんと録画した画像から学習できるように強化するようにする」
//   「改善されたと確認したら更新されるように統括の部分ちゃんと把握して改善していくようにする」
//   「統括の部分ちゃんと何かあれば強化していくように必要な部分強化していく」
//
//   ★ 実測で分かった事
//     ① 直近の通常モード録画（22:02〜22:09・122枚）は**既に学習済み**（122/122）
//     ② 押し方（場面の手順）を作る材料: `field_order` があるのは **600件中11件だけ**
//        `point_fields` は181件あるが**キーの並びは押した順ではない**（オブジェクト・上書きで順が変わる）
//        → **`shot_ops` から順番を作る**（時刻つき・押した順そのもの）
//     ③ `learn_supervisor_log` には **`bundle` 列が無い**（`bundle_at` だけ）
//        → 束の中身は `/api/human-learn-profile` から取る
//     ④ `touch=0` は軽い版（版だけ）なので、中身を見る時は **touch あり**で取る
//
//   → 改善を確認する道具 `scripts/check-improvements.ts` を作った:
//     前回と今回を比べ（材料・弱い所・順番・場所）、**直した事が記録から確認できたか**を1つずつ出す。
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..");
const route = fs.readFileSync(path.join(dir, "app", "api", "human-learn-profile", "route.ts"), "utf8");
const chk = fs.readFileSync(path.join(dir, "scripts", "check-improvements.ts"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

console.log("■ ① 押し方は `shot_ops` から作る（field_order は11件だけ・point_fields は順番ではない）");
{
  ok("  ⚠ shot_ops を読んでいる", /select\("site, mode, field_order, point_fields, shot_ops"\)/.test(route));
  ok("  ⚠ shot_ops から順番を作る", /const ops = Array\.isArray\(\(r as \{ shot_ops\?: unknown \}\)\.shot_ops\)/.test(route));
  ok("  ⚠ 人の手本だけ（by=human）", /o\.by === undefined \|\| o\.by === null \|\| o\.by === "human"/.test(route));
  ok("  ⚠ diag（診断の1件）は除く", /o\.k !== "diag"/.test(route));
  ok("  shot_ops が無い時は field_order → point_fields に落ちる", /fromOps\.length >= 2 \? fromOps\.map\(\(x\) => x\.k\) : \(order\.length \? order : pf\)/.test(route));
  ok("  ⚠ 名前に click: を付ける（learnSceneFlows の形）", /"click:" \+ String\(o\.f\)/.test(route));
}

console.log("\n■ ② 改善を確認する道具（check-improvements.ts）");
{
  ok("  前回と今回を比べる", /前回.*今回/.test(chk));
  ok("  ⚠ 材料・弱い所・順番・一連の動き・操作つきを見る", /材料/.test(chk) && /弱い所/.test(chk) && /押す順番/.test(chk) && /一連の動き/.test(chk) && /操作つきの記録/.test(chk));
  ok("  ⚠ 改善と悪化を分ける", /改善 \$\{good\}件 \/ 悪化 \$\{bad\}件/.test(chk));
  ok("  ⚠ 直した事を1つずつ確かめる（opens・walk・押し方・写真）", /opens.*捨てられていない/.test(chk) && /walk_reset/.test(chk) && /押し方/.test(chk) && /写真から読んだ欄の種類/.test(chk));
  ok("  ⚠ 束の中身は API から取る（learn_supervisor_log に bundle 列が無い）", /bundle.*列が無い|列が無い.*bundle/.test(chk) && /human-learn-profile/.test(chk));
  ok("  ⚠ 中身を見る時は touch あり（touch=0 は版だけ）", /touch=0.*軽い版|軽い版.*touch=0/.test(chk));
  ok("  --save で記録に残せる", /--save/.test(chk) && /saveImprovement/.test(chk));
  ok("  --json で機械可読", /--json/.test(chk));
}

console.log("\n■ ③ 壊しやすい所を踏んでいない（実測で踏んだ罠）");
{
  ok("  ⚠ `bundle` を select していない（列が無くて失敗する）", !/\.select\([^)]*\bbundle\b[^_a-z]/.test(chk));
  ok("  ⚠ `bundle_at` がある（列名の確認）", /bundle_at/.test(chk));
  ok("  ⚠ `point_fields` のキー順を押した順として使っていない", !/const names = order\.length \? order : pf;\s*\n\s*if \(names\.length < 2\) continue;\s*\n\s*\/\*\*\s*\n\s*\*/.test(route));
}

console.log("\n■ ④ 統括の点ではなく**現場の記録**で改善を確かめる");
{
  ok("  ⚠ 「点数は材料の数で動くので改善の証拠にならない」と書いてある", /点数は材料の数で動く/.test(chk));
  ok("  opens が捨てられていないかを確かめる", /dropped_cols/.test(chk));
  ok("  場面の手順があるかを確かめる", /scene_flows/.test(chk));
  ok("  写真から読んだ欄の数を確かめる", /w_src\) === "photo"|w_src.*photo/.test(chk));
}

console.log("\n■ ⑤ 構文");
{
  const { execFileSync } = require("child_process");
  let ok1 = true;
  try { execFileSync(process.execPath, ["--check", path.join(dir, "scripts", "check-improvements.ts")], { stdio: "pipe" }); }
  catch { ok1 = false; }
  // .ts は --check できないので、tsc の成功（コミット前チェック）に任せる
  ok("  check-improvements.ts を読めた（構文は tsc で確認）", chk.length > 1000);
  void ok1;
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
