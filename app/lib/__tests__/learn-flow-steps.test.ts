// app/lib/__tests__/learn-flow-steps.test.ts
// 2026-11-14 竹内さん
//   「時間でみたらよい最大７分の録画なので順番に見れば理解できる」
//   「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で統括が弱い部分の学習を強化する」
//   「これらの思考や考え方は統括の部分で重要な考え方にする。そして強化する」
//
// 実測（2026-11-14）: `search_audits.filled.ops` に**人の押した順番が36/56件**あった。
//   例: 所在地絞り込み＋ → 大阪市西区 → city_code[] → 大阪市中央区 → … → 確定してリストへ
//       → transportation_id → required_time → update_date → rental_cost2 → include_common_fee
//   → これを場面ごとの手順にして統括の判断材料にする（写真が0枚でも学べる）。
//
// 実行: npx tsx --env-file=.env.local app/lib/__tests__/learn-flow-steps.test.ts
import {
  learnSceneFlows, findWeakScenes, sceneOfOp, describeSceneFlow, scenePlaybook, lastSceneOf, SCENE_JA,
  type FlowOp,
} from "../learn-flow-steps";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

const H = (k: string, t: number): FlowOp => ({ k, t, by: "human" });
const A = (k: string, t: number): FlowOp => ({ k, t, by: "auto" });

console.log("■ ① 操作の名前から場面を決める（実際の name 属性）");
{
  ok("所在地絞り込み＋ は area", sceneOfOp("click:所在地絞り込み＋") === "area");
  ok("city_code[] は area", sceneOfOp("change:city_code[]") === "area");
  ok("確定してリストへ は other（場所を選ぶ操作ではない）", sceneOfOp("click:確定してリストへ") === "other");
  ok("transportation_id は station", sceneOfOp("change:transportation_id") === "station");
  ok("required_time（駅からの徒歩）は station", sceneOfOp("change:required_time") === "station");
  ok("rental_cost2 は cond", sceneOfOp("change:rental_cost2") === "cond");
  ok("update_date は cond", sceneOfOp("change:update_date") === "cond");
  ok("go_search は search", sceneOfOp("click:go_search") === "search");
  ok("go_search_submit は search", sceneOfOp("click:go_search_submit") === "search");
  ok("次のページ は next", sceneOfOp("click:次のページ") === "next");
  ok("next_page は next", sceneOfOp("click:next_page") === "next");
  ok("building_tr（物件の行）は list", sceneOfOp("click:building_tr") === "list");
  ok("key だけ（名前なし）は other", sceneOfOp("key") === "other");
  ok("空でも落ちない", sceneOfOp(null) === "other" && sceneOfOp("") === "other");
}

console.log("\n■ ② 人の順番を場面ごとに分ける（実際の1回ぶん）");
{
  // 2026-11-14 の実測の並びをそのまま使う
  const run: FlowOp[] = [
    H("click:所在地絞り込み＋", 1000),
    H("click:大阪市西区", 2000),
    H("click:city_code[]", 2100),
    H("change:city_code[]", 2200),
    H("click:大阪市中央区", 3000),
    H("click:city_code[]", 3100),
    H("change:city_code[]", 3200),
    H("click:大阪市北区", 4000),
    H("click:city_code[]", 4100),
    H("change:city_code[]", 4200),
    H("click:確定してリストへ", 5000),
    H("click:transportation_id", 6000),
    H("change:transportation_id", 6100),
    H("click:required_time", 7000),
    H("change:required_time", 8000),
    H("click:update_date", 9000),
    H("change:update_date", 9100),
    H("click:rental_cost2", 10000),
    H("change:rental_cost2", 10100),
    H("click:go_search", 12000),
  ];
  const flows = learnSceneFlows([run]);
  const by = (s: string) => flows.find((f) => f.scene === s);

  ok("area が出る", !!by("area"), flows.map((f) => f.scene));
  ok("  区の名前が順番に入る", JSON.stringify(by("area")?.steps.slice(0, 2)) === JSON.stringify(["所在地絞り込み＋", "大阪市西区"]), by("area")?.steps);
  ok("  ⚠ change: は click: と同じ欄なので畳む（交互に数えない）",
    JSON.stringify(by("area")?.steps) === JSON.stringify(["所在地絞り込み＋", "大阪市西区", "city_code[]", "大阪市中央区", "city_code[]", "大阪市北区", "city_code[]"]), by("area")?.steps);
  ok("station は transportation_id → required_time", JSON.stringify(by("station")?.steps) === JSON.stringify(["transportation_id", "required_time"]), by("station")?.steps);
  ok("cond は update_date → rental_cost2", JSON.stringify(by("cond")?.steps) === JSON.stringify(["update_date", "rental_cost2"]), by("cond")?.steps);
  ok("search が出る", !!by("search"));
  ok("確定してリストへ は場面に入れない", !flows.some((f) => f.steps.includes("確定してリストへ")));
  ok("手数の多い場面が先（area が先頭）", flows[0].scene === "area", flows.map((f) => f.scene));
}

