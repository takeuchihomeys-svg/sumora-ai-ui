// 2026-09-25 案B（竹内さん決定）の配点のテスト。
// 実行: npx tsx app/lib/__tests__/fit-balance.test.ts
// ■ 例の25問は scripts/audit-fit-balance.ts の EXAMPLES（案B の列が全部○）と同じ札・同じ物件の値。
//   audit の scorePlan（案の試算）ではなく、本番の純関数（writtenWeightCodes・settleFitBonus・scoreFromCodes）で点を出し、
//   ①合格の向き ②点そのもの（audit の案B の数字）が一致することを確かめる。
//   札の名前だけ本番の形に合わせた: 必須のオートロック ○ は EQUIP_AUTOLOCK_MUST_OK（+5）
// ■ 後半は judgeProperty を通した確かめ（書いた条件の読み取り・推した敷礼0・設備の強さ・全部合う・画像の × で外れる・50＋合計＝点）
// お客様の個人情報は無い（条件は作った文）
import {
  writtenWeightCodes, settleFitBonus, scoreFromCodes, summarizeFit, settleHeldAd, readWrittenWants, fitVerdictOf,
  buildCustomerProfile, judgeProperty, parsePropertyFacts, applyImageFacts, applyEquipmentMatch, equipmentReasonCodes,
  reasonPoints, reasonJa, REASON_POINTS, BASE_SCORE, SCORE_MAX, EQUIP_CAP_CODE, HOLD_REASON_CODES, DROP_REASON_CODES,
  type WrittenWants, type WeightFacts,
} from "../property-brain";
import { isFrozenCode } from "../scoring-learning";
import { buildConditionSummary, formatSummaryLine, dropAiCoveredByRule } from "../condition-summary";
import type { EquipmentMatch } from "../listing-equipment";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}

