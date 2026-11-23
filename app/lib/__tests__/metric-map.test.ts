// app/lib/__tests__/metric-map.test.ts — 数ごとの地図（木）と見込みの突き合わせの純関数（作業員P・2026-11-23・台帳 #610）
//   実行: npx tsx app/lib/__tests__/metric-map.test.ts
import { buildTree, sumMismatches, leavesOf, rankLeaves, forecastVerdictOf, dueChecksOf, fixShareOf, sceneOfWatchKey, examLeafOf, examAixKindOf, examResultsByLeaf, examOrderByMap, gapCauseHintOf, relatedFoundationOf, covers, type MapTurn, type ForecastItem } from "../metric-map";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const R = "core:conductor_aix_60d";
const def = { metric: R, label: "AIX の番の一致", dims: ["kind", "scene", "miss", "cause"] as const };

// 実物の形（11/23 60日の数え方: 96番中43一致）を小さくした物
const turns: MapTurn[] = [
  ...Array.from({ length: 6 }, (_, i) => ({ id: i, kind: "estimate_sheet", scene: "cost", miss: "ok" as const, cause: null })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: 10 + i, kind: "estimate_sheet", scene: "cost", miss: "reply_not_aix" as const, cause: "aix_turn_as_reply" as const })),
  { id: 20, kind: "estimate_sheet", scene: "cost", miss: "reply_not_aix", cause: "counting" },
  { id: 21, kind: "estimate_sheet", scene: "question", miss: "aix_kind", cause: "misread" },
  ...Array.from({ length: 3 }, (_, i) => ({ id: 30 + i, kind: "property_check_result", scene: "property_share", miss: "reply_not_aix" as const, cause: "material" as const })),
  { id: 40, kind: "property_check_result", scene: "property_share", miss: "ok", cause: null },
];
const nodes = buildTree(turns, { ...def, dims: [...def.dims] });
t("根の n と一致", nodes[0].n === 16 && nodes[0].ok === 7 && nodes[0].misses === 9 && nodes[0].value === 43.8);
t("子を足すと親に戻る（全部の親）", sumMismatches(nodes).length === 0);
t("壊した木は食い違いに出る（根と壊した親の2つ）", sumMismatches(nodes.map((x) => (x.key === `${R}/kind=estimate_sheet` ? { ...x, n: x.n + 1 } : x))).length === 2);
t("一致の葉には原因の子が無い", !nodes.some((x) => x.parent?.endsWith("/miss=ok")));
t("葉の鍵の形", nodes.some((x) => x.key === `${R}/kind=estimate_sheet/scene=cost/miss=reply_not_aix/cause=aix_turn_as_reply` && x.n === 4));
t("葉の数の合計は根と同じ", leavesOf(nodes).reduce((s, l) => s + l.n, 0) === 16);

const it = (o: Partial<ForecastItem>): ForecastItem => ({ id: 1, title: "x", stage: "built_off", owner: "作業員A", priority: 0, switch_name: null, switch_default: null, next_step: "試験を積む", blocker: null, forecast_metric: R, forecast_leaf: R, forecast_writer_select: "style", forecast_before: 44.8, forecast_low: 60, forecast_high: 70, ...o });
t("直る見込み（44.8 → 60〜70 の真ん中 65 は外れの 36.6%）", Math.abs((fixShareOf(it({})) ?? 0) - 0.366) < 0.001);
const ranked = rankLeaves(nodes, [it({}), it({ id: 2, forecast_leaf: `${R}/kind=property_check_result`, forecast_before: 25, forecast_low: 70, forecast_high: 80, stage: "passed" })]);
t("順位1 は外れの多い見積の返信にした葉（物件確認は場面の n 4 で判断保留＝0.3倍）", ranked[0].key.endsWith("kind=estimate_sheet/scene=cost/miss=reply_not_aix/cause=aix_turn_as_reply") && ranked[1].hold);
t("根だけの見込みの葉は穴（見積の返信にした・外れ 4）", ranked.find((r) => r.key.endsWith("kind=estimate_sheet/scene=cost/miss=reply_not_aix/cause=aix_turn_as_reply"))!.hole === true);
t("種類に付いた作業の葉は穴でない・作業 #2 が次の一手", (() => { const p = ranked.find((r) => r.key.includes("property_check_result"))!; return !p.hole && p.items.includes(2) && p.nextStep.startsWith("#2"); })());
t("外れ 2 以下・場面の n<5 は判断保留（0.3倍）", ranked.find((r) => r.key.includes("scene=question"))!.hold === true);
t("書き手の選び方が違う作業は使わない", rankLeaves(nodes, [it({ id: 3, forecast_leaf: `${R}/kind=property_check_result`, forecast_writer_select: "device" })], { writerSelect: "style" }).find((r) => r.key.includes("property_check_result"))!.items.length === 0);