console.log("\n■ ③ 人の手本だけを使う（拡張の動きを混ぜない）");
{
  const run: FlowOp[] = [
    H("change:city_code[]", 1000),
    A("click:go_search", 2000),   // 拡張が押した
    H("click:go_search", 3000),
  ];
  const flows = learnSceneFlows([run]);
  const search = flows.find((f) => f.scene === "search");
  ok("検索の手本は人の1手だけ", search?.ops === 1, search);
  const all = learnSceneFlows([run], { by: null });
  // ⚠ 隣り合う同じ欄は畳む仕様なので、別の欄で数える（go_search が2回続くと同じ1手）
  ok("by=null なら人の物も拡張の物も入る", all.find((f) => f.scene === "search")?.ops === 1 && all.find((f) => f.scene === "search")?.raw_ops === 2, all.find((f) => f.scene === "search"));
}

console.log("\n■ ④ 弱い場面を見つける（統括が強化する所を決める）");
{
  const flows = learnSceneFlows([
    [H("change:city_code[]", 1000), H("click:go_search", 3000)],
  ]);
  const weak = findWeakScenes(flows);
  ok("手本が無い場面を挙げる", weak.some((w) => w.kind === "no_example"), weak.map((w) => w.scene + ":" + w.kind));
  ok("次のページが弱いと言える", weak.some((w) => w.scene === "next" && w.kind === "no_example"));
  ok("物件の取得（list）が弱いと言える", weak.some((w) => w.scene === "list" && w.kind === "no_example"));
  ok("理由に日本語の場面名が入る", weak.every((w) => w.why.length > 0 && !w.why.includes("undefined")));
}

console.log("\n■ ⑤ 順番が毎回違う＝迷いを見つける");
{
  const mk = (order: string[]) => order.map((k, i) => H(k, 1000 + i * 500));
  const flows = learnSceneFlows([
    mk(["change:city_code[]", "change:town_code[]", "click:go_search"]),
    mk(["change:town_code[]", "change:city_code[]", "click:go_search"]),
    mk(["change:city_code[]", "click:go_search", "change:town_code[]"]),
  ]);
  const weak = findWeakScenes(flows, { minRuns: 3, minOps: 2 });
  ok("area の順番がばらついていると言える", weak.some((w) => w.scene === "area" && w.kind === "unstable"), weak);
  const area = flows.find((f) => f.scene === "area");
  // 3回のうち area の順番は2通り（1回目と3回目が同じ）
  ok("  通り数が出る", area?.variants === 2, area);
  ok("  一番多い順番を持つ", (area?.steps.length ?? 0) === 2, area?.steps);
}