// ── 例の25問（audit-fit-balance.ts の EXAMPLES と同じ） ───────────────────────────
const AD_TIER = /^(AD_1M|AD_1_5M|AD_HIGH|AD_2_5M|AD_VERY_HIGH)(_HELD)?$/;
const isHeldCode = (c: string) => HOLD_REASON_CODES.has(c) || DROP_REASON_CODES.has(c) || /^(?:IMAGE|EQUIP|CONDITION)_.*_NG$/.test(c);
function adCodes(m: number | null): string[] {
  if (m == null) return ["AD_UNKNOWN"];
  if (m <= 0) return ["AD_NONE"];
  const o = ["AD_COVERS_DISCOUNT"];
  if (m >= 1 && m < 2) o.push("AD_1M");
  if (m >= 1.5 && m < 2) o.push("AD_1_5M");
  if (m >= 2) o.push("AD_HIGH");
  if (m >= 2.5) o.push("AD_2_5M");
  if (m >= 3) o.push("AD_VERY_HIGH");
  return o;
}
type Cand = { key: string; codes: string[]; f: WeightFacts };
function mk(key: string, fit: string[], ad: number | null, x: Partial<{ age: number; walk: number; rentRatio: number }> = {}): Cand {
  const codes = [...fit, ...adCodes(ad)];
  const held = codes.some(isHeldCode);
  return { key, codes: settleHeldAd(codes, held), f: { buildingAge: x.age ?? 7, walkMinutes: x.walk ?? 6, rentRatio: x.rentRatio ?? 0.92, adMonths: ad } };
}
function score(c: Cand, w: WrittenWants): { score: number; codes: string[] } {
  const codes = settleFitBonus([...c.codes, ...writtenWeightCodes(c.codes, c.f, w)]);
  return { score: scoreFromCodes(codes), codes };
}
/** お客様（例）: 家賃・間取り・徒歩の列・敷礼0（書いた）・築浅（自由文 10年）・希望の駅・バストイレ別（普通）・オートロック（必須）・入居時期 */
const W_FULL: WrittenWants = { ageText: { strength: "normal" }, ageColumn: false, walkText: null, walkColumn: true, rentCheap: null };
const W_PLAIN: WrittenWants = { ageText: null, ageColumn: false, walkText: null, walkColumn: true, rentCheap: null };
const W_CHEAP: WrittenWants = { ...W_FULL, rentCheap: { strength: "normal" } };
const W_EKICHIKA: WrittenWants = { ...W_FULL, walkText: { max: 10, strength: "normal" } };
const FULL = ["RENT_OK", "ZERO_ZERO_MATCH", "FLOOR_PLAN_MATCH", "WALK_OK", "BUILDING_AGE_TEXT_OK", "AREA_STATION_MATCH", "EQUIP_BATH_TOILET_OK", "MOVE_IN_OK"];
const swap = (from: string, to: string) => FULL.map((c) => (c === from ? to : c));
type Ex = { id: string; say: string; w: WrittenWants; hi: Cand; lo: Cand; want: ">" | ">=" | "~<="; b: [number, number] };
const EXAMPLES: Ex[] = [
  { id: "a1", say: "(a) 全条件一致・AD 1ヶ月 ＞ 築浅の希望だけ外れ（築18年）・AD 2ヶ月", w: W_FULL, hi: mk("全一致 AD1", FULL, 1), lo: mk("築18 AD2", swap("BUILDING_AGE_TEXT_OK", "BUILDING_AGE_TEXT_OVER"), 2, { age: 18 }), want: ">", b: [166, 150] },
  { id: "a2", say: "(a) 全条件一致・AD 1ヶ月 ＞ 徒歩だけ少し超え（14分）・AD 2ヶ月", w: W_FULL, hi: mk("全一致 AD1", FULL, 1), lo: mk("徒歩14 AD2", swap("WALK_OK", "WALK_SLIGHTLY_OVER"), 2, { walk: 14 }), want: ">", b: [166, 146] },
  { id: "a3", say: "(a) 全条件一致・AD 1ヶ月 ＞ エリアだけ離れ（4km超）・AD 2ヶ月", w: W_FULL, hi: mk("全一致 AD1", FULL, 1), lo: mk("エリア外れ AD2", swap("AREA_STATION_MATCH", "AREA_FAR"), 2), want: ">", b: [166, 148] },
  { id: "a4", say: "(a) 全条件一致・AD 1ヶ月 ＞ 家賃だけ少し超え（上限＋1万円以内・幅の外）・AD 2ヶ月", w: W_FULL, hi: mk("全一致 AD1", FULL, 1), lo: mk("家賃少し超え AD2", swap("RENT_OK", "RENT_SLIGHTLY_OVER"), 2, { rentRatio: 1.08 }), want: ">", b: [166, 146] },
  { id: "a5", say: "(a) 全条件一致・AD 1ヶ月 ＞ 築浅外れ・AD 3ヶ月＋フリーレント（野口さんの形）", w: W_FULL, hi: mk("全一致 AD1", FULL, 1), lo: mk("築18 AD3 FR", [...swap("BUILDING_AGE_TEXT_OK", "BUILDING_AGE_TEXT_OVER"), "FREE_RENT_MATCH"], 3, { age: 18 }), want: ">", b: [166, 153] },
  { id: "b", say: "(b) 全条件一致・AD 2ヶ月 ＞ 全条件一致・AD 1ヶ月（利益）", w: W_FULL, hi: mk("全一致 AD2", FULL, 2), lo: mk("全一致 AD1", FULL, 1), want: ">", b: [171, 166] },
  { id: "b2", say: "(b) 全条件一致・AD 1.5ヶ月 ＞ 全条件一致・AD 1ヶ月", w: W_FULL, hi: mk("全一致 AD1.5", FULL, 1.5), lo: mk("全一致 AD1", FULL, 1), want: ">", b: [168, 166] },
  { id: "c1", say: "(c) 築浅だけ外れ・AD 1ヶ月 ≧ 全条件一致・AD 0.5ヶ月（同じくらいか下）", w: W_FULL, hi: mk("築18 AD1", swap("BUILDING_AGE_TEXT_OK", "BUILDING_AGE_TEXT_OVER"), 1, { age: 18 }), lo: mk("全一致 AD0.5", FULL, 0.5), want: "~<=", b: [145, 143] },
  { id: "c2", say: "(c) 徒歩だけ少し超え・AD 1ヶ月 ≧ 全条件一致・AD 0.5ヶ月（同じくらいか下）", w: W_FULL, hi: mk("徒歩14 AD1", swap("WALK_OK", "WALK_SLIGHTLY_OVER"), 1, { walk: 14 }), lo: mk("全一致 AD0.5", FULL, 0.5), want: "~<=", b: [141, 143] },
  { id: "c3", say: "(c) 隣の駅（幅の内側）・AD 1ヶ月 ≧ 全条件一致・AD 0.5ヶ月", w: W_FULL, hi: mk("隣の駅 AD1", swap("AREA_STATION_MATCH", "AREA_STATION_WIDE"), 1), lo: mk("全一致 AD0.5", FULL, 0.5), want: "~<=", b: [164, 143] },
  { id: "d", say: "(d) 必須のオートロック × ・AD 3ヶ月 は 全条件一致・AD なし より下", w: W_FULL, hi: mk("全一致 ADなし", FULL, 0), lo: mk("必須× AD3", [...FULL, "EQUIP_AUTOLOCK_NG", EQUIP_CAP_CODE], 3), want: ">", b: [141, 20] },
  { id: "d2", say: "(d) 家賃1割超え（保留）・AD 3ヶ月 は 全条件一致・AD 1未満 より下", w: W_FULL, hi: mk("全一致 AD0.5", FULL, 0.5), lo: mk("家賃超え AD3", swap("RENT_OK", "RENT_OVER_110"), 3), want: ">", b: [143, 101] },
  { id: "e", say: "(e) AD 順: AD 1ヶ月未満 ＞ AD なし（同じ物件）", w: W_FULL, hi: mk("AD0.5", FULL, 0.5), lo: mk("ADなし", FULL, 0), want: ">=", b: [143, 141] },
  { id: "e2", say: "(e) AD 順: AD 1ヶ月 ＞ AD 1ヶ月未満（同じ物件）", w: W_FULL, hi: mk("AD1", FULL, 1), lo: mk("AD0.5", FULL, 0.5), want: ">", b: [166, 143] },
  { id: "e3", say: "(e) AD 不明（読めない）は下げない: AD 不明 ＞ AD 1ヶ月未満", w: W_FULL, hi: mk("AD不明", FULL, null), lo: mk("AD0.5", FULL, 0.5), want: ">", b: [151, 143] },
  { id: "f1", say: "(f) 築浅を書いた人: 築5年・AD 1ヶ月 ＞ 築9年・AD 1.5ヶ月（段で新しい方）", w: W_FULL, hi: mk("築5 AD1", FULL, 1, { age: 5 }), lo: mk("築9 AD1.5", FULL, 1.5, { age: 9 }), want: ">", b: [170, 168] },
  { id: "f2", say: "(f) 築年を書いていない人: 築18年・AD 2ヶ月 ＞ 築5年・AD 1ヶ月（書いていない条件で AD を覆さない）", w: W_PLAIN, hi: mk("築18 AD2", ["RENT_OK", "FLOOR_PLAN_MATCH", "WALK_OK"], 2, { age: 18 }), lo: mk("築5 AD1", ["RENT_OK", "FLOOR_PLAN_MATCH", "WALK_OK"], 1, { age: 5 }), want: ">", b: [125, 123] },
  { id: "g1", say: "(g) 家賃を低くしたい人: 上限の0.8・AD 1ヶ月 ＞ 上限の0.98・AD 1.5ヶ月", w: W_CHEAP, hi: mk("0.8 AD1", FULL, 1, { rentRatio: 0.8 }), lo: mk("0.98 AD1.5", FULL, 1.5, { rentRatio: 0.98 }), want: ">", b: [174, 168] },
  { id: "g2", say: "(g) 家賃を書いていない人: 上限の0.98・AD 1.5ヶ月 ＞ 上限の0.8・AD 1ヶ月", w: W_FULL, hi: mk("0.98 AD1.5", FULL, 1.5, { rentRatio: 0.98 }), lo: mk("0.8 AD1", FULL, 1, { rentRatio: 0.8 }), want: ">", b: [168, 166] },
  { id: "h1", say: "(h) 敷礼0を書いた人: 敷礼0・AD 1ヶ月 ＞ 敷礼あり（保留）・AD 2ヶ月", w: W_FULL, hi: mk("敷礼0 AD1", FULL, 1), lo: mk("敷礼あり AD2", swap("ZERO_ZERO_MATCH", "INITIAL_COST_NOT_ZERO"), 2), want: ">", b: [166, 101] },
  { id: "h2", say: "(h) 敷礼0を書いていない人: 敷礼あり・AD 2ヶ月 ≧ 敷礼0・AD 1ヶ月（AD の差が勝つか同じくらい）", w: W_PLAIN, hi: mk("敷礼あり AD2", ["RENT_OK", "FLOOR_PLAN_MATCH", "WALK_OK"], 2), lo: mk("敷礼0 AD1", ["RENT_OK", "FLOOR_PLAN_MATCH", "WALK_OK", "ZERO_ZERO"], 1), want: "~<=", b: [126, 129] },
  { id: "i", say: "(i) 駅近を書いた人: 徒歩3分・AD 1ヶ月 ＞ 徒歩9分・AD 1.5ヶ月", w: W_EKICHIKA, hi: mk("徒歩3 AD1", FULL, 1, { walk: 3 }), lo: mk("徒歩9 AD1.5", FULL, 1.5, { walk: 9 }), want: ">", b: [171, 168] },
  { id: "i2", say: "(i) 駅近を書いていない人: 徒歩9分・AD 1.5ヶ月 ＞ 徒歩3分・AD 1ヶ月", w: W_FULL, hi: mk("徒歩9 AD1.5", FULL, 1.5, { walk: 9 }), lo: mk("徒歩3 AD1", FULL, 1, { walk: 3 }), want: ">", b: [168, 166] },
  { id: "j", say: "(j) 設備: 必須の設備○・AD 1ヶ月 と 普通の設備○だけ・AD 1ヶ月 → 必須の方が上", w: W_FULL, hi: mk("必須○", [...FULL, "EQUIP_AUTOLOCK_MUST_OK"], 1), lo: mk("普通○のみ", FULL, 1), want: ">", b: [171, 166] },
  { id: "k", say: "(k) 隣の駅だから大幅に下げない: 希望の駅・AD 1ヶ月 と 隣の駅・AD 1ヶ月 の差が 5点以内", w: W_FULL, hi: mk("希望の駅 AD1", FULL, 1), lo: mk("隣の駅 AD1", swap("AREA_STATION_MATCH", "AREA_STATION_WIDE"), 1), want: "~<=", b: [166, 164] },
];

