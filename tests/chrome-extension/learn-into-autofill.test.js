// 「自動検索にちゃんと反映されるか・抜けはないか」の試験（2026-11-13）
//
// 竹内さん「自動検索にちゃんと反映されるようになっているのか学習の部分。抜けている部分ないのか」
//
// 実測で分かった事:
//   学習12通りのうち、自動検索で使えていたのは **3通りだけ**だった。
//   残り9通りは「並べ替えの対象の集合に入っていない」から。
//   原因: 賃料・面積・共益費の5つだけをまとめて並べ替え、
//         **徒歩・築年・間取りはその下で個別に呼んでいた**（並べ替えの外）。
//
//   さらに `orderByLearned` に**バグ**があった:
//     `names[list.indexOf(it)]` で名前を引いていたので、並べ替えた後に**元の位置の名前**を返し、
//     動かした物の名前が化けて鎖が解けなかった。
//
// 実行: node tests/chrome-extension/learn-into-autofill.test.js
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

console.log("■ ① 徒歩・築年・間取りも同じ並びに入れて並べ替える");
{
  const ps = read("page-script.js");
  t("徒歩（transportation_id）を並びに積む", /_basicQueue\.push\(\{ name: "transportation_id"/.test(ps));
  t("徒歩の分数（required_time）を並びに積む", /name: "required_time"/.test(ps));
  t("築年（structured_date）を並びに積む", /_basicQueue\.push\(\{ name: "structured_date"/.test(ps));
  t("間取り（room_layout_id[]）を並びに積む", /name: "room_layout_id\[\]"/.test(ps));
  t("並べ替えは最後に1回だけ", (ps.match(/_basicQueue = _orderByLearned\(_basicQueue\);/) || []).length === 1);
  t("間取りを個別に setCheckboxes で先に押していない", !/if \(vals\.length\) \{\s*\n\s*setCheckboxes\("room_layout_id\[\]", vals\);\s*\n\s*\}/.test(ps));
  t("間取りの一息（人間らしさ）を落としていない", /enqueueHumanAction\(function \(\) \{\}, _b1, _b1 \+ 200, "息"\)/.test(ps));
}

console.log("■ ② 名前の引き方のバグを直した（鎖が解ける）");
{
  const lo = read("learn-order.js");
  t("元の配列の位置で名前を引かない（本体）", !/var ia = out\.findIndex\(function \(it\) \{ return names\[list\.indexOf\(it\)\]/.test(lo));
  t("元の配列の位置で名前を引かない（揺らぎ）", !/var na = names\[list\.indexOf\(out\[w\]\)\]/.test(lo));
  t("名前を各要素に付けて持ち回る", /var NAMED = out\.map/.test(lo));
  t("十分な回数くり返す（鎖を解く）", /pass < 20/.test(lo));
}

console.log("■ ③ 鎖が実際に解ける（A→B→C が逆順で入っていても直る）");
{
  // 元の並びが完全に逆（C, B, A）。学んだ順は A→B→C
  const items = [{ name: "C" }, { name: "B" }, { name: "A" }];
  const next = { A: { next: "B", n: 5, total: 5 }, B: { next: "C", n: 5, total: 5 } };
  const r = LO.orderByLearned(items, (x) => x.name, next, { min: 2, wobble: 0 });
  t("A > B > C になる", r.items.map((x) => x.name).join(">") === "A>B>C", r.items.map((x) => x.name));
  t("項目は増減しない", r.items.length === 3);
}

console.log("■ ④ 4段の鎖でも解ける（実測の形）");
{
  // 実測: square_meter_l → rental_cost1 → structured_date、required_time → rental_cost2
  const Q = ["rental_cost1", "rental_cost2", "square_meter_l", "required_time", "structured_date", "room_layout_id[]"];
  const items = Q.map((n) => ({ name: n }));
  const next = {
    required_time: { next: "rental_cost2", n: 13, total: 13 },
    square_meter_l: { next: "rental_cost1", n: 8, total: 12 },
    rental_cost1: { next: "structured_date", n: 6, total: 6 },
  };
  const r = LO.orderByLearned(items, (x) => x.name, next, { min: 2, wobble: 0 });
  const pos = {};
  r.items.forEach((x, i) => { pos[x.name] = i; });
  t("required_time は rental_cost2 より前", pos.required_time < pos.rental_cost2, pos);
  t("square_meter_l は rental_cost1 より前", pos.square_meter_l < pos.rental_cost1, pos);
  t("rental_cost1 は structured_date より前", pos.rental_cost1 < pos.structured_date, pos);
  t("項目は増減しない", r.items.length === Q.length);
}

console.log("■ ⑤ 集合の外の名前が混ざっても落ちない");
{
  const items = [{ name: "A" }, { name: "B" }];
  const next = {
    A: { next: "小窓の中の何か", n: 9, total: 9 },
    外: { next: "B", n: 9, total: 9 },
    A2: { next: "B", n: 3, total: 3 },
  };
  const r = LO.orderByLearned(items, (x) => x.name, next, { min: 2, wobble: 0 });
  t("関係ない組は無視して元の順", r.items.map((x) => x.name).join(">") === "A>B", r.items.map((x) => x.name));
}

console.log("■ ⑥ 並べ替えで項目が消えない・増えない（検索漏れを出さない）");
{
  for (let i = 0; i < 20; i++) {
    const names = ["rental_cost1", "rental_cost2", "square_meter_l", "required_time", "structured_date", "room_layout_id[]"];
    const items = names.map((n) => ({ name: n }));
    const next = { required_time: { next: "rental_cost2", n: 3, total: 3 }, square_meter_l: { next: "rental_cost1", n: 3, total: 3 } };
    const r = LO.orderByLearned(items, (x) => x.name, next, { min: 2, wobble: 0.2 });
    const a = items.map((x) => x.name).sort().join(",");
    const b = r.items.map((x) => x.name).sort().join(",");
    if (a !== b || r.items.length !== items.length) { t("20回とも集合が同じ", false, { a, b }); break; }
    if (i === 19) t("20回とも集合が同じ（揺らぎを入れても）", true);
  }
}

console.log("■ ⑦ 揺らぎを入れても学んだ組が壊れない（200回）");
{
  const Q = ["rental_cost1", "rental_cost2", "square_meter_l", "required_time", "structured_date", "room_layout_id[]", "square_meter_h", "include_common_fee"];
  const next = {
    required_time: { next: "rental_cost2", n: 13, total: 13 },
    square_meter_l: { next: "rental_cost1", n: 8, total: 12 },
    rental_cost1: { next: "structured_date", n: 6, total: 6 },
  };
  let broken = 0;
  for (let i = 0; i < 200; i++) {
    const items = Q.map((n) => ({ name: n }));
    const r = LO.orderByLearned(items, (x) => x.name, next, { min: 2, wobble: 0.2 });
    const pos = {};
    r.items.forEach((x, k) => { pos[x.name] = k; });
    if (pos.required_time > pos.rental_cost2) broken++;
    if (pos.square_meter_l > pos.rental_cost1) broken++;
    if (pos.rental_cost1 > pos.structured_date) broken++;
    if (r.items.length !== Q.length) broken += 100;
  }
  t("200回とも学んだ組が守られる・項目も減らない", broken === 0, broken);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