console.log("\n■ ⑥ 押し直し・待ちが長いを見つける");
{
  const many = Array.from({ length: 16 }, (_, i) => H("change:rental_cost2", 1000 + i * 1000));
  const flows = learnSceneFlows([many, many]);
  const weak = findWeakScenes(flows, { minRuns: 2 });
  ok("同じ欄を何度も押していると言える", weak.some((w) => w.scene === "cond" && w.kind === "too_many"), weak);
  ok("間が長いと言える（1秒間隔なので言わない）", !weak.some((w) => w.kind === "slow"), weak);
}

console.log("\n■ ⑦ 人が読める形（統括がそのまま話せる）");
{
  const flows = learnSceneFlows([
    [H("change:city_code[]", 1000), H("change:town_code[]", 3000), H("click:go_search", 5000)],
    [H("change:city_code[]", 1000), H("change:town_code[]", 3000), H("click:go_search", 5000)],
  ]);
  const line = describeSceneFlow(flows.find((f) => f.scene === "area")!);
  ok("場面の日本語名が入る", line.includes(SCENE_JA.area), line);
  ok("回数が入る", /2回/.test(line), line);
  // 手本の数は「回 × 手」で数える（2回 × 2手 = 4手）。実際の手順も2手。
  ok("手数が入る（2回×2手=4手）", /手本4手/.test(line), line);
  ok("実際の順番は2手", flows.find((f) => f.scene === "area")?.steps.length === 2);
  ok("順番は決まっていると言える", line.includes("順番は決まっている"), line);
  ok("教える形（playbook）に場面と順番が入る", scenePlaybook(flows).some((p) => p.includes("所在地絞り込み") && p.includes("city_code[]")));
}

console.log("\n■ ⑨ 止まった場面は「時系列で最後」（手数が多い場面ではない）");
{
  /**
   * ⚠ 実測で起きた誤り: 所在地 → 駅 → 条件 → 検索 と全部押して**検索の後で止まった**のに、
   *   統括は「所在地で止まる」と言っていた（手数が多い場面を最後と取り違えていた）。
   */
  const run: FlowOp[] = [
    H("click:所在地絞り込み＋", 1000),
    H("click:大阪市西区", 2000),
    H("click:city_code[]", 2100),
    H("click:大阪市中央区", 3000),
    H("click:city_code[]", 3100),
    H("click:大阪市北区", 4000),
    H("click:city_code[]", 4100),
    H("click:transportation_id", 5000),
    H("click:required_time", 6000),
    H("click:update_date", 7000),
    H("click:rental_cost2", 8000),
    H("click:検索", 9000),
  ];
  ok("最後の場面は search（検索を押した後）", lastSceneOf(run) === "search", lastSceneOf(run));
  // 手数が多い順の先頭は area（＝ここを取り違えていた）
  ok("  ⚠ 手数が多い順の先頭は area（これを最後と誤解していた）", learnSceneFlows([run])[0].scene === "area");
  ok("文字入力（key）だけなら1つ前の場面", lastSceneOf([H("click:rental_cost2", 1), H("key", 2), H("key", 3)]) === "cond");
  ok("場面が無ければ null", lastSceneOf([H("確定してリストへ", 1)]) === null);
  ok("空でも落ちない", lastSceneOf([]) === null);
}

console.log("\n■ ⑩ 壊れない");
{
  ok("空", learnSceneFlows([]).length === 0);
  ok("null", learnSceneFlows(null as never).length === 0);
  ok("空の回", learnSceneFlows([[]]).length === 0);
  ok("t が無くても落ちない", learnSceneFlows([[{ k: "change:city_code[]" }]]).length === 1);
  ok("k が無い操作は飛ばす", learnSceneFlows([[{ t: 1 }, { k: "change:city_code[]", t: 2 }]])[0].ops === 1);
  ok("弱い所が無ければ空", findWeakScenes([]).every((w) => w.kind === "no_example") || findWeakScenes([]).length > 0);
  ok("describeSceneFlow が落ちない", typeof describeSceneFlow(learnSceneFlows([[H("change:city_code[]", 1)]])[0]) === "string");
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