console.log("■ 例の25問（案B・本番の純関数で点を出す）");
t("例は25問", EXAMPLES.length === 25, EXAMPLES.length);
for (const ex of EXAMPLES) {
  const a = score(ex.hi, ex.w), b = score(ex.lo, ex.w);
  const ok = ex.want === ">" ? a.score > b.score : ex.want === ">=" ? a.score >= b.score : ex.id === "k" ? a.score - b.score <= 5 : a.score >= b.score - 5;
  t(`${ex.id} ${ex.say}: ${a.score} vs ${b.score}`, ok, { hi: a.codes, lo: b.codes });
  t(`${ex.id} 点が audit の案B と同じ（${ex.b[0]} vs ${ex.b[1]}）`, a.score === ex.b[0] && b.score === ex.b[1], { got: [a.score, b.score], hi: a.codes, lo: b.codes });
}

console.log("■ 札の点（案B の数字）");
{
  const P = REASON_POINTS;
  t("築年（書いた人）5年 +12・10年 +8・15年 +3・超 −3", P.AGE_W5 === 12 && P.AGE_W10 === 8 && P.AGE_W15 === 3 && P.AGE_W_OLD === -3);
  t("築年（書いていない人）5年 +3・10年 +1", P.AGE_N5 === 3 && P.AGE_N10 === 1);
  t("築年の列の人: 希望内 +5 に上乗せで 5年 12・10年 8（案の max(5, 段)）", P.BUILDING_AGE_OK + P.AGE_COL_W5 === 12 && P.BUILDING_AGE_OK + P.AGE_COL_W10 === 8);
  t("駅近（書いた人）5分 +5・7分 +2・書いていない人 5分 +2", P.WALK_NEAR_W5 === 5 && P.WALK_NEAR_W7 === 2 && P.WALK_NEAR_N === 2);
  t("家賃を低くしたい人 0.8 +8・0.9 +5・0.95 +2", P.RENT_CHEAP_W80 === 8 && P.RENT_CHEAP_W90 === 5 && P.RENT_CHEAP_W95 === 2);
  t("敷礼0 書いた +20・推した +14・書いていない +8", P.ZERO_ZERO_MATCH === 20 && P.ZERO_ZERO_INFERRED === 14 && P.ZERO_ZERO === 8);
  t("強さの倍率: 必須 ×1.3・できれば ×0.6（丸め）", P.AGE_W5_MUST === Math.round(12 * 1.3) && P.AGE_W5_SOFT === Math.round(12 * 0.6) && P.WALK_NEAR_W5_MUST === Math.round(5 * 1.3) && P.RENT_CHEAP_W90_MUST === Math.round(5 * 1.3) && P.RENT_CHEAP_W80_SOFT === Math.round(8 * 0.6));
  t("設備 ○ 必須 +5・普通 +3・できれば +2", reasonPoints("EQUIP_AUTOLOCK_MUST_OK") === 5 && reasonPoints("EQUIP_AUTOLOCK_OK") === 3 && reasonPoints("EQUIP_AUTOLOCK_SOFT_OK") === 2);
  t("全部合う +15（半分 +8）・1つだけ外れ +5（半分 +3）", P.FIT_ALL === 15 && P.FIT_ALL_HALF === 8 && P.FIT_ONE_MISS === 5 && P.FIT_ONE_MISS_HALF === 3);
  t("AD なし −10・1ヶ月未満 −8・不明 0・1ヶ月 +15・1.5ヶ月 +17・2ヶ月 +20", P.AD_NONE === -10 && P.AD_UNDER_1M === -8 && P.AD_UNKNOWN === 0 && P.AD_1M === 15 && P.AD_1M + P.AD_1_5M === 17 && P.AD_HIGH === 20);
  const NEW = Object.keys(P).filter((c) => /^(?:AGE_|WALK_NEAR|WALK_TEXT|RENT_CHEAP|FIT_|AD_UNDER_1M|ZERO_ZERO_INFERRED)/.test(c));
  t(`新しい札は全部 日本語がある（${NEW.length}札）`, NEW.every((c) => reasonJa(c) !== c), NEW.filter((c) => reasonJa(c) === c));
  t("新しい札は保留・外す候補にしない", NEW.every((c) => !HOLD_REASON_CODES.has(c) && !DROP_REASON_CODES.has(c)));
  t("設備の強さの札の日本語「オートロック（必須）○（資料）」", reasonJa("EQUIP_AUTOLOCK_MUST_OK") === "オートロック（必須）○（資料）", reasonJa("EQUIP_AUTOLOCK_MUST_OK"));
  t("学習: FIT_* と AD_UNDER_1M・AD_NONE は動かさない（凍結）", isFrozenCode("FIT_ALL") && isFrozenCode("FIT_ONE_MISS_HALF") && isFrozenCode("AD_UNDER_1M") && isFrozenCode("AD_NONE"));
  t("学習: 書いた条件の重み（AGE_W5 等）は学ぶ札", !isFrozenCode("AGE_W5") && !isFrozenCode("RENT_CHEAP_W80"));
}

