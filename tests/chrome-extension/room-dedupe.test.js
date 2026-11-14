// 同じ建物・同じ間取り・同じ平米数なら最安1件だけ残す（2026-11-14）
//
// 竹内さん「同じ建物の場合平米数が同じなら一番低い家賃の物件1件だけにする。
//   同じマンションでも同じ間取りで大量に募集されている場合。
//   ここもともとは設定していたのに今すべてダウンロードしているので改善する」
//
// 実行: node tests/chrome-extension/room-dedupe.test.js
const D = require("../../chrome-extension/room-dedupe.js");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 読み取り（平米・間取り・家賃）");
{
  t("平米「29.28m²」", D.areaOf("29.28m²") === 29.28, D.areaOf("29.28m²"));
  t("平米「29.28㎡」", D.areaOf("29.28㎡") === 29.28);
  t("平米「３２．５㎡」（全角）", D.areaOf("３２．５㎡") === 32.5, D.areaOf("３２．５㎡"));
  t("平米「30.00 平米」", D.areaOf("30.00 平米") === 30);
  t("間取り「1LDK」", D.layoutOf("1LDK") === "1LDK");
  t("間取り「2DK」", D.layoutOf("2DK") === "2DK");
  t("間取り「ワンルーム」→ 1R", D.layoutOf("ワンルーム") === "1R");
  t("家賃「102,600円」", D.rentOf("賃料 102,600円") === 102600, D.rentOf("賃料 102,600円"));
  t("家賃「10.26万円」", D.rentOf("10.26万円") === 102600, D.rentOf("10.26万円"));
  t("家賃「10.3万円」", D.rentOf("10.3万円") === 103000);
  t("家賃が読めない → null", D.rentOf("要相談") === null);
}

console.log("\n■ ② 同じ建物・同じ間取り・同じ平米 → 最安1件だけ残す");
{
  // ArtizA瓦屋町 I の例（すべて 1LDK 29.28㎡・家賃が少しずつ違う）
  const items = [
    { name: "ArtizA瓦屋町 I", cells: ["0701", "1LDK", "29.28m²", "103,200円"] },
    { name: "ArtizA瓦屋町 I", cells: ["0501", "1LDK", "29.28m²", "102,600円"] },   // ← 最安
    { name: "ArtizA瓦屋町 I", cells: ["0704", "1LDK", "29.28m²", "102,800円"] },
    { name: "ArtizA瓦屋町 I", cells: ["0604", "1LDK", "29.28m²", "103,000円"] },
    { name: "ArtizA瓦屋町 I", cells: ["0201", "1LDK", "29.28m²", "102,900円"] },
  ];
  const r = D.cheapestPerBuildingLayoutSize(items);
  t("残るのは1件だけ", r.keep.length === 1, r.keep);
  t("  残ったのは最安（102,600円・添字1）", r.keep[0] === 1, r.keep);
  t("  落としたのは4件", r.drop.length === 4, r.drop);
  t("  グループが1つ", r.groups.length === 1);
  t("  家賃が読める（5件）", r.groups[0].rents.length === 5, r.groups[0].rents);
}

console.log("\n■ ③ 間取りが違う／平米が違う → 別の部屋として残す");
{
  const items = [
    { name: "同じ建物", cells: ["101", "1LDK", "29.28m²", "100,000円"] },
    { name: "同じ建物", cells: ["102", "1LDK", "32.50m²", "110,000円"] },  // 平米が違う → 残す
    { name: "同じ建物", cells: ["103", "2DK",  "29.28m²", "105,000円"] },  // 間取りが違う → 残す
    { name: "別の建物", cells: ["201", "1LDK", "29.28m²", "120,000円"] },  // 建物が違う → 残す
  ];
  const r = D.cheapestPerBuildingLayoutSize(items);
  t("4件すべて残る", r.keep.length === 4, r.keep);
}

console.log("\n■ ④ 迷ったら残す（読めない項目がある時）");
{
  const items = [
    { name: "A", cells: ["101", "1LDK", "29.28m²", "100,000円"] },
    { name: "A", cells: ["102", "1LDK", "", "90,000円"] },        // 平米が読めない → 残す
    { name: "A", cells: ["103", "",     "29.28m²", "95,000円"] }, // 間取りが読めない → 残す
    { name: "",  cells: ["104", "1LDK", "29.28m²", "80,000円"] }, // 建物名が読めない → 残す
  ];
  const r = D.cheapestPerBuildingLayoutSize(items);
  t("読めない物は落とさない（4件すべて残る）", r.keep.length === 4, r.keep);
}

console.log("\n■ ⑤ 家賃が読めない部屋は落とさない");
{
  const items = [
    { name: "A", cells: ["101", "1LDK", "29.28m²", "100,000円"] },  // 最安 → 残る
    { name: "A", cells: ["102", "1LDK", "29.28m²", "120,000円"] },  // 落ちる
    { name: "A", cells: ["103", "1LDK", "29.28m²", "応相談"] },      // 家賃不明 → 残す
  ];
  const r = D.cheapestPerBuildingLayoutSize(items);
  t("最安1件＋家賃不明1件＝2件残る", r.keep.length === 2, r.keep);
  t("  最安（添字0）が残る", r.keep.indexOf(0) >= 0);
  t("  家賃不明（添字2）も残る", r.keep.indexOf(2) >= 0);
}

console.log("\n■ ⑥ 元の順番を変えない");
{
  const items = [
    { name: "A", cells: ["101", "1LDK", "29.28m²", "120,000円"] },
    { name: "B", cells: ["201", "1LDK", "30.00m²", "110,000円"] },
    { name: "A", cells: ["102", "1LDK", "29.28m²", "100,000円"] },  // A の最安
    { name: "C", cells: ["301", "2LDK", "50.00m²", "150,000円"] },
  ];
  const r = D.cheapestPerBuildingLayoutSize(items);
  t("残るのは3件（A最安・B・C）", r.keep.length === 3, r.keep);
  t("  添字の順番どおり（1,2,3）", JSON.stringify(r.keep) === JSON.stringify([1, 2, 3]), r.keep);
  t("  A の落ちたのは添字0", r.drop.indexOf(0) >= 0, r.drop);
}

console.log("\n■ ⑦ 壊れない");
{
  t("空配列", D.cheapestPerBuildingLayoutSize([]).keep.length === 0);
  t("null", D.cheapestPerBuildingLayoutSize(null).keep.length === 0);
  t("1件だけ", D.cheapestPerBuildingLayoutSize([{ name: "A", cells: ["1", "1LDK", "30㎡", "10万円"] }]).keep.length === 1);
  t("同じ行が1つだけなら落とさない", (() => {
    const r = D.cheapestPerBuildingLayoutSize([{ name: "A", cells: ["101", "1LDK", "29.28m²", "100,000円"] }]);
    return r.keep.length === 1 && r.drop.length === 0;
  })());
  t("keep と drop が重ならない", (() => {
    const items = [
      { name: "A", cells: ["101", "1LDK", "29.28m²", "100,000円"] },
      { name: "A", cells: ["102", "1LDK", "29.28m²", "90,000円"] },
      { name: "A", cells: ["103", "1LDK", "29.28m²", "95,000円"] },
    ];
    const r = D.cheapestPerBuildingLayoutSize(items);
    return r.keep.every((k) => r.drop.indexOf(k) < 0);
  })());
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
