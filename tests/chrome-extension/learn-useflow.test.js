// 「site_flow と weak を実際に使う」の試験（2026-11-13）
//
// 竹内さん「やる」→ site_flow / weak を現場で使えるようにする。
//
// 見つけた最大の穴:
//   ⚠ `learn-order.js` を **content.js がページに入れていなかった**（v2.7.12 で作ったのに繋ぎ忘れ）。
//     そのため page-script の `window.AxlxLearnOrder` は**常に undefined** で、
//     `_orderByLearned` は毎回そのまま返していた
//     ＝ **学んだ押す順番が一度も効いていなかった**。
//
// 実行: node tests/chrome-extension/learn-useflow.test.js
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const SRC = path.join(ROOT, "chrome-extension");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const LO = require(path.join(SRC, "learn-order.js"));

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

console.log("■ ① learn-order.js がページに入っている（最大の穴）");
{
  const c = read("content.js");
  t("content.js が learn-order.js を入れる", c.includes('chrome.runtime.getURL("learn-order.js")'));
  t("page-script.js より前に読む（順序）", c.indexOf("learn-order.js") < c.indexOf('getURL("page-script.js")'), {
    lo: c.indexOf("learn-order.js"), ps: c.indexOf('getURL("page-script.js")'),
  });
  const m = JSON.parse(read("manifest.json"));
  const res = (m.web_accessible_resources || []).flatMap((x) => x.resources || []);
  t("manifest の web_accessible にある（読める）", res.includes("learn-order.js"));
}

console.log("■ ② site_flow から「A は B より前」を作る");
{
  const sf = {
    realpro: [
      { from: "確定してリストへ｜span", to: "required_time", n: 14 },
      { from: "required_time", to: "rental_cost2", n: 13 },
      { from: "rental_cost2", to: "deposit_recommpence", n: 11 },
    ],
  };
  // 集合は _basicQueue の名前（モーダルの中の名前は入っていない）
  const names = ["rental_cost1", "rental_cost2", "square_meter_l"];
  const chain = LO.chainOrderWithin(names, sf);
  t("集合に無い名前は無視する", Object.keys(chain).every((k) => names.includes(k)), chain);
  t("何も作らない（この集合には鎖の外から入れない）", Object.keys(chain).length === 0, chain);

  // 集合に鎖の一部が入っている場合
  const names2 = ["required_time", "rental_cost2"];
  const chain2 = LO.chainOrderWithin(names2, sf);
  t("鎖の中で集合内の2つの前後を作る", chain2.required_time === "rental_cost2", chain2);
}

console.log("■ ③ next と site_flow を合わせる（next 優先）");
{
  const next = { rental_cost1: { next: "rental_cost2", n: 5, total: 5 } };
  const sf = {
    realpro: [
      { from: "required_time", to: "rental_cost2", n: 13 },
      { from: "rental_cost2", to: "square_meter_l", n: 10 },
    ],
  };
  const merged = LO.mergeLearnedOrder(next, sf, { names: ["rental_cost1", "rental_cost2", "square_meter_l"] });
  t("next の組を残す", merged.rental_cost1 && merged.rental_cost1.next === "rental_cost2", merged.rental_cost1);
  t("鎖から足りない組を補う", Object.keys(merged).length >= 2, Object.keys(merged));
  t("next を鎖で上書きしない", merged.rental_cost1.n === 5, merged.rental_cost1);
}

console.log("■ ④ 実際に並べ替えが効く（集合は変えない）");
{
  // 賃料→面積 の順で人が押している
  const next = {
    rental_cost1: { next: "rental_cost2", n: 6, total: 6 },
    rental_cost2: { next: "square_meter_l", n: 6, total: 6 },
  };
  const items = [{ name: "square_meter_l" }, { name: "rental_cost1" }, { name: "rental_cost2" }];
  const r = LO.orderByLearned(items, (x) => x && x.name, next, { min: 2, wobble: 0 });
  t("学んだ順になる", r.items.map((x) => x.name).join(">") === "rental_cost1>rental_cost2>square_meter_l", r.items.map((x) => x.name));
  t("項目は増減しない", r.items.length === 3);
  t("並べ替えた事を返す", r.changed === true);
}

console.log("■ ⑤ 画面にサーバーの学びを出す（weak / site_flow / next）");
{
  const L = read("human-learn.js");
  t("serverLearnLines がある", L.includes("function serverLearnLines"));
  t("押す順番を出す", /写真から学んだ「次に押す物」/.test(L));
  t("サイトごとの手順を出す", /サイトごとの手順/.test(L));
  t("次に学ぶ事を出す", /次に学ぶ事/.test(L));
  t("操作の間を出す", /操作と操作の間/.test(L));
  t("export している", L.includes("serverLearnLines: serverLearnLines"));

  const p = read("popup.js");
  t("popup が serverLearnLines を呼ぶ", p.includes("L.serverLearnLines"));
  t("storage からサーバーの学びを読む", p.includes("axlx_learn_weak") && p.includes("axlx_learn_site_flow"));
  t("行の入れ物を分けてある（後から足せる）", p.includes('id = "learn-report-lines"') || p.includes('"learn-report-lines"'));
}

console.log("■ ⑥ page-script が site_flow も読む");
{
  const ps = read("page-script.js");
  t("axlx_learn_site_flow を読む", ps.includes("axlx_learn_site_flow"));
  t("mergeLearnedOrder を使う", ps.includes("mergeLearnedOrder"));
  t("項目を増減させない（長さを確かめる）", /r\.items\.length === items\.length/.test(ps));
}

console.log("■ ⑦ 人の手順とのズレを点検に残す（動きは変えない）");
{
  // 実際の並び（賃料→面積）に対して、人の手順が「面積が先」と言っている場合
  const sf = {
    realpro: [
      { from: "square_meter_l", to: "rental_cost1", n: 5 },
    ],
  };
  const mis = LO.flowMismatches(["rental_cost1", "square_meter_l"], sf, { min: 2 });
  t("人の順では面積が先なのに後ろにある＝1件返る", mis.length === 1 && mis[0].earlier === "square_meter_l", mis);
  const ok2 = LO.flowMismatches(["square_meter_l", "rental_cost1"], sf, { min: 2 });
  t("人の順どおりなら何も返さない", ok2.length === 0, ok2);
  t("1回だけの組は採らない", LO.flowMismatches(["rental_cost1", "square_meter_l"], { realpro: [{ from: "square_meter_l", to: "rental_cost1", n: 1 }] }, { min: 2 }).length === 0);
  const ps = read("page-script.js");
  t("page-script が点検に残す", ps.includes("flow_order_gap"));
  t("並べ替えには使わない（項目を増減しない）", /r\.items\.length === items\.length/.test(ps));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