console.log("■ 全部合う・1つだけ外れの数え方");
{
  const s = (codes: string[]) => summarizeFit(codes).code;
  t("3つ全部 ○ → FIT_ALL", s(["RENT_OK", "FLOOR_PLAN_MATCH", "WALK_OK"]) === "FIT_ALL");
  t("2つだけ → 半分（FIT_ALL_HALF）", s(["RENT_OK", "FLOOR_PLAN_MATCH"]) === "FIT_ALL_HALF");
  t("1つだけ → 付けない", s(["RENT_OK"]) === null);
  t("幅の内側（隣の駅・家賃の幅）は外れに数えない", s(["RENT_WIDE", "FLOOR_PLAN_MATCH", "AREA_STATION_WIDE"]) === "FIT_ALL");
  t("1つ外れ → FIT_ONE_MISS・2つ外れ → 付けない", s(["RENT_OK", "FLOOR_PLAN_MATCH", "WALK_SLIGHTLY_OVER"]) === "FIT_ONE_MISS" && s(["RENT_SLIGHTLY_OVER", "FLOOR_PLAN_MATCH", "WALK_SLIGHTLY_OVER"]) === null);
  t("読めない・要確認は数えない（○2つ＋要確認2つ → 半分）", s(["RENT_OK", "FLOOR_PLAN_MATCH", "SQM_UNKNOWN", "EQUIP_DELIVERY_BOX_UNLISTED"]) === "FIT_ALL_HALF");
  t("保留の物件には付けない", s(["RENT_OK", "FLOOR_PLAN_MATCH", "WALK_OK", "INITIAL_COST_NOT_ZERO"]) === null);
  t("推しただけの敷礼0（ZERO_ZERO_INFERRED）・書いていない敷礼0 は数えない", summarizeFit(["RENT_OK", "ZERO_ZERO_INFERRED", "ZERO_ZERO"]).n === 1);
  t("付け直しで前の FIT_* を消す（同じ札を2つ持たない）", JSON.stringify(settleFitBonus(["RENT_OK", "FLOOR_PLAN_MATCH", "WALK_OK", "FIT_ONE_MISS"])) === JSON.stringify(["RENT_OK", "FLOOR_PLAN_MATCH", "WALK_OK", "FIT_ALL"]));
  t("強さの付いた設備の ○ も「設備」の合う", fitVerdictOf("EQUIP_AUTOLOCK_MUST_OK")?.v === "ok" && fitVerdictOf("EQUIP_AUTOLOCK_SOFT_OK")?.v === "ok" && fitVerdictOf(EQUIP_CAP_CODE) === null);
}

console.log("■ 書いた条件の読み取り（readWrittenWants）");
{
  const P0: { rentMax: number | null; walkMax: number | null; buildingAgeMax: number | null; ageTextMax: { years: number; word: string } | null } = { rentMax: 80_000, walkMax: null, buildingAgeMax: null, ageTextMax: null };
  const r = (preferences: string, p: Partial<typeof P0> = {}) => readWrittenWants({ preferences }, { ...P0, ...p });
  t("「駅近希望」→ 駅近（普通・10分）", r("駅近希望").walkText?.strength === "normal" && r("駅近希望").walkText?.max === 10);
  t("「駅徒歩5分以内必須」→ 駅近（必須・5分）", r("駅徒歩5分以内必須").walkText?.strength === "strong" && r("駅徒歩5分以内必須").walkText?.max === 5);
  t("「できれば駅近」→ できれば", r("できれば駅近").walkText?.strength === "soft");
  t("徒歩の列があれば max は列（7分）", r("駅近", { walkMax: 7 }).walkText?.max === 7);
  t("「家賃は低い方が良い」→ 家賃を低くしたい", r("家賃は低い方が良い").rentCheap != null);
  t("「初期費用はできるだけ安い方が良い」は家賃の安さではない", r("初期費用はできるだけ安い方が良い").rentCheap == null);
  t("「家賃の値下げ交渉をしたい」は家賃の安さではない", r("家賃の値下げ交渉をしたい").rentCheap == null);
  t("「安い方が良い」（家賃の語なし）は読まない", r("安い方が良い").rentCheap == null);
  // 2026-09-25 全お客様の条件欄で見つけた読み違い（実物の文）
  t("「初期費用・家賃はできるだけ安いほうが良い」→ 家賃を低くしたい（旧は「初期」で落としていた）", r("初期費用・家賃はできるだけ安いほうが良い").rentCheap != null);
  t("「場所を変えると家賃や初期費用が安くなる物件があるか確認したい」は読まない（家賃と安さの間に初期）", r("場所を変えると家賃や初期費用が安くなる物件があるか確認したい").rentCheap == null);
  t("「家賃と間取りを下げると初期費用が安くなるか相談したい」は読まない（相談）", r("家賃と間取りを下げると初期費用が安くなるか相談したい").rentCheap == null);
  t("「姫路駅近」は駅の名前＋近く（場所）で駅近の希望ではない", r("姫路駅近").walkText == null);
  t("「できるだけ駅近」「希望: 駅近」は読む", r("できるだけ駅近").walkText != null && r("希望: 駅近").walkText != null);
  t("家賃の上限が無い人は家賃の安さを付けない", r("家賃は低い方が良い", { rentMax: null }).rentCheap == null);
  t("築浅（自由文）→ ageText・強さ", r("築浅必須", { ageTextMax: { years: 10, word: "築浅" } }).ageText?.strength === "strong");
  t("築年の列がある人は ageColumn（自由文の段は付けない）", (() => { const w = r("築浅", { buildingAgeMax: 15, ageTextMax: null }); return w.ageColumn && w.ageText == null; })());
}

