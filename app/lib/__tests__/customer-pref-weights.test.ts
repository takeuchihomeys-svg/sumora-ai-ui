// app/lib/__tests__/customer-pref-weights.test.ts
// お客様ごとのこだわりの倍率（customer-pref-weights.ts）と、judgeProperty への入り方（opts.prefWeight）の回帰テスト。
// 実行: npx tsx app/lib/__tests__/customer-pref-weights.test.ts
//
// 値は本番の形そのまま（2026-09-29 の property_pickups の札: 会話 ad97cd40 の回 cg_a9bd4ddd_913「AIA難波南 102」「エグゼレジデンスタワー 301」）。
import {
  PREF_WEIGHT_CONFIG, LEARNED_PREF_WEIGHTS, PREF_WEIGHTS_DEFAULT_ON, isPrefFamily, prefMultiplier, levelOf, prefWeightResolver, tableHasEffect,
  prefScoreOf, prefRankMetrics, learnableRounds, learnPrefWeights, backtestPrefWeights, defaultBandsOf, splitByCustomer, splitByTime,
  prefWeightsEnabled, prefWeightForJudge, prefVerdictFlips, capRoundsPerCustomer, type PrefWeightTable, type StrengthOf,
} from "../customer-pref-weights";
import { judgeProperty, parsePropertyFacts, buildCustomerProfile, scoreFromCodes, baseReasonPoints, applyImageFacts, applyEquipmentMatch, rejudgeWithoutDiscount, applyAdRulesToRow, type CustomerLike } from "../property-brain";
import { scoreGapNote } from "../pickup-card-view";
import { adCapOf } from "../scoring-learning";
import type { Episode } from "../scoring-learning";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const base = baseReasonPoints;

// 実物の札（売上サポの回・2026-09-28）
const AIA = ["RENT_OK", "ZERO_ZERO", "FLOOR_PLAN_MATCH", "SQM_OK", "AD_HIGH", "MOVE_IN_OK", "EQUIP_COUNTER_KITCHEN_NOT_UNLISTED", "AREA_WARD_MATCH", "AGE_N5", "SEARCH_PINPOINT", "FIT_ALL"];
const EXE = ["RENT_OK", "FLOOR_PLAN_WIDE", "SQM_OK", "AD_1M", "MOVE_IN_UNKNOWN", "EQUIP_COUNTER_KITCHEN_NOT_UNLISTED", "AREA_WARD_MATCH", "FIT_ALL"];
// そのお客様の強さ（customerStrength.byFamily の形）
const STRENGTH = { rent: { level: "stated" as const }, floor_plan: { level: "stated" as const }, size: { level: "strong" as const }, area: { level: "strong" as const }, move_in: { level: "strong" as const }, "equip:counter_kitchen": { level: "strong" as const } };

