// tests/chrome-extension/relearn-v2778.test.js
// 実行: node tests/chrome-extension/relearn-v2778.test.js
// 2026-11-15 竹内さん「これで今あるので学ぶ直したら自動モードかなり改善されるのでは／ちゃんと学びなおせるように強化する」
//
//   ★ なぜ要るか
//     学び直す部品は**バラバラに存在していた**（束を作り直す・写真から読む・場面の手順・弱い所・統括）。
//     どれをどの順で回すかが決まっておらず、**回し忘れると「学んだつもり」で終わる**。
//   → **1コマンドで順番どおりに回し、各段の結果を出し、前後を比べる**土台を作った。
//
//   ★ 実測（2026-11-15・14日・通常モード1,357件）
//     写真がある 96% / 写真から読んだ 14% / 写真に操作 14% / 押した場所 22%
//     ⚠ **未読の写真600件が全部 480x244** だった。
//       480px の写真からは欄が**読めない**（以前の実測 `{"fields":[]}`）。
//       → 読めるのは **1000px 以上**（小窓が開いた瞬間）だけ。
//       ⚠ 480px ばかりの日に `--yes-cost` を回すと**費用だけかかって1つも学べない**。
//   → **先に大きさを数えて、無駄なら回さない**（`--yes-cost` でも止める）。
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..");
const src = fs.readFileSync(path.join(dir, "scripts", "relearn.ts"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

console.log("■ ① 学び直す順番が1つになっている（回し忘れを防ぐ）");
{
  ok("  ① 今の状態を測る", /学び直す前/.test(src));
  ok("  ② 束を作り直す（fresh=1）", /human-learn-profile\?scope=realpop&fresh=1|fresh=1/.test(src));
  ok("  ③ 場面の手順を作り直す（点検＋録画）", /場面の手順を作り直す/.test(src) && /learnSceneFlows/.test(src));
  ok("  ④ 弱い所を出す", /弱い所（費用0・記録から）/.test(src) && /findWeakScenes/.test(src));
  ok("  ⑤ 写真から読む", /写真から欄を読む/.test(src));
  ok("  ⑥ 統括に考えさせる", /統括に考えさせる/.test(src));
  ok("  ⑦ 前と後を比べる", /学び直した後/.test(src));
  ok("  ⑧ 束の中身を出す", /自動モードが使う束/.test(src));
}

console.log("\n■ ② 費用がかかる物は既定で回さない（明示した時だけ）");
{
  ok("  ⑤ は --yes-cost の時だけ", /if \(!yesCost\)/.test(src));
  ok("  ⑥ は --with-llm の時だけ", /if \(!withLlm\)/.test(src));
  ok("  ⚠ 上限は20枚まで", /Math\.min\(20,/.test(src));
  ok("  ⚠ 既定では回さないと画面に出す", /⏭ 回しません/.test(src));
}

console.log("\n■ ③ ⚠ 大きい写真が0枚なら費用をかけない（実測: 未読が全部480px）");
{
  ok("  ⚠ 先に大きさを数える", /大きい\(1000px\+\)/.test(src));
  ok("  ⚠ 0枚なら回さないと明言", /大きい写真が0枚/.test(src));
  ok("  ⚠ 480px では読めないと書いてある", /480px の写真からは欄が\*\*読めない\*\*/.test(src));
  ok("  ⚠ --yes-cost でも 0枚なら止める", /1000px以上の未読写真が0枚/.test(src));
  ok("  再読み込みで増えると案内", /拡張を再読み込みして検索/.test(src));
}

console.log("\n■ ④ 人の手本だけを使う（機械の動きを学ばない）");
{
  ok("  ⚠ by=human だけ通す", /o\.by === undefined \|\| o\.by === null \|\| o\.by === "human"/.test(src));
  ok("  診断の1件（diag）を除く", /o\.k !== "diag"/.test(src));
  ok("  ⚠ 同じ日・同じ並びは1回（水増ししない）", /slice\(0, 10\) \+ "\|"/.test(src));
}

console.log("\n■ ⑤ 学び直した結果を確かめる（数字で前後を比べる）");
{
  ok("  写真から読んだ数を比べる", /写真から読んだ/.test(src));
  ok("  写真に操作を比べる", /写真に操作/.test(src));
  ok("  押した場所を比べる", /押した場所/.test(src));
  ok("  割合（%）も出す", /写真から読んだ割合/.test(src));
  ok("  ⚠ 端末の数も出す（他のPCが参加しているか）", /記録している端末/.test(src));
  ok("  ⚠ 1台なら警告", /他のPCが参加していません/.test(src));
}

console.log("\n■ ⑥ 読むだけ（DBの構造を変えない）");
{
  ok("  ⚠ 表を作らない・列を足さない", !/CREATE TABLE|ALTER TABLE|ADD COLUMN/.test(src));
  ok("  束の作り直しだけサーバーが保存する（学びの本体）", /fresh=1/.test(src));
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