console.log("■ judgeProperty を通した確かめ");
const today = "2026-09-25";
const J = (summary: string, cust: Record<string, unknown>, opts: Parameters<typeof judgeProperty>[3] = {}, patterns: Array<{ selling_points: string[]; selection_label: string }> = []) =>
  judgeProperty(parsePropertyFacts(summary), buildCustomerProfile(cust, [], patterns, null, { today }), 0, opts);
const sum50 = (codes: string[]) => BASE_SCORE + codes.reduce((a, c) => a + reasonPoints(c), 0);
{
  const cust = { rent_max: 80_000, floor_plan: "1LDK", walk_minutes: 10, preferences: "駅近希望・築浅・家賃は低い方が良い・敷金礼金0" };
  const a = J("【1】A 101\n62,000円\n1LDK\n敷なし 礼なし\n○○駅 徒歩4分\n築3年\nAD 1ヶ月", cust);
  t("駅近（書いた）＋徒歩4分 → WALK_NEAR_W5", a.reasonCodes.includes("WALK_NEAR_W5"), a.reasonCodes);
  t("家賃 62,000/80,000（0.78）→ RENT_CHEAP_W80", a.reasonCodes.includes("RENT_CHEAP_W80"), a.reasonCodes);
  t("築浅（自由文）＋築3年 → AGE_W5・BUILDING_AGE_TEXT_OK（0点）", a.reasonCodes.includes("AGE_W5") && a.reasonCodes.includes("BUILDING_AGE_TEXT_OK"), a.reasonCodes);
  t("敷礼0（書いた）→ ZERO_ZERO_MATCH +20", a.reasonCodes.includes("ZERO_ZERO_MATCH"));
  t("書いた条件に全部合う → FIT_ALL", a.reasonCodes.includes("FIT_ALL"), a.reasonCodes);
  t("50＋札の点の合計＝点", sum50(a.reasonCodes) === a.score || (a.score === SCORE_MAX && sum50(a.reasonCodes) >= SCORE_MAX), [a.score, sum50(a.reasonCodes)]);
  const b = J("【2】B 202\n78,000円\n1LDK\n敷なし 礼なし\n○○駅 徒歩9分\n築18年\nAD 2ヶ月", cust);
  t("家賃 0.975 → 家賃の安さの札なし", !b.reasonCodes.some((c) => c.startsWith("RENT_CHEAP")), b.reasonCodes);
  t("築18年 → AGE_W_OLD −3・築浅の外れ1つ → FIT_ONE_MISS", b.reasonCodes.includes("AGE_W_OLD") && b.reasonCodes.includes("FIT_ONE_MISS"), b.reasonCodes);
  t("書いた条件に全部合う・AD 1ヶ月（a）＞ 築浅だけ外れ・AD 2ヶ月（b）", a.score > b.score, [a.score, b.score]);

  const plain = { rent_max: 80_000, floor_plan: "1LDK", walk_minutes: 10 };
  const c = J("【3】C 101\n62,000円\n1LDK\n敷なし 礼なし\n○○駅 徒歩4分\n築3年\nAD 1ヶ月", plain);
  t("書いていない人: 駅近・家賃の安さの重みは付かない（徒歩の列だけ）", !c.reasonCodes.some((x) => /^(WALK_NEAR|RENT_CHEAP)/.test(x)), c.reasonCodes);
  t("書いていない人: 築3年 → AGE_N5 +3・敷礼0 → ZERO_ZERO +8", c.reasonCodes.includes("AGE_N5") && c.reasonCodes.includes("ZERO_ZERO"), c.reasonCodes);

  const noWalkCol = { rent_max: 80_000, floor_plan: "1LDK", preferences: "駅近がいい" };
  const d = J("【4】D 101\n70,000円\n1LDK\n敷1ヶ月 礼なし\n○○駅 徒歩13分\nAD 1ヶ月", noWalkCol);
  t("徒歩の列が空・駅近を書いた人: 徒歩13分 → WALK_TEXT_OVER −3（保留にしない）", d.reasonCodes.includes("WALK_TEXT_OVER") && d.verdict !== "hold", d.reasonCodes);
  const d2 = J("【5】E 101\n70,000円\n1LDK\n敷1ヶ月 礼なし\n○○駅 徒歩6分\nAD 1ヶ月", noWalkCol);
  t("徒歩の列が空・駅近を書いた人: 徒歩6分 → WALK_NEAR_W7＋WALK_TEXT_OK", d2.reasonCodes.includes("WALK_NEAR_W7") && d2.reasonCodes.includes("WALK_TEXT_OK"), d2.reasonCodes);

  const e = J("【6】F 101\n70,000円\n1LDK\n敷なし 礼なし\n○○駅 徒歩6分\nAD なし", plain);
  t("AD なし −10（＋利益が出ない −10 保留）", e.reasonCodes.includes("AD_NONE") && reasonPoints("AD_NONE") === -10, e.reasonCodes);
  const f = J("【7】G 101\n70,000円\n1LDK\n敷なし 礼なし\n○○駅 徒歩6分\nAD 0.5ヶ月", plain, {}, []);
  t("AD 0.5ヶ月・家賃あり → 利益が出ない（保留）。AD_UNDER_1M は重ねない", f.reasonCodes.includes("PROFIT_NEGATIVE") && !f.reasonCodes.includes("AD_UNDER_1M"), f.reasonCodes);
  const g = J("【8】H 101\n1LDK\n敷なし 礼なし\n○○駅 徒歩6分\nAD 0.5ヶ月", plain);
  t("AD 0.5ヶ月・家賃が読めない → AD_UNDER_1M −8", g.reasonCodes.includes("AD_UNDER_1M"), g.reasonCodes);
  const g1 = J("【9】I 101\n1LDK\nAD 1ヶ月", plain);
  t("AD 1ヶ月 → AD_UNDER_1M を付けない", !g1.reasonCodes.includes("AD_UNDER_1M"), g1.reasonCodes);

  // 送った物件から推した敷礼0（選定パターンの過半が「敷礼0円」）
  const hist = [1, 2, 3].map(() => ({ selling_points: ["敷礼0円"], selection_label: "selected" }));
  const h = J("【10】J 101\n70,000円\n1LDK\n敷なし 礼なし\nAD 1ヶ月", plain, {}, hist);
  t("推した敷礼0 → ZERO_ZERO_INFERRED +14（全部合うの数に入れない）", h.reasonCodes.includes("ZERO_ZERO_INFERRED") && !h.reasonCodes.includes("ZERO_ZERO_MATCH"), h.reasonCodes);
}