console.log("■ 倍率の表と札 → 倍率");
{
  t("AD・条件でない札の家族は倍率を掛けない", !isPrefFamily("ad") && !isPrefFamily("fit") && !isPrefFamily("pinpoint") && !isPrefFamily(null) && isPrefFamily("floor_plan") && isPrefFamily("equip:bath_toilet"));
  const table: PrefWeightTable = { floor_plan: { strong: 1.5, stated: 1.25 }, area: { strong: 2.0 }, ad: { strong: 3 }, rent: { stated: 0.2 } };
  t("表の倍率（none は 1・表に無い所は 1・AD は 1）", prefMultiplier("floor_plan", "strong", table) === 1.5 && prefMultiplier("floor_plan", "stated", table) === 1.25 && prefMultiplier("floor_plan", "none", table) === 1 && prefMultiplier("size", "strong", table) === 1 && prefMultiplier("ad", "strong", table) === 1);
  t("倍率は下限・上限に押し込む（1.0〜2.0）", prefMultiplier("rent", "stated", table) === PREF_WEIGHT_CONFIG.minMult && prefMultiplier("area", "strong", { area: { strong: 9 } }) === PREF_WEIGHT_CONFIG.maxMult);
  t("levelOf は文字でも {level} でも読む", levelOf({ rent: "strong", area: { level: "stated" } }, "rent") === "strong" && levelOf({ rent: "strong", area: { level: "stated" } }, "area") === "stated" && levelOf(STRENGTH, "walk") === "none");
  const w = prefWeightResolver(STRENGTH, table);
  // FLOOR_PLAN_MATCH 15 は AD の線（15）に届いているので ×1・AREA_WARD_MATCH 8 × 2 = 16 は線で 15（×1.875）
  t("札 → 倍率: FLOOR_PLAN_WIDE（間取り stated 8点）×1.25・FLOOR_PLAN_MATCH（15点＝AD の線）×1・AREA_WARD_MATCH（エリア strong 8点）は 15点まで", w("FLOOR_PLAN_WIDE") === 1.25 && w("FLOOR_PLAN_MATCH") === 1 && w("AREA_WARD_MATCH") === 15 / 8, String(w("AREA_WARD_MATCH")));
  t("AD・FIT・SEARCH・材料の無い札は ×1（凍結）", w("AD_HIGH") === 1 && w("AD_1M") === 1 && w("FIT_ALL") === 1 && w("SEARCH_PINPOINT") === 1 && w("MOVE_IN_UNKNOWN") === 1 && w("EQUIP_COUNTER_KITCHEN_NOT_UNLISTED") === 1);
  t("書いていない条件（none）は ×1", prefWeightResolver({}, table)("FLOOR_PLAN_WIDE") === 1);
  t("減点の札・0点の札は ×1（こだわりで上げる向きだけ）", prefWeightResolver({ floor_plan: "strong", rent: "strong" }, { floor_plan: { strong: 2 }, rent: { strong: 2 } })("FLOOR_PLAN_MISMATCH") === 1 && prefWeightResolver({ rent: "strong" }, { rent: { strong: 2 } })("RENT_OVER_110") === 1 && prefWeightResolver({ area: "strong" }, table)("AREA_MISMATCH") === 1);
  t("表に効く所が無ければ false（空・全部1・AD だけ）", !tableHasEffect({}) && !tableHasEffect({ rent: { strong: 1 } }) && !tableHasEffect({ ad: { strong: 2 } }) && tableHasEffect(table));
}

console.log("■ 点（50＋Σ round(点 × 倍率)）");
{
  const table: PrefWeightTable = { floor_plan: { stated: 1.5 }, area: { strong: 2 } };
  const w = prefWeightResolver(STRENGTH, table);
  const s0 = prefScoreOf(AIA, base, null), s1 = prefScoreOf(AIA, base, w);
  // FLOOR_PLAN_MATCH 15 は AD の線で 15 のまま・AREA_WARD_MATCH 8 → 15（線）
  t(`倍率なし ${s0}（実物 152）・倍率あり ${s1}（+0 +7）`, s0 === 152 && s1 === 152 + 0 + 7);
  const e0 = prefScoreOf(EXE, base, null), e1 = prefScoreOf(EXE, base, w);
  // FLOOR_PLAN_WIDE 8 → 12・AREA_WARD_MATCH 8 → 15
  t(`選ばなかった物 ${e0}（実物 114）→ ${e1}`, e0 === 114 && e1 === 114 + 4 + 7);
  t("上限 200・下限 0", prefScoreOf(Array(20).fill("FLOOR_PLAN_MATCH"), base, null) === 200 && prefScoreOf(Array(20).fill("RENT_OVER_130"), base, null) === 0);
}

console.log("■ AD の線（AD 以外の加点は AD 2ヶ月の札 ÷ 1.3 を超えない・feedback_ad_scoring）");
{
  const cap = Math.floor(adCapOf(base));
  t(`AD の線は floor(AD_HIGH 20 ÷ 1.3) = ${cap}`, cap === 15);
  const all: PrefWeightTable = {};
  const strong: Record<string, "strong"> = {};
  const POS = ["FLOOR_PLAN_MATCH", "FLOOR_PLAN_WIDE", "AREA_WARD_MATCH", "AREA_NEAR", "RENT_OK", "WALK_OK", "ZERO_ZERO", "SQM_OK", "AGE_N5", "MOVE_IN_OK", "EQUIP_BATH_TOILET_MUST_OK", "EQUIP_BATH_TOILET_OK"];
  for (const f of ["floor_plan", "area", "rent", "walk", "initial_cost", "size", "age", "move_in", "equip:bath_toilet"]) { all[f] = { strong: 2 }; strong[f] = "strong"; }
  const w = prefWeightResolver(strong, all);
  const over = POS.filter((c) => Math.round(base(c) * w(c)) > Math.max(base(c), cap));
  t("倍率 ×2 でもどの加点の札も max(今の点, 15) を超えない", over.length === 0, over.join(","));
  t("間取り ×2 でも FLOOR_PLAN_MATCH は 15 のまま（AD_HIGH 20 より下）", Math.round(base("FLOOR_PLAN_MATCH") * w("FLOOR_PLAN_MATCH")) === 15 && Math.round(base("AREA_WARD_MATCH") * w("AREA_WARD_MATCH")) === 15);
  // AD の段だけ違う2物件（どちらも間取り一致）: 倍率を掛けても AD 2ヶ月の物件が上
  const hi = ["FLOOR_PLAN_MATCH", "AREA_WARD_MATCH", "AD_HIGH"], lo = ["FLOOR_PLAN_MATCH", "AREA_WARD_MATCH", "AD_1_5M"];
  t("AD の段だけ違う物件は倍率ありでも AD 2ヶ月の方が上", prefScoreOf(hi, base, w) > prefScoreOf(lo, base, w) && prefScoreOf(hi, base, w) - prefScoreOf(lo, base, w) === base("AD_HIGH") - base("AD_1_5M"));
}

