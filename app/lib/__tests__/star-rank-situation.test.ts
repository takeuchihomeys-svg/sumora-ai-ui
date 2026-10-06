// 2026-10-06b 竹内「お客さんの状況に連動して、評価基準も変動できていればより正確に」— 🌟（👑）の並べ方の状況の足し点のテスト
// 実行: npx tsx app/lib/__tests__/star-rank-situation.test.ts
// 足し点の根拠は scripts/audit-star-rank-situation.ts（244回・スタッフの🌟との1位一致 32%→35%・状況ありだけ当たり 6・なしだけ当たり 0）
import { rankStarCandidates, starSituationOf, STAR_SITUATION_RULE, STAR_RANK_RULE, type StarCandidate } from "../recommend-star-rank";
import { starSituationFromConditions, zeroZeroOfPickup, starCandidateOfPickup, equipmentKeysOf } from "../star-rank-pickup";
import { pickCustomerBest, roundBestId, type BestCandidateRow } from "../pickup-best";
import { savedFactsFromPickup } from "../recommendation-snapshot-server";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
const zeroPts = () => 0;
const cand = (key: string, o: Partial<StarCandidate> = {}): StarCandidate => ({ key, codes: [], score: 100, pointsOf: zeroPts, adMonths: 2, ...o });

// ── 状況の読み ──
{
  const s = starSituationOf({ wantTopics: ["low_initial", "floor2", "bath_toilet", "security"] });
  t("初期費用 → zero・2階以上 → floorHigh・設備の話題 → 設備の鍵", s.zero && s.floorHigh && !s.spacious && s.equipKeys.includes("bath_toilet") && s.equipKeys.includes("autolock"), s);
  t("敷礼0の話題（zero_deposit）も zero", starSituationOf({ wantTopics: ["zero_deposit"] }).zero);
  t("話題が無ければ全部 false", !Object.entries(starSituationOf({})).some(([k, v]) => k !== "equipKeys" && v === true));
}
// 条件欄（本番の列の形）
{
  const a = starSituationFromConditions({ initial_cost_limit: 200000, preferences: "2階以上希望・バストイレ別", ng_points: null, other_requests: null, additional_conditions: null });
  t("条件欄: 初期費用の上限あり → zero・自由文の「2階以上」→ floorHigh", !!a && a.zero && a.floorHigh, a);
  const b = starSituationFromConditions({ preferences: "1階NG", ng_points: null });
  t("条件欄: 「1階NG」も 2階以上の希望", !!b && b.floorHigh && !b.zero, b);
  t("条件が無ければ null（足し点なし）", starSituationFromConditions(null) === null);
}

// ── 並べ方 ──
{
  // 合い方の点が A>B（A は束の中で一番広い）。B だけ敷礼0
  const cs = [cand("A", { areaSqm: 30, zeroZero: false }), cand("B", { areaSqm: 25, zeroZero: true })];
  t("状況なし → 今まで通り（広い A）", rankStarCandidates(cs)[0].key === "A");
  t("初期費用を言っていない → 敷礼0でも足さない", rankStarCandidates(cs, STAR_RANK_RULE, starSituationOf({ wantTopics: ["spacious"] }))[0].key === "A");
  const r = rankStarCandidates(cs, STAR_RANK_RULE, starSituationOf({ wantTopics: ["low_initial"] }));
  t("初期費用を言っている → 敷礼0の +15 は広さの一番 +15 と同じ重さ（同点は元の並び＝A）", r[0].key === "A" && r[0].fit === r[1].fit, r);
  const r2 = rankStarCandidates([cand("A", { areaSqm: 30, zeroZero: false, score: 99 }), cand("B", { areaSqm: 25, zeroZero: true })], STAR_RANK_RULE, starSituationOf({ wantTopics: ["low_initial"] }));
  t("初期費用を言っている＋点が僅差 → 敷礼0の B が一番・理由に出る", r2[0].key === "B" && r2[0].reasons.some((x) => /敷礼0/.test(x)), r2);
  const allZero = rankStarCandidates([cand("A", { areaSqm: 30, zeroZero: true }), cand("B", { areaSqm: 25, zeroZero: true })], STAR_RANK_RULE, starSituationOf({ wantTopics: ["low_initial"] }));
  t("束の全部が敷礼0なら差にしない（理由にも出さない）", allZero[0].key === "A" && !allZero[0].reasons.some((x) => /敷礼0/.test(x)), allZero);
  const fl = rankStarCandidates([cand("A", { floor: 1, score: 105 }), cand("B", { floor: 5 })], STAR_RANK_RULE, starSituationOf({ wantTopics: ["floor2"] }));
  t("2階以上を言っている → 束の中で一番高い階（点が5低くても）", fl[0].key === "B" && fl[0].reasons.some((x) => /一番高い階/.test(x)), fl);
  const fl0 = rankStarCandidates([cand("A", { floor: 1, score: 105 }), cand("B", { floor: 5 })]);
  t("階の希望が無ければ階は見ない", fl0[0].key === "A");
  t("止めた状況（空室・広さ・駅近・築浅・設備）は 0 のまま", STAR_SITUATION_RULE.vacantNow === 0 && STAR_SITUATION_RULE.spacious === 0 && STAR_SITUATION_RULE.stationNear === 0 && STAR_SITUATION_RULE.newBuild === 0 && STAR_SITUATION_RULE.equipEach === 0);
  const adLine = rankStarCandidates([cand("A", { adMonths: 2, score: 100 }), cand("B", { adMonths: 1, zeroZero: true, floor: 5, score: 100 }), cand("C", { adMonths: 2, zeroZero: false, floor: 1, score: 100 })], STAR_RANK_RULE, starSituationOf({ wantTopics: ["low_initial", "floor2"] }));
  t("AD の線の下でも状況で合い方が15以上上なら🌟（内覧を組むのが優先の決まりのまま）", adLine[0].key === "B", adLine);
}