console.log("■ 設備の強さ・画像の × で全部合うが外れる・設備の付け直し");
{
  const mkMatch = (rows: Array<{ key: string; strong?: boolean; soft?: boolean; result: "ok" | "ng" | "unlisted" }>): EquipmentMatch => ({
    rows: rows.map((r) => ({ want: { key: r.key, mode: "must", strong: !!r.strong, soft: !!r.soft, text: r.key, field: "preferences" }, label: r.key, result: r.result, mark: r.result === "ok" ? "○" : r.result === "ng" ? "×" : "－", why: "" })) as unknown as EquipmentMatch["rows"],
    ok: rows.filter((r) => r.result === "ok").length, ng: rows.filter((r) => r.result === "ng").length, unlisted: rows.filter((r) => r.result === "unlisted").length,
    strongNg: rows.some((r) => r.result === "ng" && r.strong),
  });
  const codes = equipmentReasonCodes(mkMatch([{ key: "autolock", strong: true, result: "ok" }, { key: "delivery_box", result: "ok" }, { key: "bath_dryer", soft: true, result: "ok" }]));
  t("必須 ○ → _MUST_OK・普通 ○ → _OK・できれば ○ → _SOFT_OK", JSON.stringify(codes) === JSON.stringify(["EQUIP_AUTOLOCK_MUST_OK", "EQUIP_DELIVERY_BOX_OK", "EQUIP_BATH_DRYER_SOFT_OK"]), codes);
  const many = equipmentReasonCodes(mkMatch(["autolock", "delivery_box", "bath_dryer", "washbasin"].map((k) => ({ key: k, strong: true, result: "ok" as const }))));
  t("○ の合計は +15 まで（必須 5×3 の後は _OK_MAX）", many.filter((c) => c.endsWith("_MUST_OK")).length === 3 && many[3] === "EQUIP_WASHBASIN_OK_MAX", many);

  const cust = { rent_max: 80_000, floor_plan: "1LDK", walk_minutes: 10, preferences: "バストイレ別" };
  const j = J("【1】A 101\n70,000円\n1LDK\n敷なし 礼なし\n○○駅 徒歩4分\nAD 1ヶ月", cust);
  t("画像で確かめる前は全部合う（家賃・間取り・徒歩）", j.reasonCodes.includes("FIT_ALL"), j.reasonCodes);
  const ji = applyImageFacts(j, { bath_toilet_separate: false });
  t("画像の × で保留 → 全部合うが外れる", !ji.reasonCodes.some((c) => c.startsWith("FIT_")) && ji.verdict === "hold", ji.reasonCodes);
  // 2026-09-25 バス・トイレ別の希望は必須の扱い → 画像の × で上限20の印が付く（点＝min(50＋合計, 20)）
  t("画像のバス・トイレ一緒 → 上限20（50＋札の点の合計と20の小さい方）", ji.reasonCodes.includes(EQUIP_CAP_CODE) && ji.score === Math.min(20, sum50(ji.reasonCodes)), [ji.score, sum50(ji.reasonCodes), ji.reasonCodes]);
  const jo = applyImageFacts(j, { bath_toilet_separate: true });
  t("画像の ○ → 全部合うのまま（4つ）", jo.reasonCodes.includes("FIT_ALL") && summarizeFit(jo.reasonCodes).n === 4, jo.reasonCodes);
  const je = applyEquipmentMatch(j, mkMatch([{ key: "autolock", strong: true, result: "ng" }]));
  t("設備の付け直しで必須 × → 全部合うが外れて上限20", !je.reasonCodes.some((c) => c.startsWith("FIT_")) && je.score <= 20, je);
  const jk = applyEquipmentMatch(j, mkMatch([{ key: "autolock", strong: true, result: "ok" }]));
  t("設備の付け直しで必須 ○ → +5・全部合う", jk.reasonCodes.includes("EQUIP_AUTOLOCK_MUST_OK") && jk.reasonCodes.includes("FIT_ALL") && jk.score === Math.min(SCORE_MAX, sum50(jk.reasonCodes)), jk.reasonCodes);
}

// ── 2026-09-25 竹内「バストイレ別希望していたら、一緒の場合はかなり減点。他に物件があれば入れないレベル（NG）」 ──
console.log("■ 例題: バス・トイレ別の希望に バス・トイレ一緒 → 他のどの物件より下");
{
  const cust = { rent_max: 70_000, floor_plan: "1K", walk_minutes: 10, preferences: "バストイレ別" };
  const good = J("【1】A 201\n60,000円\n1K 25㎡\n敷なし 礼なし\n○○駅 徒歩4分\nAD 2ヶ月", cust);
  const bt = applyImageFacts(good, { bath_toilet_separate: false });
  const weak = J("【2】B 102\n69,000円\n1K 20㎡\n○○駅 徒歩10分\nAD なし", cust);
  t("一緒の方は上限20・保留", bt.score <= 20 && bt.verdict === "hold" && bt.reasonCodes.includes(EQUIP_CAP_CODE), [bt.score, bt.verdict]);
  t("家賃・徒歩・AD が良くても、条件ぎりぎり・AD なしの物件より下", bt.score < weak.score, [bt.score, weak.score]);
  t("記載なし（－）は減点しない（書いていない＝一緒とは限らない）", !weak.reasonCodes.includes(EQUIP_CAP_CODE), weak.reasonCodes);
  const softJ = J("【1】A 201\n60,000円\n1K 25㎡\n○○駅 徒歩4分\nAD 2ヶ月", { ...cust, preferences: "できればバストイレ別" });
  t("「できればバストイレ別」は普通の希望のまま（上限20にしない）", !applyImageFacts(softJ, { bath_toilet_separate: false }).reasonCodes.includes(EQUIP_CAP_CODE));
}