console.log("■ judgeProperty への入り方（opts.prefWeight）");
{
  const cust = { rent_max: 90000, floor_plan: "1K", desired_area: "浪速区" } as CustomerLike;
  const prof = buildCustomerProfile(cust, [], [], null, { today: "2026-09-28" });
  const f = parsePropertyFacts("【1】AIA難波南 102号室", { rank: 1, name: "AIA難波南", rent: 85000, floor_plan: "1K", ad_months: 2, deposit_months: 0, key_money_months: 0 });
  const j0 = judgeProperty(f, prof, 0, { today: "2026-09-28" });
  // 実物の札: RENT_OK ZERO_ZERO FLOOR_PLAN_MATCH AD_HIGH FIT_ALL_HALF（116点）
  const w = prefWeightResolver({ initial_cost: "strong", floor_plan: "strong" }, { initial_cost: { strong: 2 }, floor_plan: { strong: 2 } });
  const j1 = judgeProperty(f, prof, 0, { today: "2026-09-28", prefWeight: w });
  t("渡さなければ今まで通り（50＋札の合計）", j0.score === scoreFromCodes(j0.reasonCodes) && j0.score === 50 + j0.reasonCodes.reduce((a, c) => a + baseReasonPoints(c), 0) && j0.score === 116);
  t("渡すと札は同じで点だけ変わる（ZERO_ZERO 8 → 15・FLOOR_PLAN_MATCH は AD の線で 15 のまま）", JSON.stringify(j1.reasonCodes) === JSON.stringify(j0.reasonCodes) && j1.score === j0.score + 7, `${j0.score} → ${j1.score}`);
  t("scoreFromCodes に同じ倍率を渡すと同じ点", scoreFromCodes(j1.reasonCodes, w) === j1.score);
  t("AD の札には効かない（AD_HIGH の家族 ad は表に無い）", judgeProperty(f, prof, 0, { today: "2026-09-28", prefWeight: prefWeightResolver({ ad: "strong" }, { ad: { strong: 2 } } as PrefWeightTable) }).score === j0.score);
  const withImg = applyImageFacts({ ...j1, imageChecks: ["bath_toilet_separate"], imageMust: [] }, { bath_toilet_separate: true }, w);
  const withImg0 = applyImageFacts({ ...j0, imageChecks: ["bath_toilet_separate"], imageMust: [] }, { bath_toilet_separate: true });
  t("applyImageFacts に同じ倍率を渡すと倍率のまま付け直す（IMAGE_*_OK +5・全部合うの札は凍結＝×1・敷礼0 の +7 は残る）", withImg.score === scoreFromCodes(withImg.reasonCodes, w) && withImg.score === withImg0.score + 7, `${withImg0.score} → ${withImg.score}`);
  t("渡さないと倍率なしの点に戻る（呼ぶ側が同じ物を渡す決まり）", applyImageFacts({ ...j1, imageChecks: ["bath_toilet_separate"], imageMust: [] }, { bath_toilet_separate: true }).score === withImg0.score && withImg0.score === scoreFromCodes(withImg0.reasonCodes));
  // 判定の後で点を付け直す関数も同じ倍率を受け取る（反証レビュー 2026-09-29: 渡せないと点が静かに元に戻る）
  const eq = applyEquipmentMatch({ reasonCodes: j1.reasonCodes }, null, w);
  t("applyEquipmentMatch の後も倍率ありの点のまま", eq.score === j1.score && applyEquipmentMatch({ reasonCodes: j1.reasonCodes }, null).score === j0.score, `${eq.score}`);
  const rj = rejudgeWithoutDiscount([...j1.reasonCodes, "AD_COVERS_DISCOUNT"], { prefWeight: w });
  t("rejudgeWithoutDiscount の後も倍率ありの点のまま", rj.score === j1.score);
  // 保存の点が「前の配点（AD_UNDER_1M −8）で倍率あり」で付いていた行 → 付け直した点は「今の配点で倍率あり」の 50＋合計 と一致する
  const oldCodes = [...j1.reasonCodes.filter((c) => c !== "AD_HIGH" && c !== "FIT_ALL_HALF"), "AD_UNDER_1M"];
  const storedOld = scoreFromCodes(oldCodes, w) + (-8 - baseReasonPoints("AD_UNDER_1M"));
  const ad = applyAdRulesToRow({ reason_codes: oldCodes, score: storedOld, verdict: "pass" }, w);
  const ad0 = applyAdRulesToRow({ reason_codes: oldCodes, score: storedOld, verdict: "pass" });
  t("applyAdRulesToRow（保存の点＋札の差）は倍率ありの差で付け直す（50＋倍率ありの合計と一致）", !!ad && ad.score === scoreFromCodes(ad.reason_codes, w), JSON.stringify([ad?.score, scoreFromCodes(ad?.reason_codes ?? [], w), ad0?.score]));
  t("scoreGapNote: 倍率を渡せば倍率ありの点の行に「今の配点では」を出さない（渡さなければ出る）", scoreGapNote(j1.reasonCodes, j1.score, w) === null && /今の配点では/.test(scoreGapNote(j1.reasonCodes, j1.score) ?? ""));
}

