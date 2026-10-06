// 2026-10-06f 竹内さん「築年数古すぎる物件はそもそもお客さんにささりにくい　結局は築年数の浅い物件でお客さん刺さることが多い」のテスト
//   初期費用重視の型（敷礼0・初期費用の希望）だけ・築31年以上・リノベ済みと築年不明は除く・築年の列を書いた人／「古くても良い」と言った人は除く
//   オススメの点（👑）だけで効かせる（判定の点＝束に入れる段は変えない）
// 実行: npx tsx app/lib/__tests__/old-building-age.test.ts
// 行の形は本番の property_pickups（売上サポの束で👑が クーランデール天神橋 築39 → DWELL ASANO 築29＝スタッフの🌟 になった回の形）。お客様の情報は無い
import { ageIndifferentText, oldAgeApplies, oldAgePenalty, oldAgeModeOf, OLD_AGE_RULE } from "../old-building-age";
import { starSituationFromConditions } from "../star-rank-pickup";
import { rankByRecommendScore, RECOMMEND_SCORE_RULE } from "../recommend-score";
import { pickCustomerBest, bestRuleTag, type BestCandidateRow } from "../pickup-best";
import { STAR_FIT_RULE_TAG, starSituationOf, type StarCandidate } from "../recommend-star-rank";
import { reasonPoints } from "../property-brain";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}

console.log("■ 1. 線と点");
{
  t("線は築31年以上・−15", OLD_AGE_RULE.minAge === 31 && OLD_AGE_RULE.points === -15);
  t("築39 → −15", oldAgePenalty({ buildingAge: 39 })?.points === -15);
  t("築31 → −15（線ちょうど）", oldAgePenalty({ buildingAge: 31 })?.points === -15);
  t("築30 → 減点なし（メゾン永田 築30 がスタッフの🌟だった回を残す）", oldAgePenalty({ buildingAge: 30 }) === null);
  t("築年不明 → 減点なし", oldAgePenalty({ buildingAge: null }) === null && oldAgePenalty({}) === null);
  t("リノベ済み → 減点なし", oldAgePenalty({ buildingAge: 45, renovated: true }) === null);
  t("リノベ不明（null）は築年で見る", oldAgePenalty({ buildingAge: 45, renovated: null })?.points === -15);
  t("内訳の言い方", oldAgePenalty({ buildingAge: 40 })?.label === "築31年以上（初期費用重視の方には刺さりにくい）");
  t("スイッチ: off で止める・それ以外は on", oldAgeModeOf("off") === "off" && oldAgeModeOf("OFF ") === "off" && oldAgeModeOf(undefined) === "on" && oldAgeModeOf("on") === "on");
}

console.log("■ 2. 築年を気にしない言い方");
{
  for (const s of ["築年数は気にしないです", "築年数こだわりません", "古くても大丈夫です", "古くてもOK", "古い物件でも大丈夫", "築年不問", "新築じゃなくても大丈夫", "築浅にこだわらない", "築年数　特に気にしません"]) t(`気にしない: ${s}`, ageIndifferentText(s));
  for (const s of ["築浅希望", "できれば新しめ", "初期費用を抑えたい", "古いのは嫌です", "", "築年数は新しい方が良い"]) t(`気にしないではない: 「${s}」`, !ageIndifferentText(s));
}

console.log("■ 3. 効かせるお客様");
{
  t("条件が無い → 効かせない", !oldAgeApplies(null));
  t("初期費用の自由文だけ → 効かせる", oldAgeApplies({ preferences: "初期費用を抑えたい" }));
  t("築年の列を書いた人 → 効かせない（判定の札で見ている）", !oldAgeApplies({ building_age: 20, preferences: "初期費用を抑えたい" }));
  t("築年の列が 0／空 → 書いていない扱い", oldAgeApplies({ building_age: 0 }) && oldAgeApplies({ building_age: null }));
  t("「築年数は気にしない」→ 効かせない", !oldAgeApplies({ other_requests: "敷金礼金なし希望。築年数は気にしないです" }));
  // 状況（型）: 初期費用重視だけ
  const sitZero = starSituationFromConditions({ initial_cost_limit: 200000, preferences: "" }, { oldAgeMode: "on" });
  const sitFree = starSituationFromConditions({ preferences: "バストイレ別" }, { oldAgeMode: "on" });
  const sitZeroOk = starSituationFromConditions({ preferences: "初期費用を抑えたい・古くても大丈夫" }, { oldAgeMode: "on" });
  const sitOff = starSituationFromConditions({ initial_cost_limit: 200000 }, { oldAgeMode: "off" });
  t("初期費用の希望 → oldAgeAvoid", sitZero?.zero === true && sitZero?.oldAgeAvoid === true, sitZero);
  t("初期費用を言っていない → oldAgeAvoid なし（築古でも刺さっている型）", sitFree?.zero === false && !sitFree?.oldAgeAvoid, sitFree);
  t("初期費用＋古くても大丈夫 → なし", sitZeroOk?.zero === true && !sitZeroOk?.oldAgeAvoid, sitZeroOk);
  t("OLD_AGE_MODE=off → なし", sitOff?.zero === true && !sitOff?.oldAgeAvoid);
  t("starSituationOf は既定でなし", starSituationOf({ wantTopics: ["low_initial"] }).oldAgeAvoid === false);
}

