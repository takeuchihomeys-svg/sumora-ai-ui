// app/lib/__tests__/auto-mode-improve.test.ts
//
// 2026-11-15 竹内さん「この自動モードの改善は録画している学習データから統括が改善する」
//
// なぜ要るか:
//   私は何度も「コードを読んで推測で直す」をやって失敗した（2回誤読・2回渡し忘れ）。
//   → 統括に録画データを見せて改善の順番を決めさせる。私は材料を揃える係に徹する。
//
// 実行: npx tsx app/lib/__tests__/auto-mode-improve.test.ts
import { compareFields, autoModeCandidates } from "../auto-mode-improve";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 人が押すのに自動モードが押していない欄を見つける");
{
  const human = [
    { f: "rental_cost2", n: 74, x: 0.07, y: 0.10 },
    { f: "room_layout_id[]", n: 88, x: 0.15, y: 0.54 },
    { f: "div.building_tr", n: 160, x: 0.66, y: 0.44 },
  ];
  const auto = [{ f: "rental_cost2", n: 12, x: 0.11, y: 0.19 }];
  const r = compareFields(human, auto, []);
  ok("人の欄の数を数える", r.gaps.humanFields === 3, r.gaps.humanFields);
  ok("自動の欄の数を数える", r.gaps.autoFields === 1, r.gaps.autoFields);
  ok("⚠ 人が押すのに自動が押していない欄を名指しする", r.gaps.onlyHuman.length === 2, r.gaps.onlyHuman);
  ok("room_layout_id[] が入る", r.gaps.onlyHuman.includes("room_layout_id[]"));
  ok("div.building_tr が入る", r.gaps.onlyHuman.includes("div.building_tr"));
  ok("両方が押している欄は入らない", !r.gaps.onlyHuman.includes("rental_cost2"));
  ok("1行で分かる", r.gaps.line.includes("人が押すのに自動が押していない"), r.gaps.line);
}

console.log("\n■ ② 位置のずれを測る（0.15以上は違う所）");
{
  const human = [{ f: "rental_cost2", n: 74, x: 0.07, y: 0.10 }];
  const auto = [{ f: "rental_cost2", n: 12, x: 0.11, y: 0.19 }];
  const r = compareFields(human, auto, []);
  // |0.07-0.11| + |0.10-0.19| = 0.04 + 0.09 = 0.13
  ok("ずれを計算する", r.gaps.avgDrift === 0.13, r.gaps.avgDrift);
  ok("0.15未満は「違う所」と言わない", (r.gaps.avgDrift ?? 0) < 0.15);

  const far = compareFields(human, [{ f: "rental_cost2", n: 12, x: 0.5, y: 0.5 }], []);
  ok("大きくずれたら 0.15 以上", (far.gaps.avgDrift ?? 0) >= 0.15, far.gaps.avgDrift);
}

console.log("\n■ ③ 学んだ位置を狙えたか（狙えなかった理由も）");
{
  const aimUsed = [
    { f: "rental_cost2", x: 0.07, y: 0.10, why: null },
    { f: "update_date", x: 0.1, y: 0.21, why: null },
    { f: "room_layout_id[]", x: null, y: null, why: "few_times:1" },
    { f: "div.building_tr", x: null, y: null, why: "no_learn" },
    { f: "span", x: null, y: null, why: "few_times:1" },
  ];
  const r = compareFields([], [], aimUsed);
  ok("狙えた回数", r.gaps.aimedOk === 2, r.gaps.aimedOk);
  ok("狙えなかった回数", r.gaps.aimedNg === 3, r.gaps.aimedNg);
  ok("理由の内訳（few_times が2）", r.gaps.aimWhyCount.few_times === 2, r.gaps.aimWhyCount);
  ok("理由の内訳（no_learn が1）", r.gaps.aimWhyCount.no_learn === 1);
}

console.log("\n■ ④ 統括に渡す改善の候補（費用つき・効果の大きい順）");
{
  const g = {
    humanFields: 26, autoFields: 0,
    onlyHuman: ["img", "span", "rental_cost2", "room_layout_id[]", "div.building_tr", "update_date"],
    aimedOk: 2, aimedNg: 3, aimWhyCount: { few_times: 2, no_learn: 1 },
    avgDrift: 0.20, line: "",
  };
  const c = autoModeCandidates(g, { shotTodo: 374, changedWithoutClick: 4, cursorPct: 35 });
  ok("候補が出る", c.length >= 4, c.length);
  ok("人が押す欄の欠けが先頭（効果が大きい）", c[0].key === "miss_fields", c[0].key);
  ok("費用が0円と分かる", c[0].cost.includes("0円"), c[0].cost);
  ok("写真の候補に費用の概算（374枚=約64円）", c.some((x) => x.key === "photo" && x.cost.includes("64円")), c.find((x) => x.key === "photo"));
  ok("押さずに値が変わる候補が出る", c.some((x) => x.key === "changed_no_click"));
  ok("カーソルの候補が出る（35%は半分未満）", c.some((x) => x.key === "cursor"));
  ok("どの候補にも「効く」が入る", c.every((x) => x.effect.length > 0));
}

console.log("\n■ ⑤ 良い状態なら候補を出さない");
{
  const good = { humanFields: 10, autoFields: 10, onlyHuman: [], aimedOk: 10, aimedNg: 0, aimWhyCount: {}, avgDrift: 0.05, line: "" };
  const c = autoModeCandidates(good, { shotTodo: 0, changedWithoutClick: 0, cursorPct: 100 });
  ok("候補は0", c.length === 0, c);
}

console.log("\n■ ⑥ 壊れた入力でも落ちない");
{
  ok("空でも落ちない", compareFields([], [], []).rows.length === 0);
  ok("null でも落ちない", compareFields(null as never, null as never, null as never).gaps.humanFields === 0);
  ok("null が混ざっても落ちない", compareFields([null as never, { f: "a", n: 2, x: 0.1, y: 0.1 }], [], []).gaps.humanFields === 1);
  ok("名前が無い物は飛ばす", compareFields([{ f: "", n: 2, x: 0.1, y: 0.1 }], [], []).gaps.humanFields === 0);
  ok("候補が空でも落ちない", autoModeCandidates(compareFields([], [], []).gaps).length === 0);
}

console.log("\n■ ⑦ なぜ必要かをコードに残している");
{
  const fs = require("fs") as typeof import("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "../auto-mode-improve.ts"), "utf8");
  ok("統括に決めさせると書いてある", /統括に.*決めさせる/.test(src));
  ok("推測で直して失敗したと書いてある", /推測で直す/.test(src));
  ok("費用の上限を付けると書いてある", /費用がかかる物は.*上限/.test(src));
  ok("0.15以上は違う所と書いてある", /0\.15/.test(src));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