// ─── 学ぶ・当て直す（作った回） ────────────────────────────────────────────────
/** 回: 選んだ物は chosen の札、選ばなかった物は others の札。strength は回のお客様の強さ */
type Ep = Episode & { customerKey: string; strength: Record<string, "strong" | "stated" | "none">; klass?: string; meta?: { rentMax?: number | null; priorSends?: number | null } };
function ep(i: number, cust: string, chosen: string[], others: string[][], strength: Ep["strength"], extra: Partial<Ep> = {}): Ep {
  return {
    id: `pool:${cust}:${i}`, at: new Date(Date.UTC(2026, 7, 1) + i * 3600_000).toISOString(), source: "pool", segments: [], customerKey: cust, strength,
    cands: [{ key: "c", chosen: true, codes: chosen, feats: {} }, ...others.map((c, j) => ({ key: `o${j}`, chosen: false, codes: c, feats: {} }))],
    ...extra,
  };
}
const strengthOf: StrengthOf = (e, f) => (e as Ep).strength[f] ?? "none";

console.log("■ 学べる回・順位");
{
  // 間取りを書いた（stated）お客様: AD の段は同じ（AD_1M）・選んだ物は間取り一致、選ばなかった物は間取り違い（家賃内の物と無い物）
  const eps: Ep[] = [];
  for (let i = 0; i < 12; i++) eps.push(ep(i, `c${i % 4}`, ["FLOOR_PLAN_MATCH", "AD_1M"], [["FLOOR_PLAN_MISMATCH", "AD_1M", "RENT_OK"], ["FLOOR_PLAN_MISMATCH", "AD_1M"]], { floor_plan: "stated" }));
  t("学べる回＝強さが合い、選んだ物と選ばなかった物で満たすかが違う回", learnableRounds(eps, "floor_plan", "stated", strengthOf).length === 12 && learnableRounds(eps, "floor_plan", "strong", strengthOf).length === 0 && learnableRounds(eps, "rent", "stated", strengthOf).length === 0);
  const m0 = prefRankMetrics(eps, base, () => null);
  // 選んだ 50+15+15=80・選ばなかった 50-15+15+15=65 と 50-15+15=50 → 選んだ物が1位
  t("今の点で選んだ物が1位（top1 1・相対順位 0）", m0.top1 === 1 && m0.relRank === 0 && m0.top10 === 1, JSON.stringify(m0));
  const m1 = prefRankMetrics(eps, base, () => (c) => (c === "FLOOR_PLAN_MISMATCH" ? 0.1 : c === "RENT_OK" ? 2 : 1));
  t("倍率で順位が動く（不一致の減点を弱め家賃を ×2 にすると選んだ物が2位）", m1.top1 === 0 && m1.relRank === 0.5, JSON.stringify(m1));
}