// ── 条件の要約が点と同じ読み方か（YUMA テスト 2026-09-25: 「築浅は必須」が「できれば 築浅」・駅近／家賃を低く が要約に無かった） ──
console.log("■ 条件の要約（condition-summary）も書いた条件の強さで出す");
{
  const line = (preferences: string, extra: Record<string, unknown> = {}) => formatSummaryLine(buildConditionSummary({ rent_max: 85000, floor_plan: "1K", preferences, ...extra }).items);
  const g = line("築浅は必須です。できれば駅近");
  t("築浅は必須 → 築年は本命・［必須］", /築年 築浅（10年以内の目安）［必須］/.test(g) && !/築年 できれば/.test(g), g);
  t("できれば駅近 → 徒歩 できれば 駅近（目安10分）", /徒歩 できれば 駅近（徒歩10分以内の目安）/.test(g), g);
  const b = line("駅近希望です（駅から徒歩5分以内）");
  t("駅近（徒歩5分以内）→ 徒歩 駅近（徒歩5分以内）", /徒歩 駅近（徒歩5分以内）/.test(b), b);
  const c = line("家賃はできるだけ安く抑えたいです");
  t("家賃を低く → 家賃 8.5万まで・できるだけ安く", /家賃 8\.5万まで・できるだけ安く/.test(c), c);
  const a = line("築浅がいいです。築5年以内が理想");
  t("築浅がいい（普通）→ 本命で出す（できれば にしない）", /築年 築5年以内（5年以内の目安）|築年 築浅/.test(a) && !/築年 できれば/.test(a), a);
  const soft = line("できれば築浅");
  t("できれば築浅 → できれば", /築年 できれば 築浅/.test(soft), soft);
  const col = line("駅近希望", { walk_minutes: 7 });
  t("徒歩の欄がある人は欄の値（駅近は重ねない）", /徒歩 7分以内/.test(col) && !/駅近（/.test(col), col);
  const s = buildConditionSummary({ rent_max: 85000, preferences: "できれば駅近。治安が良い所" });
  t("駅近の節は DeepSeek に回さない（照らしている）", !s.unchecked.some((x) => /駅近/.test(x)) && !s.unread.some((x) => /駅近/.test(x)), s.unchecked);
  const ai = [{ kind: "立地", mode: "soft" as const, label: "駅近", by: "ai" as const }, { kind: "周辺環境", mode: "must" as const, label: "治安が良い", by: "ai" as const }];
  const kept = dropAiCoveredByRule(ai, s);
  t("保存済みの DeepSeek の「立地 駅近」は重ねない・他は残す", kept.length === 1 && kept[0].label === "治安が良い", kept);
  t("駅近を書いていない人の AI 要約はそのまま", dropAiCoveredByRule(ai, buildConditionSummary({ rent_max: 85000, preferences: "治安が良い所" })).length === 2);
}