t("幅の中", forecastVerdictOf(60, 70, 63, 40) === "in");
t("下に外れ", forecastVerdictOf(60, 70, 52, 40) === "below");
t("n が小さいと保留", forecastVerdictOf(60, 70, 52, 3) === "pending");
const d0 = Date.parse("2026-11-01T00:00:00Z");
t("7日・14日の頃", JSON.stringify(dueChecksOf(d0, d0 + 15 * 86_400_000, [])) === "[7,14]" && JSON.stringify(dueChecksOf(d0, d0 + 15 * 86_400_000, [7])) === "[14]" && dueChecksOf(d0, d0 + 3 * 86_400_000, []).length === 0);
t("外れの原因の候補（作業の葉の下の一番多い原因）", gapCauseHintOf(nodes, `${R}/kind=property_check_result`) === "material");

t("場面: 返信:条件提示 → conditions", sceneOfWatchKey("返信:条件提示") === "conditions");
t("場面: AIX:estimate_sheet → cost", sceneOfWatchKey("AIX:estimate_sheet") === "cost");
t("場面: 返信:短い了承・お礼 → ack", sceneOfWatchKey("返信:短い了承・お礼") === "ack");
t("試験: AIX:estimate_sheet の問題 → 種類", examAixKindOf({ id: "q1", accept: ["AIX:estimate_sheet"] }) === "estimate_sheet");
t("試験: 左右・返信は当たらない", examAixKindOf({ id: "q2", accept: ["AIX:左右"] }) === null && examAixKindOf({ id: "q3", accept: ["返信"] }) === null);
t("試験: 種類×場面の葉", examLeafOf({ id: "q1", accept: ["AIX:estimate_sheet"] }, R, "返信:質問").leaf === `${R}/kind=estimate_sheet/scene=question`);
const by = examResultsByLeaf([{ problem_id: "q1", leaf_key: `${R}/kind=estimate_sheet/scene=cost` }, { problem_id: "q2", leaf_key: `${R}/kind=estimate_sheet/scene=cost` }], new Map([["q1", true], ["q2", false]]), new Map([["q1", false], ["q2", true]]));
const o = by.get(`${R}/kind=estimate_sheet/scene=cost`)!;
t("試験の結果を葉に戻す（前→後・悪くなった・良くなった）", o.n === 2 && o.before_ok === 1 && o.after_ok === 1 && o.worse[0] === "q1" && o.better[0] === "q2");
t("試験の順番の案: 伸びしろの大きい葉の問題を先に", examOrderByMap(["qa", "qb"], new Map([["qa", `${R}/kind=property_check_result`], ["qb", `${R}/kind=estimate_sheet`]]), ranked)[0] === "qb");
t("関わる土台の空き（同じ場面・all・value 0 だけ）", JSON.stringify(relatedFoundationOf(`${R}/kind=estimate_sheet/scene=cost`, [{ metric: "found:n.chrono:cost:scene_rules", value: 0 }, { metric: "found:n.chrono:viewing:scene_rules", value: 0 }, { metric: "found:n.link:all:rules", value: 0, detail: { cause: "measure" } }, { metric: "found:n.trust:all:parts", value: 0 }, { metric: "found:n.flex:cost:rules", value: 1 }])) === JSON.stringify(["found:n.chrono:cost:scene_rules", "found:n.trust:all:parts"]));
t("covers は段の区切りで", covers(`${R}/kind=a`, `${R}/kind=a/scene=b`) && !covers(`${R}/kind=a`, `${R}/kind=ab`));

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