console.log("■ 学ぶ（安全の決まり）");
{
  // エリア stated（AREA_WARD_MATCH 8点）: AD の段は同じ。選んだ物はエリア一致（50+8+15=73）、選ばなかった物はエリア外で敷礼0（50+0+15+8=73）＝同点。
  //   エリアの倍率 ×1.25 で選んだ物 75・選ばなかった物 73 → 選んだ物が1位（10人・14回）
  const eps: Ep[] = [];
  for (let i = 0; i < 14; i++) eps.push(ep(i, `c${i % 10}`, ["AREA_WARD_MATCH", "AD_1M"], [["AREA_MISMATCH", "AD_1M", "ZERO_ZERO"]], { area: "stated", rent: "stated" }));
  const r = learnPrefWeights(eps, base, strengthOf);
  const ch = r.changes.find((c) => c.family === "area" && c.level === "stated");
  t("エリア × stated を上げる（同点 0.5 → 1位 0・一番小さい目盛り ×1.25）", !!ch && ch.from === 1 && ch.to === 1.25 && ch.rounds === 14 && ch.relBefore === 0.5 && ch.relAfter === 0, JSON.stringify(r.changes));
  // ×1.5 が要る形（選ばなかった物は徒歩内 +10 = 75）: 既定は ×1.5・1回の上限を 0.25 にすると ×1.25（同点）まで
  const eps15 = eps.map((e, i) => ep(i, e.customerKey, ["AREA_WARD_MATCH", "AD_1M"], [["AREA_MISMATCH", "AD_1M", "WALK_OK"]], { area: "stated" }));
  const r15 = learnPrefWeights(eps15, base, strengthOf), r15s = learnPrefWeights(eps15, base, strengthOf, null, { ...PREF_WEIGHT_CONFIG, maxStep: 0.25 });
  t("1回に動かす量の上限（既定 ±0.5 → ×1.5・0.25 なら ×1.25 まで）", r15.table.area?.stated === 1.5 && r15s.table.area?.stated === 1.25, JSON.stringify([r15.table, r15s.table]));
  t("家賃は候補に札が無い＝表に入らない（お客様が stated でも）", !("rent" in r.table));
  t("AD は表に入らない", !("ad" in r.table));
  const few = learnPrefWeights(eps.slice(0, 9), base, strengthOf);
  t("最低件数（10回）未満は学ばない", few.changes.length === 0 && few.skipped.some((s) => s.family === "area" && /件数不足/.test(s.reason)));
  // 人数: 同じ形でも 3人・各5回（15回）は、1人3回まで＝9回で件数不足。4人×3回＝12回でも人数不足（8人 未満）
  const three = Array.from({ length: 15 }, (_, i) => ep(i, `p${i % 3}`, ["AREA_WARD_MATCH", "AD_1M"], [["AREA_MISMATCH", "AD_1M", "ZERO_ZERO"]], { area: "stated" }));
  const rThree = learnPrefWeights(three, base, strengthOf);
  t("1人から数える回は3回まで（3人×5回 → 9回＝件数不足）", rThree.changes.length === 0 && rThree.skipped.some((s) => s.family === "area" && s.rounds === 9 && /件数不足/.test(s.reason)), JSON.stringify(rThree.skipped));
  const four = Array.from({ length: 16 }, (_, i) => ep(i, `p${i % 4}`, ["AREA_WARD_MATCH", "AD_1M"], [["AREA_MISMATCH", "AD_1M", "ZERO_ZERO"]], { area: "stated" }));
  const rFour = learnPrefWeights(four, base, strengthOf, null, { ...PREF_WEIGHT_CONFIG, minRounds: 10 });
  t("人数が足りなければ学ばない（4人×3回＝12回・8人 未満）", rFour.changes.length === 0 && rFour.skipped.some((s) => s.family === "area" && /人数不足（4人/.test(s.reason)), JSON.stringify(rFour.skipped));
  t("capRoundsPerCustomer は新しい方から残す", capRoundsPerCustomer(three, 1).map((e) => e.id).join(",") === three.slice(-3).map((e) => e.id).sort((a, b) => three.findIndex((x) => x.id === a) - three.findIndex((x) => x.id === b)).join(","));
  // 2回目の学習: もう1位なので動かない（今の表のまま）
  const r2 = learnPrefWeights(eps, base, strengthOf, r.table);
  t("続けて学んでも良くならなければ動かない（表は ×1.25 のまま）", r2.changes.length === 0 && r2.table.area?.stated === 1.25, JSON.stringify(r2.table));
  t("弱める向き（1 未満）には学ばない", Object.values(r.table).every((lv) => Object.values(lv).every((m) => (m ?? 1) >= 1)));
  // 間取り一致（15点＝AD の線）は倍率で上がらない＝学べない
  const fp = Array.from({ length: 14 }, (_, i) => ep(i, `c${i % 10}`, ["FLOOR_PLAN_MATCH", "AD_1M"], [["FLOOR_PLAN_MISMATCH", "AD_1M", "RENT_OK", "WALK_OK", "ZERO_ZERO"]], { floor_plan: "stated" }));
  const rfp = learnPrefWeights(fp, base, strengthOf);
  t("AD の線に届いている札（FLOOR_PLAN_MATCH 15）は倍率で動かない＝学ばない", rfp.changes.length === 0, JSON.stringify(rfp.changes));
}

