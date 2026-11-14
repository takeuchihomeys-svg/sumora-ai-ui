// 実行: node tests/chrome-extension/learn-order-v2712.test.js
// 2026-11-13 竹内さん「つなぐ」「人間の動きにするのが絶対やで」
//
// 学んだ「押す順番」を自動モードの入力順に繋ぐ。ただし:
//   ① **項目は絶対に増減しない**（押し忘れ＝検索漏れを出さない）
//   ② **完全に固定しない**（毎回同じ順はロボット的。人が時々変える分の揺らぎを入れる）
//   ③ 学んだ順が無ければ今まで通り
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const LO = require(path.join(EXT, "learn-order.js"));
const ps = read("page-script.js");
const bg = read("background.js");
const mf = JSON.parse(read("manifest.json"));

// 実際の学んだ形（人: 賃料 → 間取り → 徒歩 の順で押す）
const NEXT = {
  "rental_cost2": { next: "square_meter_l", n: 5, total: 6 },
  "square_meter_l": { next: "required_time", n: 4, total: 5 },
};
const nameOf = (it) => it.name;
const I = (n) => ({ name: n });

console.log("■ ① 項目は絶対に増減しない（押し忘れを出さない）");
{
  const items = [I("required_time"), I("rental_cost2"), I("square_meter_l")];
  const r = LO.orderByLearned(items, nameOf, NEXT, { wobble: 0 });
  ok("数が同じ", r.items.length === 3, r.items.length);
  ok("同じ物がそろっている（増減なし）", ["required_time", "rental_cost2", "square_meter_l"].every((n) => r.items.some((x) => x.name === n)), r.items.map((x) => x.name));
  ok("元の配列を書き換えない", items.map((x) => x.name).join(",") === "required_time,rental_cost2,square_meter_l");
  // 学んだ相手が集合に無い時は何もしない
  const r2 = LO.orderByLearned([I("rental_cost2"), I("update_date")], nameOf, NEXT, { wobble: 0 });
  ok("学んだ相手が無ければ並べ替えない", r2.changed === false, r2.items.map((x) => x.name));
  ok("壊れた入力でも落ちない", LO.orderByLearned(null, nameOf, NEXT).items.length === 0 && LO.orderByLearned([I("a")], nameOf, null).items.length === 1);
}

console.log("\n■ ② 学んだ順に並ぶ（賃料 → 面積 → 徒歩）");
{
  const items = [I("required_time"), I("square_meter_l"), I("rental_cost2")];
  const r = LO.orderByLearned(items, nameOf, NEXT, { wobble: 0 });
  ok("賃料が先頭", r.items[0].name === "rental_cost2", r.items.map((x) => x.name));
  ok("徒歩が最後", r.items[2].name === "required_time", r.items.map((x) => x.name));
  ok("並びが変わったと分かる", r.changed === true);
  ok("使った組を残す（点検用）", r.used.length > 0, r.used);
}

console.log("\n■ ③ 人間の動き：完全に固定しない（揺らぎ）");
{
  // rand を固定して確かめる
  const items = [I("a"), I("b"), I("c"), I("d")];
  const always0 = () => 0;              // 揺らぎを必ず起こす
  const r1 = LO.orderByLearned(items, nameOf, {}, { wobble: 0.2, rand: always0 });
  ok("揺らぎの時は隣り合う2つが入れ替わる", r1.wobbled === true, r1.items.map((x) => x.name));
  ok("  入れ替えても数は同じ", r1.items.length === 4);
  ok("  大きく崩さない（元の並びから1組だけ）", (() => {
    let diff = 0;
    for (let i = 0; i < 4; i++) if (r1.items[i].name !== items[i].name) diff++;
    return diff === 2;  // 隣同士の入れ替え＝2か所だけ変わる
  })(), r1.items.map((x) => x.name));

  const always9 = () => 0.99;           // 揺らぎを起こさない
  const r2 = LO.orderByLearned(items, nameOf, {}, { wobble: 0.2, rand: always9 });
  ok("揺らぎが無い時は元の順のまま", r2.wobbled === false && r2.items.map((x) => x.name).join(",") === "a,b,c,d");

  // 100回中、揺らぎが「たまに」起きる（0%でも100%でもない）
  let wob = 0;
  for (let i = 0; i < 100; i++) if (LO.orderByLearned(items, nameOf, {}, { wobble: 0.2 }).wobbled) wob++;
  ok("  100回中おおよそ2割（3〜45回）", wob >= 3 && wob <= 45, wob);
}

console.log("\n■ ④ 学んだ順は壊さない（揺らぎは学んだ組の無い所だけ）");
{
  const items = [I("required_time"), I("square_meter_l"), I("rental_cost2")];
  const r = LO.orderByLearned(items, nameOf, NEXT, { wobble: 0.2, rand: () => 0 });
  ok("揺らぎがあっても賃料は面積より前", r.items.findIndex((x) => x.name === "rental_cost2") < r.items.findIndex((x) => x.name === "square_meter_l"), r.items.map((x) => x.name));
  ok("  揺らぎがあっても面積は徒歩より前", r.items.findIndex((x) => x.name === "square_meter_l") < r.items.findIndex((x) => x.name === "required_time"), r.items.map((x) => x.name));
}

console.log("\n■ ⑤ 繋がっている（自動モードの入力順）");
{
  ok("page-script が _orderByLearned を持つ", /function _orderByLearned\(list\)/.test(ps));
  ok("基本条件の並びを学んだ順にする", /_basicQueue = _orderByLearned\(_basicQueue\);/.test(ps));
  ok("  学んだ順が無ければ今まで通り（元の並び）", /if \(!next\) return items;/.test(ps) || /return \(r && Array\.isArray\(r\.items\)/.test(ps));
  ok("  学んだ順を storage から読む", /axlx_learn_next/.test(ps));
  /**
   * 2026-11-14 竹内さん「最新の学びが反映されるようになっているのか」:
   *   1時間ごと → **5分ごと**に短くした（学んだ直後から最大1時間反映されなかった）。
   *   ここは「短い間隔で版を確かめているか」を見る（固定値ではなく上限で判定）。
   */
  ok("background が短い間隔で版を確かめる（旧: 1日1回 → 1時間 → 5分）", /_refreshLearnedBundle/.test(bg) && (() => {
    const m = /_LEARN_CHECK_MS = (\d+)(?: \* (\d+))?(?: \* (\d+))? \* 1000/.exec(bg);
    if (!m) return false;
    const ms = Number(m[1]) * (m[2] ? Number(m[2]) : 1) * (m[3] ? Number(m[3]) : 1) * 1000;
    return ms <= 30 * 60 * 1000;   // 30分以内ならOK（今は5分）
  })());
  /**
   * 2026-11-14: サイト別に束を取るように変えた（`?scope=realpro` / `?scope=itandi`）ので、
   *   「取れなくても止まらない」の形が変わった（サイト別→だめなら全体へ落とす）。
   */
  ok("  取れなくても止まらない（あれば使う）", /error: "http_" \+ (allRes|sres)\.status/.test(bg));
  ok("learn-order.js を manifest に足した", mf.web_accessible_resources[0].resources.includes("learn-order.js"));
}

console.log("\n■ ⑥ 点検に残す（あとから「なぜこの順か」を見られる）");
{
  ok("学んだ順で並べ替えた事を残す", /learn_order/.test(ps));
  ok("揺らぎの有無も残す", /揺らぎ入り/.test(ps));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