console.log("■ 4. オススメの点（👑）");
{
  const cand = (key: string, score: number, age: number | null, o: Partial<StarCandidate> = {}): StarCandidate => ({ key, codes: [], score, pointsOf: reasonPoints, buildingAge: age, adMonths: 2, ...o });
  const sit = starSituationOf({ wantTopics: ["low_initial"], oldAgeAvoid: true });
  const noSit = starSituationOf({ wantTopics: ["low_initial"] });
  // 古い方が判定の点で 10 上（減点 15 で入れ替わる）
  const cs = [cand("クーランデール天神橋", 160, 39), cand("DWELL ASANO", 150, 29)];
  const r1 = rankByRecommendScore(cs, sit);
  const r0 = rankByRecommendScore(cs, noSit);
  t("初期費用重視の方: 築39 より 築29 が👑", r1[0].key === "DWELL ASANO", r1.map((x) => [x.key, x.score]));
  t("内訳に築古の減点が出る", r1.find((x) => x.key === "クーランデール天神橋")!.parts.some((p) => p.points === -15 && /築31年以上/.test(p.label)));
  t("状況が無ければ今まで通り（築39 が👑）", r0[0].key === "クーランデール天神橋");
  t("規則の oldAge を null で止める", rankByRecommendScore(cs, sit, { rule: { ...RECOMMEND_SCORE_RULE, oldAge: null } })[0].key === "クーランデール天神橋");
  // 差が 15 より大きい時は古くても👑（合い方が大きく上なら残す）
  const cs2 = [cand("古いが合う", 180, 45), cand("新しい", 150, 5)];
  t("合い方の差が大きければ古くても👑", rankByRecommendScore(cs2, sit)[0].key === "古いが合う");
  // リノベ済みは減点しない
  const cs3 = [cand("リノベ済み", 160, 40, { renovated: true }), cand("新しめ", 150, 15)];
  t("リノベ済みは減点しない", rankByRecommendScore(cs3, sit)[0].key === "リノベ済み");
  // 築年不明は減点しない
  const cs4 = [cand("築年不明", 160, null), cand("新しめ", 150, 15)];
  t("築年不明は減点しない", rankByRecommendScore(cs4, sit)[0].key === "築年不明");
}

console.log("■ 5. 売上サポの 👑（pickCustomerBest）・版");
{
  const AT = "2026-10-04T03:00:00Z";
  const row = (id: number, name: string, score: number, age: number | null): BestCandidateRow => ({
    id, batch_id: "B1", created_at: AT, rank: id, status: "pending", recommended: 0, property_name: name, room_no: `${id}01`,
    verdict: "pass", score, reason_codes: ["AD_2M"],
    summary_text: `【${id}】${name} ${id}01号室\n70,000円 5,000円\n1K 25㎡\n大阪メトロ堺筋線「天神橋筋六丁目」徒歩5分`,
    ad_yen: null, terms: { buildingAge: age, deposit: 0, keyMoney: 0, evidence: {} }, equipment: { facts: {}, match: [] },
  });
  const rows = [row(1, "クーランデール天神橋", 165, 39), row(2, "DWELL ASANO", 155, 29)];
  const on = pickCustomerBest(rows, { basis: "score", situation: starSituationFromConditions({ initial_cost_limit: 200000 }, { oldAgeMode: "on" }) });
  const off = pickCustomerBest(rows, { basis: "score", situation: starSituationFromConditions({ initial_cost_limit: 200000 }, { oldAgeMode: "off" }) });
  t("初期費用重視の方: 👑 は DWELL ASANO（築29）", on?.id === 2, on);
  t("OLD_AGE_MODE=off: 👑 は今まで通り クーランデール天神橋", off?.id === 1, off);
  t("👑 の点の内訳に築古の減点（落ちた側）は出ない・👑 の点は出る", on?.star_score != null && !(on?.star_score_parts ?? []).some((p) => p.points === -15));
  t("決まりの版は 06f", STAR_FIT_RULE_TAG === "star-fit@2026-10-06f" && bestRuleTag("score") === STAR_FIT_RULE_TAG);
}

console.log(`\n${passed} OK / ${failed} NG`);
if (failed) process.exit(1);