// ── 行（property_pickups の形）→ 候補 ──
{
  t("敷礼0は資料の表（ヶ月）で決める・片方が読めなければ null", zeroZeroOfPickup({ terms: { deposit: 0, keyMoney: 0 } }) === true && zeroZeroOfPickup({ terms: { deposit: 0, keyMoney: 1 } }) === false && zeroZeroOfPickup({ terms: { deposit: 0 } }) === null);
  t("設備の鍵（○だけ・構造等の印は除く）", JSON.stringify(equipmentKeysOf({ facts: { structure: { s: "ok", d: "RC" }, autolock: { s: "ok" }, bath_toilet: { s: "ng" }, pet: { s: "ok" } } })) === JSON.stringify(["autolock"]));
  const c = starCandidateOfPickup({ id: 7, summary_text: "【1】A 101号室\n60,000円 3,000円\n1K 25㎡\n大阪メトロ御堂筋線「本町」徒歩5分", terms: { buildingAge: 10, deposit: 0, keyMoney: 0 }, equipment: { facts: {}, floor: 3 } }, 100);
  t("行 → 候補に敷礼0・階・徒歩", c.zeroZero === true && c.floor === 3 && c.walkMinutes === 5, c);
}

// ── 👑（pickCustomerBest・画面の roundBestId）が同じ状況で同じ答え ──
{
  const AT = "2026-10-06T03:00:00Z";
  const row = (id: number, score: number, dep: number, floor: number): BestCandidateRow => ({
    id, batch_id: "B1", created_at: AT, rank: id, status: "pending", recommended: 0, property_name: `物件${id}`, room_no: `${floor}01`,
    verdict: "pass", score, reason_codes: ["FLOOR_PLAN_MATCH", "AD_HIGH"], ad_yen: null,
    summary_text: `【${id}】物件${id} ${floor}01号室\n60,000円 5,000円\n1K 25㎡\n大阪メトロ御堂筋線「本町」徒歩5分`,
    terms: { buildingAge: 10, deposit: dep, keyMoney: dep, evidence: {} }, equipment: { facts: {}, match: [], floor },
  });
  const rows = [row(1, 110, 1, 1), row(2, 100, 0, 6)];
  const sit = starSituationFromConditions({ initial_cost_limit: 150000, preferences: "2階以上" });
  const noSit = pickCustomerBest(rows, { basis: "score", starMode: "fit" });
  const withSit = pickCustomerBest(rows, { basis: "score", starMode: "fit", situation: sit });
  t("状況なし → 点の高い 1", noSit?.id === 1, noSit);
  t("初期費用＋2階以上を言うお客様 → 敷礼0・6階の 2 が 👑（理由に状況）", withSit?.id === 2 && (withSit?.star_reasons ?? []).some((x) => /敷礼0/.test(x)), withSit);
  t("今までの決め方の記録（legacy_id）は残る", withSit?.legacy_id === 1);
  t("画面の回ごとの一番も同じ状況で同じ答え", roundBestId(rows, "score", null, "fit", sit) === 2 && roundBestId(rows, "score", null, "fit", null) === 1);
  t("STAR_RANK_MODE=off（legacy）なら状況があっても今までの合計の1位", pickCustomerBest(rows, { basis: "score", starMode: "legacy", situation: sit })?.id === 1);
}

// ── 🌟の記録（recommendation_snapshots）に売上サポの保存済みの材料を足す（足りないクエリ）──
{
  const f = savedFactsFromPickup({ reason_codes: ["AD_ASSUMED_AGENT", "AD_HIGH_HELD"], ad_yen: 84000, summary_text: "【1】A\n42,000円\n1K", equipment: { facts: { structure: { s: "ok", d: "鉄骨" } }, floor: 1 }, terms: { buildingAge: 36, deposit: 0, keyMoney: 1 } });
  t("売上サポの行 → AD（札の月数）・構造・階・敷礼・築年", f.ad_months === 2 && f.structure === "鉄骨" && f.floor === 1 && f.deposit_months === 0 && f.key_money_months === 1 && f.building_age === 36, f);
  t("読めない項目は入れない", Object.keys(savedFactsFromPickup({ reason_codes: [], equipment: null, terms: null })).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