console.log("■ 当て直し（学ぶ期間と確かめる期間を分ける・帯）");
{
  const eps: Ep[] = [];
  // 古い 49回: 間取り stated で倍率が効く形。新しい 21回: 同じ形（良くなる・確かめ用の最低 20回を満たす）
  for (let i = 0; i < 70; i++) eps.push(ep(i, `c${i % 10}`, ["AREA_WARD_MATCH", "AD_1M"], [["AREA_MISMATCH", "AD_1M", "WALK_OK"]], { area: "stated" }, { klass: i % 2 ? "強い" : "弱い", meta: { rentMax: i % 3 ? 80000 : 120000, priorSends: i % 4 ? 3 : 0 } }));
  const bt = backtestPrefWeights(eps, base, strengthOf);
  t("古い7割で学び・新しい3割で確かめる", bt.train === 49 && bt.holdout === 21);
  t("確かめ用が 20回未満なら使わない（安全の決まり）", !backtestPrefWeights(eps.slice(0, 40), base, strengthOf).decision.enable && /確かめ用の回が少ない/.test(backtestPrefWeights(eps.slice(0, 40), base, strengthOf).decision.reason));
  t("確かめ用で良くなれば使う（通す／保留は変わらない）", bt.decision.enable && bt.gain > 0 && bt.weighted.top1 > bt.base.top1 && bt.verdictFlips.toPass === 0 && bt.verdictFlips.toHold === 0, bt.decision.reason);
  t("帯（こだわり・家賃・新規/継続・材料）が出る", bt.bands.some((b) => b.band === "こだわり" && b.value === "強い") && bt.bands.some((b) => b.band === "家賃") && bt.bands.some((b) => b.band === "新規/継続") && bt.bands.some((b) => b.band === "材料" && b.value === "pool"));
  t("回の少ない帯は使わない（回が少ない）", bt.bands.filter((b) => b.n < PREF_WEIGHT_CONFIG.bandMinRounds).every((b) => !b.use && /回が少ない/.test(b.note)));
  // 悪くなる帯: 新しい回のうち一部（i % 4 === 1）のお客様だけ逆の形（選んだ物がエリア外・選ばなかった物がエリア一致）→ 全体は良くなるが、その帯は悪くなる
  const eps2 = eps.map((e, i) => (i >= 49 ? (i % 4 === 1
    ? ep(i, e.customerKey, ["AREA_MISMATCH", "AD_1M", "WALK_OK"], [["AREA_WARD_MATCH", "AD_1M"], ["AREA_WARD_MATCH", "AD_1M", "AGE_N5"]], { area: "stated" }, { klass: "弱い", meta: e.meta })
    : { ...e, klass: "強い" }) : e));
  const bt2 = backtestPrefWeights(eps2, base, strengthOf, defaultBandsOf as never, { ...PREF_WEIGHT_CONFIG, bandMinRounds: 5 });
  const weak = bt2.bands.find((b) => b.band === "こだわり" && b.value === "弱い");
  t("悪くなる帯は use=false（弱い）", !!weak && !weak.use && weak.gain < 0, JSON.stringify(weak));
  t("全体は良くても悪くなる帯が1つあれば使わない（理由に帯の名前）", bt2.gain >= PREF_WEIGHT_CONFIG.minGain && !bt2.decision.enable && /悪くなる帯.*こだわり=弱い/.test(bt2.decision.reason), JSON.stringify({ gain: bt2.gain, d: bt2.decision }));
  // 通す／保留: 40点の線の近く（家賃オーバー −20）の物件は倍率で保留 → 通すに変わる → 使わない
  const near = eps.map((e, i) => ep(i, e.customerKey, ["AREA_WARD_MATCH", "RENT_OVER_110"], [["AREA_MISMATCH", "RENT_OVER_110", "WALK_OK"]], { area: "stated" }, { klass: "強い", meta: e.meta }));
  const flips = prefVerdictFlips(near, base, () => prefWeightResolver({ area: "stated" }, { area: { stated: 1.5 } }, PREF_WEIGHT_CONFIG, base));
  t("prefVerdictFlips: 38点 → 42点 は保留 → 通す", flips.toPass === 70 && flips.toHold === 0, JSON.stringify(flips));
  const bt4 = backtestPrefWeights(near, base, strengthOf);
  t("通す／保留が変わる候補があれば使わない", !bt4.decision.enable && bt4.verdictFlips.toPass > 0 && /通す／保留が変わる/.test(bt4.decision.reason), JSON.stringify({ d: bt4.decision, f: bt4.verdictFlips, ch: bt4.learned.changes }));
  // 学べない材料（全部同じ札）は変更なし・使わない
  const flat = Array.from({ length: 70 }, (_, i) => ep(i, `c${i % 8}`, ["FLOOR_PLAN_MATCH"], [["FLOOR_PLAN_MATCH"], ["FLOOR_PLAN_MATCH"]], { floor_plan: "stated" }));
  const bt3 = backtestPrefWeights(flat, base, strengthOf);
  t("学べる回が無ければ変更なし・使わない", !bt3.decision.enable && bt3.learned.changes.length === 0 && bt3.gain === 0);
  // お客様で分ける
  const s1 = splitByCustomer(0)(eps, PREF_WEIGHT_CONFIG), s2 = splitByCustomer(1)(eps, PREF_WEIGHT_CONFIG);
  const custs = (xs: Episode[]) => new Set(xs.map((e) => (e as Ep).customerKey));
  t("お客様で分けると同じお客様は学ぶ側と確かめ側に分かれない・2つで全部", s1.train.length + s1.holdout.length === 70 && [...custs(s1.train)].every((c) => !custs(s1.holdout).has(c)) && s1.holdout.length === s2.train.length);
  t("時期で分けると確かめ用は新しい方", splitByTime(eps, PREF_WEIGHT_CONFIG).holdout.every((e) => e.at >= splitByTime(eps, PREF_WEIGHT_CONFIG).train[48].at));
}

