// tests/chrome-extension/cheapest-per-sqm-v2748.test.js
// 実行: node tests/chrome-extension/cheapest-per-sqm-v2748.test.js
// 2026-11-14 竹内さん「物件同じ平米数のもダウンロードまだしてしまっている
//   平米数がおなじなら家賃は一番おさえれるのにする」
//
//   ⚠ 絞り込みの関数（room-dedupe.js）は正しかったのに、**呼び方が間違っていた**ため
//     1件も絞られていなかった（＝毎回すべてダウンロード）。
//
//   真の原因:
//     `_applyCheapestPerLayout` が `tracked` を **`t.cb.checked` で絞って**いた。
//     だが `_selectAllowed` の時点では**1件もチェックされていない**
//     （この後の `_doSend` が1件ずつチェックする形＝先に全行チェックしない）。
//     → items が常に空 → `items.length < 2` で**必ず何も絞らずに抜けていた**。
//
//   直し:
//     ① 渡された**候補（cand＝これから送る行）**を対象にする（チェックの状態を見ない）
//     ② 絞った行は `__axCheapestSkip` の印で外す（チェック状態に頼らない）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const bulk = read("bulk-dl.js");
/** コメントを除いた実際のコード */
const code = bulk.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
const RD = require(path.join(dir, "room-dedupe.js"));

console.log("■ ① 呼び方が直っている（チェック状態で絞らない）");
{
  const iFn = code.indexOf("function _applyCheapestPerLayout");
  const seg = code.slice(iFn, iFn + 1400);
  ok("候補（cand）を引数で受ける", /function _applyCheapestPerLayout\(state,\s*cand\)/.test(code));
  ok("  ⚠ チェック状態で絞っていない（これが原因だった）", !/t\.cb\.checked\)\s*return/.test(seg), seg.slice(0, 200));
  ok("  渡された候補を使う", /Array\.isArray\(cand\)\s*\?\s*cand\s*:\s*tracked/.test(seg));
  ok("  送付済み・古い行は対象外", /if \(t\.__axSkip\) return/.test(seg));
  ok("  呼ぶ側が cand を渡す", /_applyCheapestPerLayout\(state,\s*cand\)/.test(code));
  ok("  外すのは印で判定（チェックに頼らない）", /__axCheapestSkip/.test(code));
}

console.log("\n■ ② 同じ建物・同じ間取り・同じ平米なら最安1件だけ残る（実データの形）");
{
  /**
   * 2026-11-14 竹内さんの画面の実物に近い形:
   *   「シーズンフラッツ梅田NORTH」の同じ 1LDK 29.28㎡ が3部屋（102,600円 / 102,300円 / 105,000円）
   *   ⚠ 号室が違うだけ（0701 / 0702 / 0801）
   */
  const cards = [
    { name: "シーズンフラッツ梅田NORTH", cells: ["0701", "1LDK", "29.28m²", "102,600円"] },
    { name: "シーズンフラッツ梅田NORTH", cells: ["0702", "1LDK", "29.28m²", "102,300円"] },
    { name: "シーズンフラッツ梅田NORTH", cells: ["0801", "1LDK", "29.28m²", "105,000円"] },
  ];
  const res = RD.cheapestPerBuildingLayoutSize(cards);
  ok("2件を外す", res.drop.length === 2, res.drop);
  ok("  残すのは1件", res.keep.length === 1, res.keep);
  ok("  ⚠ 一番安い 102,300円 の部屋（2番目）", res.keep[0] === 1, res.keep);
  ok("  ⚠ 一番高い 105,000円 は外す", res.drop.indexOf(2) >= 0, res.drop);
}

console.log("\n■ ③ 平米数が違えば別の部屋として残す（絞りすぎない）");
{
  const cards = [
    { name: "シーズンフラッツ梅田NORTH", cells: ["0701", "1LDK", "29.28m²", "102,600円"] },
    { name: "シーズンフラッツ梅田NORTH", cells: ["0802", "1LDK", "31.50m²", "115,000円"] },
  ];
  const res = RD.cheapestPerBuildingLayoutSize(cards);
  ok("2件とも残す（平米が違う）", res.keep.length === 2 && res.drop.length === 0, res);
}

console.log("\n■ ④ 建物が違えば別（同じ平米でも絞らない）");
{
  const cards = [
    { name: "シーズンフラッツ梅田NORTH", cells: ["0701", "1LDK", "29.28m²", "102,600円"] },
    { name: "シーズンフラッツ大手前", cells: ["0701", "1LDK", "29.28m²", "99,000円"] },
  ];
  const res = RD.cheapestPerBuildingLayoutSize(cards);
  ok("2件とも残す（建物が違う）", res.keep.length === 2 && res.drop.length === 0, res);
}

console.log("\n■ ⑤ 間取りが違えば別（同じ平米でも絞らない）");
{
  const cards = [
    { name: "シーズンフラッツ梅田NORTH", cells: ["0701", "1LDK", "29.28m²", "102,600円"] },
    { name: "シーズンフラッツ梅田NORTH", cells: ["0702", "1DK", "29.28m²", "95,000円"] },
  ];
  const res = RD.cheapestPerBuildingLayoutSize(cards);
  ok("2件とも残す（間取りが違う）", res.keep.length === 2 && res.drop.length === 0, res);
}

console.log("\n■ ⑥ 読めない物は絞らない（資料を落とさない）");
{
  const cards = [
    { name: "シーズンフラッツ梅田NORTH", cells: ["0701", "1LDK", "29.28m²", "102,600円"] },
    { name: "", cells: ["0702", "1LDK", "29.28m²", "102,300円"] },          // 建物名が読めない
    { name: "シーズンフラッツ梅田NORTH", cells: ["0703", "1LDK", "", "101,000円"] }, // 平米が読めない
  ];
  const res = RD.cheapestPerBuildingLayoutSize(cards);
  ok("読めない2件は残す", res.keep.indexOf(1) >= 0 && res.keep.indexOf(2) >= 0, res.keep);
  ok("  読めた物は1件だけ残る", res.keep.indexOf(0) >= 0 && res.drop.indexOf(0) < 0, res);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
