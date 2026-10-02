// 2026-10-02 ⑯ 手順3「家賃と部屋の条件」の相場（rent-condition-market.ts）と、築年の相場の文（area-rent-explain）のテスト（LLM なし）
// 実行: npx tsx app/lib/__tests__/rent-condition-market.test.ts
import { conditionMarket, explainGap, tradeoffHits, realisticWithinBudget, conditionMarketFacts, structureBand, bandsOf, MARKET_BAND_RULE, type CondObs } from "../rent-condition-market";
import { buildRentMarket } from "../area-rent-explain";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, info ?? ""); } };

const W = "大阪市浪速区";
const mk = (n: number, rent: number, age: number, extra: Partial<CondObs> = {}): CondObs[] =>
  Array.from({ length: n }, (_, i) => ({ ward: W, plan_group: "1K", rent_total: rent + (i % 3) * 1000, building_age: age, walk_minutes: 5, floor: 5, structure: "RC", area_sqm: 25, equipment: { autolock: true, bath_toilet: true }, ...extra }));
// 築浅は高く、古い・木造は安い（実物の傾向の形・数字は例）
const obs: CondObs[] = [...mk(12, 82000, 3), ...mk(12, 76000, 12), ...mk(12, 62000, 32, { structure: "木造", equipment: { autolock: false, bath_toilet: true } })];

console.log("■ 帯");
t("構造の帯: RC→鉄筋・軽量鉄骨→鉄骨・木造", structureBand("RC") === "鉄筋コンクリート造" && structureBand("軽量鉄骨") === "鉄骨造" && structureBand("木造") === "木造");
t("築年の帯（築5年以内・築26年以上）", bandsOf(obs[0], 25).age === "築5年以内" && bandsOf(obs[30], 25).age === "築26年以上");
t("面積は同じ区×間取りの中央値の ±15%", bandsOf({ ...obs[0], area_sqm: 20 }, 25).sqm === "狭め" && bandsOf({ ...obs[0], area_sqm: 30 }, 25).sqm === "広め");

console.log("■ 条件ごとの家賃");
const m = conditionMarket(obs, [W], "1K");
const age26 = m.bands.find((b) => b.dim === "age" && b.band === "築26年以上")!;
const age5 = m.bands.find((b) => b.dim === "age" && b.band === "築5年以内")!;
t("全体の中央値", m.median === 77000, m.median);
t("築26年以上は相場より安い・築5年以内は高い（件数が足りる）", age26.delta < 0 && age5.delta > 0 && age26.sayable && age5.sayable, [age26, age5]);
t("事実の行（安い・高いの千円・件数）", conditionMarketFacts(m, "浪速区").some((f) => /築26年以上/.test(f) && /安い/.test(f) && /12件/.test(f)));
const few = conditionMarket(obs.slice(0, 5), [W], "1K");
t("10件未満は事実を出さない", conditionMarketFacts(few, "浪速区").length === 0);

console.log("■ 安い理由（相場より安い事は加点しない・理由だけ）");
const old = obs[30];
const g = explainGap(old, m)!;
t("古い木造は相場より安い・理由に築年と構造", g.gapYen < 0 && g.reasons.some((r) => r.dim === "age") && g.reasons.some((r) => r.dim === "structure"), g);
t("理由は差の大きい順", g.reasons.length >= 2 && Math.abs(g.reasons[0].delta) >= Math.abs(g.reasons[1].delta));
t("築浅の部屋は高い理由に築年", explainGap(obs[0], m)!.reasons.some((r) => r.dim === "age" && r.delta > 0));
t("差が小さい帯は理由にしない（3千円）", MARKET_BAND_RULE.minDeltaYen === 3000);

console.log("■ 理由がこのお客様に効くか");
t("築浅・防音の希望の人には「古い・木造」が当たる", tradeoffHits(g, old, { newBuild: true, soundproof: true }).map((r) => r.dim).sort().join(",") === "age,structure");
t("予算と場所だけの人には当たらない（古くても良い）", tradeoffHits(g, old, {}).length === 0);
t("築年の上限を言った人（30年以内）には築32年が当たる", tradeoffHits(g, old, { maxAge: 30 }).some((r) => r.dim === "age"));
t("オートロック希望の人には「オートロックなし」が当たる", tradeoffHits(g, old, { autolock: true }).some((r) => r.dim === "autolock"));

console.log("■ 予算の中の現実的な築年・面積（検索の目安）");
const r = realisticWithinBudget(obs, [W], "1K", 70000);
t("7万以内は古い部屋が中心（築年の中央値32年）", r.sayable && r.ageMedian === 32, r);
t("予算以内が10件未満なら言わない", !realisticWithinBudget(obs, [W], "1K", 63000).sayable);

console.log("■ 築年の相場の文（スタッフの型「◯◯周辺の…の家賃相場は◯万円から◯万円程となります！！」）");
const rm = buildRentMarket(obs.map((o) => ({ ...o })), { wards: [W], floorPlan: "1K", rentMax: 80000, label: "なんば", maxAge: 5 })!;
t("築5年以内の文", rm.sentences.some((s) => /^なんば周辺の築5年以内の1Kの家賃相場は[0-9.]+万円から[0-9.]+万円程となります！！$/.test(s)), rm.sentences);
t("築年の希望が無い人には築年の文を出さない", !buildRentMarket(obs, { wards: [W], floorPlan: "1K", rentMax: 80000, label: "なんば" })!.sentences.some((s) => /築/.test(s)));
t("文に「安い物件がお得」の類を作らない", rm.sentences.every((s) => !/お得|割安|格安/.test(s)));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