// ── 2026-09-27 竹内「ピンポイント検索で検索した物件はピンポイントなので加点する」──
//   決め方: 「同じくらいならピンポイントが上（PP）」と「条件にずっと合う広げての物件は下げない（PN）」を例題にして、両方を満たす幅を測った
//   （scripts で 0〜20 を試した: 4〜13 が全問合格・3 以下は PP4 が同点／負け・14 以上は PN3 が同点／負け）。+10 は幅の中ほど。
//   REF（札が全部同じで AD 1ヶ月 vs 2ヶ月）は +5 から「ピンポイント AD 1ヶ月」が上になる＝竹内さんの「ピンポイントなので加点」を AD 1ヶ月の差より重く見る側。
//   ※ 広げての回で「札が全部一致」の物件は、ピンポイントの回に出なかった物（町字・更新日・検索の駅の違い）でまれ
console.log("■ 例題: ピンポイントの加点（SEARCH_PINPOINT）");
{
  const PIN = "SEARCH_PINPOINT";
  const pin = (c: Cand): Cand => ({ ...c, key: `${c.key}(P)`, codes: settleHeldAd([...c.codes, PIN], c.codes.some(isHeldCode)) });
  const NEAR = swap("AREA_STATION_MATCH", "AREA_STATION_WIDE");
  const NEAR_RENT = NEAR.map((c) => (c === "RENT_OK" ? "RENT_WIDE" : c));
  const AGE_MISS = swap("BUILDING_AGE_TEXT_OK", "BUILDING_AGE_TEXT_OVER");
  const WALK_MISS = swap("WALK_OK", "WALK_SLIGHTLY_OVER");
  const PX: Array<{ id: string; say: string; hi: Cand; lo: Cand; b: [number, number] }> = [
    { id: "PP1", say: "札も AD も同じなら ピンポイント ＞ 広げて", hi: pin(mk("全一致 AD1", FULL, 1)), lo: mk("全一致 AD1", FULL, 1), b: [176, 166] },
    { id: "PP2", say: "ピンポイント 全一致・AD 1ヶ月 ＞ 広げて 隣の駅・AD 1ヶ月", hi: pin(mk("全一致 AD1", FULL, 1)), lo: mk("隣の駅 AD1", NEAR, 1), b: [176, 164] },
    { id: "PP3", say: "ピンポイント 全一致・AD 1ヶ月 ＞ 広げて 隣の駅・AD 1.5ヶ月（加点の前は同点）", hi: pin(mk("全一致 AD1", FULL, 1)), lo: mk("隣の駅 AD1.5", NEAR, 1.5), b: [176, 166] },
    { id: "PP4", say: "同じくらい（加点の前の差 3点）なら ピンポイント 全一致・AD 1ヶ月 ＞ 広げて 隣の駅・AD 2ヶ月", hi: pin(mk("全一致 AD1", FULL, 1)), lo: mk("隣の駅 AD2", NEAR, 2), b: [176, 169] },
    { id: "PN1", say: "条件にずっと合う広げては下げない: 広げて 隣の駅・AD 1ヶ月 ＞ ピンポイント 築浅外れ・AD 1ヶ月", hi: mk("隣の駅 AD1", NEAR, 1), lo: pin(mk("築18 AD1", AGE_MISS, 1, { age: 18 })), b: [164, 155] },
    { id: "PN2", say: "広げて 隣の駅・AD 1ヶ月 ＞ ピンポイント 徒歩少し超え・AD 2ヶ月", hi: mk("隣の駅 AD1", NEAR, 1), lo: pin(mk("徒歩14 AD2", WALK_MISS, 2, { walk: 14 })), b: [164, 156] },
    { id: "PN3", say: "広げて 隣の駅・AD 1ヶ月 ＞ ピンポイント 築浅外れ・AD 2ヶ月（一番きわどい・差 4点）", hi: mk("隣の駅 AD1", NEAR, 1), lo: pin(mk("築18 AD2", AGE_MISS, 2, { age: 18 })), b: [164, 160] },
    { id: "PN4", say: "AD 1ヶ月未満はおすすめしにくい: 広げて 隣の駅・AD 1ヶ月 ＞ ピンポイント 全一致・AD 0.5ヶ月", hi: mk("隣の駅 AD1", NEAR, 1), lo: pin(mk("全一致 AD0.5", FULL, 0.5)), b: [164, 153] },
    { id: "PN5", say: "広げて 隣の駅＋家賃の幅・AD 2ヶ月 ＞ ピンポイント 築浅外れ・AD 1ヶ月", hi: mk("隣の駅+家賃幅 AD2", NEAR_RENT, 2), lo: pin(mk("築18 AD1", AGE_MISS, 1, { age: 18 })), b: [164, 155] },
    { id: "PN6", say: "保留のピンポイントは加点しない: 広げて 隣の駅・AD 0.5ヶ月（通す）＞ ピンポイント 家賃1割超え・AD 3ヶ月（保留）", hi: mk("隣の駅 AD0.5", NEAR, 0.5), lo: pin(mk("家賃超え AD3", swap("RENT_OK", "RENT_OVER_110"), 3)), b: [141, 101] },
    { id: "REF", say: "（決めた向き）札が全部同じ: ピンポイント AD 1ヶ月 ＞ 広げて AD 2ヶ月", hi: pin(mk("全一致 AD1", FULL, 1)), lo: mk("全一致 AD2", FULL, 2), b: [176, 171] },
  ];
  for (const ex of PX) {
    const a = score(ex.hi, W_FULL), b = score(ex.lo, W_FULL);
    t(`${ex.id} ${ex.say}: ${a.score} vs ${b.score}`, a.score > b.score, { hi: a.codes, lo: b.codes });
    t(`${ex.id} 点（${ex.b[0]} vs ${ex.b[1]}）`, a.score === ex.b[0] && b.score === ex.b[1], { got: [a.score, b.score] });
  }
  t("ピンポイント +10", REASON_POINTS[PIN] === 10 && reasonPoints(PIN) === 10);
  t("保留の物件のピンポイントは _HELD の 0点（札は残す）", reasonPoints(`${PIN}_HELD`) === 0 && /保留の物件なので点に入れない/.test(reasonJa(`${PIN}_HELD`)), reasonJa(`${PIN}_HELD`));
  t("日本語に 🎯", /🎯 ピンポイント/.test(reasonJa(PIN)));
  t("全部合うの数に入れない（条件の札ではない）", fitVerdictOf(PIN) === null);
  t("学習で動かさない（凍結）", isFrozenCode(PIN) && isFrozenCode(`${PIN}_HELD`));
  t("保留・外す候補にしない", !HOLD_REASON_CODES.has(PIN) && !DROP_REASON_CODES.has(PIN));

  // judgeProperty を通す（売上サポの recordPickupBatch と同じ渡し方）
  const cust = { rent_max: 80_000, floor_plan: "1LDK", walk_minutes: 10 };
  const S = "【1】A 101\n70,000円\n1LDK\n敷なし 礼なし\n○○駅 徒歩4分\nAD 1ヶ月";
  const jp = J(S, cust, { searchMode: "pinpoint" }), jw = J(S, cust, { searchMode: "widen" }), jn = J(S, cust, {});
  t("ピンポイントの回だけ札が付く（広げて・分からないは付けない・減点もしない）", jp.reasonCodes.includes(PIN) && !jw.reasonCodes.some((c) => c.startsWith(PIN)) && !jn.reasonCodes.some((c) => c.startsWith(PIN)), [jp.reasonCodes, jw.reasonCodes]);
  t("点はちょうど +10（広げて＝分からない）", jp.score === jw.score + 10 && jw.score === jn.score, [jp.score, jw.score, jn.score]);
  t("理由の日本語に出る", jp.reasonsJa.some((x) => /🎯/.test(x)), jp.reasonsJa);
  const H = "【2】B 101\n95,000円\n1LDK\n敷なし 礼なし\n○○駅 徒歩4分\nAD 2ヶ月";
  const hp = J(H, cust, { searchMode: "pinpoint" }), hw = J(H, cust, {});
  t("保留（家賃超え）のピンポイントは 0点（点は広げてと同じ）", hp.verdict === "hold" && hp.reasonCodes.includes(`${PIN}_HELD`) && hp.score === hw.score, [hp.verdict, hp.score, hw.score, hp.reasonCodes]);
  // 通す／保留の線（40点）は加点の前の点で見る: 加点で保留が通すに変わらない（自動で広げるかの「通す」の数が検索の種類で変わらない）
  const L = "【3】C 101\n1R\n○○駅 徒歩25分\nAD なし";
  const lw = J(L, { rent_max: 80_000, walk_minutes: 10 }, {}), lp = J(L, { rent_max: 80_000, walk_minutes: 10 }, { searchMode: "pinpoint" });
  t("加点の前 40点未満の物件はピンポイントでも保留のまま", lw.score < 40 && lp.verdict === lw.verdict, [lw.score, lw.verdict, lp.score, lp.verdict, lp.reasonCodes]);
  // 設備の付け直し・画像の × でも札は残り、保留になれば 0点に替わる
  const mkM = (result: "ok" | "ng"): EquipmentMatch => ({ rows: [{ want: { key: "autolock", mode: "must", strong: false, soft: false, text: "autolock", field: "preferences" }, label: "autolock", result, mark: result === "ok" ? "○" : "×", why: "" }] as unknown as EquipmentMatch["rows"], ok: result === "ok" ? 1 : 0, ng: result === "ng" ? 1 : 0, unlisted: 0, strongNg: false });
  const eNg = applyEquipmentMatch(jp, mkM("ng"));
  t("設備の × で保留 → ピンポイントは _HELD", eNg.verdict === "hold" && eNg.reasonCodes.includes(`${PIN}_HELD`) && !eNg.reasonCodes.includes(PIN), eNg.reasonCodes);
  const eOk = applyEquipmentMatch({ reasonCodes: eNg.reasonCodes }, mkM("ok"));
  t("付け直しで保留が消えたら +10 に戻る", eOk.verdict === "pass" && eOk.reasonCodes.includes(PIN), eOk.reasonCodes);
  const iNg = applyImageFacts(J("【4】D 101\n70,000円\n1LDK\n敷なし 礼なし\n○○駅 徒歩4分\nAD 1ヶ月", { ...cust, preferences: "独立洗面台" }, { searchMode: "pinpoint" }), { separate_washstand: false });
  t("画像の × で保留 → ピンポイントは _HELD", iNg.verdict === "hold" && iNg.reasonCodes.includes(`${PIN}_HELD`), iNg.reasonCodes);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
