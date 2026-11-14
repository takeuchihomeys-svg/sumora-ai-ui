// tests/chrome-extension/learn-scene-flows-v2746.test.js
// 実行: node tests/chrome-extension/learn-scene-flows-v2746.test.js
// 2026-11-14 竹内さん「自動検索の部分これでちゃんと強化されたかな」
//
//   ⚠ **まだだった**。サーバーで場面ごとの手順（`scene_flows`・人が実際に押した順）を作ったのに、
//     拡張は**1箇所も読んでいなかった**（実測 0箇所）。
//     ＝「計算したが現場に届かない」を、前回（`screen_flow`）と**同じ穴でもう一度**作っていた。
//
//   直した事:
//     ① background: `bundle.scene_flows` / `stopped_scene` / `scene_missing` を storage に置く
//     ② page-script: それらを読み、`_orderByLearned` で**並べ替えの材料**にする
//        ⚠ 項目は増減しない（検索漏れを出さない）・2回以上見た手順だけ使う
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const bg = read("background.js");
const ps = read("page-script.js");
/** コメントを除いた実際のコード（説明文に同じ言葉が出るので誤判定しない） */
const strip = (s) => s.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
const bgc = strip(bg), psc = strip(ps);

console.log("■ ① background が場面ごとの手順を storage に置く");
{
  ok("axlx_learn_scene_flows を置く", /axlx_learn_scene_flows\s*:/.test(bgc));
  ok("  配列だけを置く（壊れた値を通さない）", /Array\.isArray\(bundle\.scene_flows\)/.test(bgc));
  ok("  上限を付ける（storage を太らせない）", /bundle\.scene_flows\.slice\(0,\s*12\)/.test(bgc));
  ok("axlx_learn_stopped_scene を置く", /axlx_learn_stopped_scene\s*:/.test(bgc));
  ok("axlx_learn_scene_missing を置く（推測しないための印）", /axlx_learn_scene_missing\s*:/.test(bgc));
}

console.log("\n■ ② page-script が読む（実測0箇所だった所）");
{
  ok("storage から axlx_learn_scene_flows を読む", /chrome\.storage\.local\.get\(\[[\s\S]{0,300}?axlx_learn_scene_flows/.test(psc));
  ok("  window.__axlxLearnSceneFlows に入れる", /__axlxLearnSceneFlows\s*=/.test(psc));
  ok("  window.__axlxLearnStoppedScene に入れる", /__axlxLearnStoppedScene\s*=/.test(psc));
  ok("  window.__axlxLearnSceneMissing に入れる", /__axlxLearnSceneMissing\s*=/.test(psc));
}

console.log("\n■ ③ 並べ替えに使う（項目は増減しない）");
{
  const iOrder = psc.indexOf("function _orderByLearned");
  const iUse = psc.indexOf("__axlxLearnSceneFlows", iOrder);
  ok("_orderByLearned の中で場面の手順を使う", iOrder > 0 && iUse > iOrder, { iOrder, iUse });
  ok("  mergeWithSequence で前後関係にする", /mergeWithSequence\(next,\s*_chain2/.test(psc));
  ok("  集合に居る名前だけ鎖にする（増減しない）", /names\.indexOf\(_nm\)\s*<\s*0/.test(psc));
  ok("  2回以上見た手順だけ（1回の偶然を採らない）", /Number\(_f\.runs\)\s*<\s*2/.test(psc));
  ok("  手順が2手未満は使わない", /_st\.length\s*<\s*2/.test(psc));
  ok("  最後に件数を確かめる（増減したら元に戻す）", /r\.items\.length === items\.length/.test(psc));
}

console.log("\n■ ④ 実際に並べ替わる（learn-order をそのまま使って確かめる）");
{
  const LO = require(path.join(dir, "learn-order.js"));
  // サーバーが作る形: {scene, runs, steps:[名前...]}
  const flows = [
    { scene: "area", runs: 17, steps: ["所在地絞り込み＋", "大阪市西区", "city_code[]", "大阪市中央区"] },
    { scene: "cond", runs: 18, steps: ["update_date", "rental_cost2", "include_common_fee"] },
    { scene: "search", runs: 18, steps: ["検索"] },
  ];
  const items = [
    { name: "rental_cost2" },
    { name: "city_code[]" },
    { name: "update_date" },
    { name: "大阪市西区" },
    { name: "include_common_fee" },
  ];
  const names = items.map((x) => x.name);
  let next = null;
  // page-script と同じ手順で鎖を作る
  flows.forEach((f) => {
    const chain = f.steps.filter((n) => names.indexOf(n) >= 0);
    if (chain.length >= 2) next = LO.mergeWithSequence(next, chain, names);
  });
  const r = LO.orderByLearned(items, (it) => it.name, next, { min: 2 });
  const order = r.items.map((x) => x.name);
  ok("並べ替えが起きた", !!r.changed, order);
  ok("  ⚠ 件数は変わらない（検索漏れを出さない）", r.items.length === items.length, order);
  ok("  同じ集合（増減なし）", order.slice().sort().join() === items.map((x) => x.name).slice().sort().join(), order);
  ok("  所在地の順（大阪市西区 → city_code[]）が守られる", order.indexOf("大阪市西区") < order.indexOf("city_code[]"), order);
  ok("  条件の順（update_date → rental_cost2）が守られる", order.indexOf("update_date") < order.indexOf("rental_cost2"), order);
}

console.log("\n■ ⑤ 手本が無い場面では何もしない（推測しない）");
{
  const LO = require(path.join(dir, "learn-order.js"));
  const items = [{ name: "a" }, { name: "b" }];
  const r = LO.orderByLearned(items, (it) => it.name, null, { min: 2 });
  ok("next が無ければ並べ替えない", !r.changed, r);
  ok("  件数も変わらない", r.items.length === 2);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