console.log("■ 切り替え（環境変数）と学んだ表");
{
  t("既定は使わない（2026-09-29 の当て直しで良くならない）", PREF_WEIGHTS_DEFAULT_ON === false && !prefWeightsEnabled({}));
  t("CUSTOMER_PREF_WEIGHTS=on で使う・off で止める", prefWeightsEnabled({ CUSTOMER_PREF_WEIGHTS: "on" }) && !prefWeightsEnabled({ CUSTOMER_PREF_WEIGHTS: "off" }));
  t("学んだ表は空（効く所が無い）＝判定に渡す物は null", !tableHasEffect(LEARNED_PREF_WEIGHTS) && prefWeightForJudge(STRENGTH, LEARNED_PREF_WEIGHTS, { CUSTOMER_PREF_WEIGHTS: "on" }) === null);
  const w = prefWeightForJudge(STRENGTH, { floor_plan: { stated: 1.5 } }, { CUSTOMER_PREF_WEIGHTS: "on" });
  t("on で効く表なら倍率の関数（off なら null）", !!w && w("FLOOR_PLAN_WIDE") === 1.5 && prefWeightForJudge(STRENGTH, { floor_plan: { stated: 1.5 } }, { CUSTOMER_PREF_WEIGHTS: "off" }) === null);
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
