// 2026-10-06 竹内さん（A: 今切り替える）— 👑（一番オススメ＝🌟）を recommend-star-rank の並べ方で決める配線と、戻すスイッチのテスト
// 実行: npx tsx app/lib/__tests__/star-rank-switch.test.ts
// 行の形は本番の property_pickups（2026-10-04 の行の形・説明文・設備欄・資料の表）。お客様の情報は無い
import { pickCustomerBest, roundBestId, bestRuleTag, BEST_RULE_TAG, type BestCandidateRow } from "../pickup-best";
import { rankCompleteGroup } from "../pickup-complete";
import { starRankMode, STAR_FIT_RULE_TAG } from "../recommend-star-rank";
import { adMonthsOfPickup, areaSqmOfPickup, equipmentCountOf, structureOf, equipWantHitsOf, starCandidateOfPickup } from "../star-rank-pickup";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
const AT = "2026-10-06T03:00:00Z";
type Opt = { score: number; codes: string[]; sqm?: number; age?: number; st?: string; verdict?: string; adYen?: number; rent?: number; equipOk?: string[] };
const row = (id: number, o: Opt): BestCandidateRow => ({
  id, batch_id: "B1", created_at: AT, rank: id, status: "pending", recommended: 0, property_name: `物件${id}`, room_no: `${id}01`,
  verdict: o.verdict ?? "pass", score: o.score, reason_codes: o.codes,
  summary_text: `【${id}】物件${id} ${id}01号室\n${(o.rent ?? 60000).toLocaleString("en-US")}円 5,000円\n1K${o.sqm != null ? ` ${o.sqm}㎡` : ""}\n大阪メトロ御堂筋線「本町」徒歩5分`,
  ad_yen: o.adYen ?? null,
  terms: o.age != null ? { buildingAge: o.age, evidence: {} } : null,
  equipment: { facts: { ...(o.st ? { structure: { s: "ok", d: o.st } } : {}), ...Object.fromEntries((o.equipOk ?? []).map((k) => [k, { s: "ok" }])) }, match: [] },
});

// ── スイッチ ──
t("STAR_RANK_MODE 未設定 → fit（新しい決め方が既定）", starRankMode(undefined) === "fit" && starRankMode("") === "fit" && starRankMode("on") === "fit");
t("STAR_RANK_MODE=off → legacy（今までの決め方）", starRankMode("off") === "legacy" && starRankMode(" OFF ") === "legacy" && starRankMode("legacy") === "legacy");
t("決まりの名前: fit は star-fit・legacy は前の名前（まとめの best_id を決め方ごとに分ける）",
  bestRuleTag("score") === STAR_FIT_RULE_TAG && bestRuleTag("score", "legacy") === BEST_RULE_TAG && bestRuleTag("image", "fit") === "image");

// ── 行 → 候補の値 ──
{
  // 本番の行の形（2026-10-04 id 3421: アズ・スタットの 200%とみなす・設備欄の構造 鉄骨・資料の表の築36年）
  const r: BestCandidateRow = {
    id: 3421, batch_id: "B", created_at: AT, rank: 1, status: "pending", recommended: 0, property_name: "ぷりんせす八丁畷B棟", room_no: "103",
    summary_text: "【1】ぷりんせす八丁畷B棟 103号室\n42,000円 6,000円\n1K 21.6㎡\n阪急京都線「高槻市」徒歩8分\nAD 2ヶ月（アズ・スタット・記載なしのため200%とみなす）",
    ad_yen: 84000, reason_codes: ["RENT_UNDER_MIN", "FLOOR_PLAN_NEAR", "AD_ASSUMED_AGENT", "AD_HIGH_HELD", "EQUIP_PET_NG"],
    terms: { buildingAge: 36, evidence: { area: "専有面積21.6m2" } },
    equipment: { facts: { rc: { s: "ng" }, pet: { s: "ng" }, autolock: { s: "ok" }, city_gas: { s: "ok" }, not_wood: { s: "ok" }, structure: { s: "ok", d: "鉄骨" }, bath_toilet: { s: "ok" }, floor2: { s: "ng" } },
      match: [{ result: "ng", mode: "must" }] },
  };
  t("AD は判定の札から（_HELD も同じ月数・200%とみなす＝2）", adMonthsOfPickup(r) === 2);
  t("広さは説明文の㎡", areaSqmOfPickup(r) === 21.6);
  t("広さは説明文に無ければ資料の表の根拠", areaSqmOfPickup({ summary_text: "【1】A\n50,000円\n1K", terms: { evidence: { area: "専有面積２５．５m2" } } }) === 25.5);
  t("構造は設備欄の d（鉄骨）", structureOf(r.equipment) === "鉄骨");
  t("設備の数は ○ だけ・構造／木造でない／ペット等の印は数えない（オートロック・都市ガス・バス・トイレ別＝3）", equipmentCountOf(r.equipment) === 3, equipmentCountOf(r.equipment));
  t("希望の設備に合う数（×は数えない）", equipWantHitsOf(r.equipment) === 0 && equipWantHitsOf({ match: [{ result: "ok", mode: "must" }, { result: "ok", mode: "must" }, { result: "unlisted", mode: "must" }] }) === 2);
  t("AD の札が無ければ ad_yen ÷ 家賃", adMonthsOfPickup({ reason_codes: ["FLOOR_PLAN_MATCH"], ad_yen: 90000, summary_text: "【1】A\n60,000円 3,000円\n1K" }) === 1.5);
  const c = starCandidateOfPickup(r, 12);
  t("候補の key は行の id・築年は資料の表", c.key === "3421" && c.buildingAge === 36 && c.adMonths === 2);
}

// ── 👑 の決め方: 合い方が主軸（AD の点の差で決めない）──
{
  // 合計は AD 2ヶ月（+22）の 1 が上。2 は AD 1.5（+10）だが広い・新しい・RC＝スタッフが🌟にする形（⑰ の調査: 構造 RC 76%・広さ・築年）
  const rows = [
    row(1, { score: 120, codes: ["AD_HIGH", "FLOOR_PLAN_MATCH"], sqm: 20, age: 30, st: "鉄骨" }),
    row(2, { score: 105, codes: ["AD_1_5M", "FLOOR_PLAN_MATCH"], sqm: 28, age: 5, st: "RC" }),
    row(3, { score: 100, codes: ["AD_1_5M"], sqm: 22, age: 15, st: "鉄骨" }),
  ];
  const fit = pickCustomerBest(rows, { basis: "score" });
  const legacy = pickCustomerBest(rows, { basis: "score", starMode: "legacy" });
  t("fit: 合い方の一番（広い・新しい・RC）が 👑", fit?.id === 2, fit);
  t("fit: 今までの決め方なら 1 だった事を残す（legacy_id）", fit?.legacy_id === 1 && fit?.star_mode === "fit" && fit?.rule === STAR_FIT_RULE_TAG);
  t("fit: 理由（束の中で一番広い・一番新しい・RC）", JSON.stringify(fit?.star_reasons) === JSON.stringify(["束の中で一番広い", "束の中で一番新しい", "RC"]), fit?.star_reasons);
  t("legacy（STAR_RANK_MODE=off）: 合計の1位（今まで通り）", legacy?.id === 1 && legacy?.star_mode === "legacy" && legacy?.rule === BEST_RULE_TAG);
  t("roundBestId も同じスイッチ", roundBestId(rows, "score", null) === 2 && roundBestId(rows, "score", null, "legacy") === 1);
  t("roundBestId: 全体の 👑 がこの回にあればそれ（スイッチに関わらず）", roundBestId(rows, "score", 3) === 3);
  t("まとめの preferId（同じ決まりで決めた best_id）は今も優先", pickCustomerBest(rows, { basis: "score", preferId: 3 })?.id === 3);
}
{
  // 竹内さん「刺さる物件がない場合などは低いADの物件をオススメにする…内覧組むことが優先」: 線の下（AD 1）でも合い方が 15点以上上なら 👑
  const rows = [
    row(1, { score: 100, codes: ["AD_HIGH"], sqm: 18, age: 35, st: "木造" }),
    row(2, { score: 90, codes: ["AD_1M", "FLOOR_PLAN_MATCH"], sqm: 30, age: 3, st: "RC" }),
  ];
  const b = pickCustomerBest(rows, { basis: "score" });
  t("線の下でも合い方が大きく上なら 👑（内覧を組むのが優先）", b?.id === 2 && (b?.star_reasons ?? []).some((x) => x.includes("内覧を組むのが優先")), b);
  t("legacy は AD の高い 1", pickCustomerBest(rows, { basis: "score", starMode: "legacy" })?.id === 1);
}
{
  // 線の下の物が少しだけ合う（合い方の差 10＝AD 1.5 の札の分・15 未満）→ 線の上（AD 1.5 以上）を先に
  const rows = [
    row(1, { score: 100, codes: ["AD_1_5M"], sqm: 22, age: 20 }),
    row(2, { score: 100, codes: ["AD_1M"], sqm: 22, age: 20 }),
  ];
  t("差が小さい時は AD の線の上を 👑", pickCustomerBest(rows, { basis: "score" })?.id === 1);
}
{
  // AD 1未満は他に何も無い時だけ（feedback_ad_under1_not_sent）
  const rows = [
    row(1, { score: 60, codes: ["AD_UNDER_1M_FALLBACK"], sqm: 40, age: 1, st: "RC" }),
    row(2, { score: 70, codes: ["AD_1M"], sqm: 20, age: 30 }),
  ];
  t("AD 1未満は合い方が上でも 👑 にしない", pickCustomerBest(rows, { basis: "score" })?.id === 2);
  t("AD 1未満しか無ければそれ", pickCustomerBest([rows[0]], { basis: "score" })?.id === 1);
}
{
  // 保留は「通す」があれば 👑 の候補にしない（合い方の点が高くても）
  const rows = [
    row(1, { score: 130, codes: ["AD_1_5M", "RENT_UNDER_MIN"], sqm: 35, age: 2, st: "RC", verdict: "hold" }),
    row(2, { score: 80, codes: ["AD_1_5M"], sqm: 20, age: 25 }),
  ];
  t("保留は通すがあれば外す", pickCustomerBest(rows, { basis: "score" })?.id === 2);
  t("全部保留ならその中で合い方", pickCustomerBest([rows[0], { ...rows[1], verdict: "hold" }], { basis: "score" })?.id === 1);
  t("外す候補は今まで通り 👑 にしない", pickCustomerBest([{ ...rows[0], verdict: "drop" }, rows[1]], { basis: "score" })?.id === 2);
}
{
  // 値が無い行（古い行・設備欄なし）は札の点（AD を除く）だけで比べる＝今までに近い並び
  const rows = [
    { ...row(1, { score: 110, codes: ["AD_1_5M", "FLOOR_PLAN_MATCH"] }), equipment: null, terms: null, summary_text: null },
    { ...row(2, { score: 100, codes: ["AD_1_5M"] }), equipment: null, terms: null, summary_text: null },
  ];
  t("値が無くても落ちない・札の点の高い方", pickCustomerBest(rows, { basis: "score" })?.id === 1);
}
{
  // まとめ（完了）も同じ決め方で 👑 と記録（starMode・legacyBestId・rule）
  const rows = [
    row(1, { score: 120, codes: ["AD_HIGH", "FLOOR_PLAN_MATCH"], sqm: 20, age: 30, st: "鉄骨" }),
    row(2, { score: 105, codes: ["AD_1_5M", "FLOOR_PLAN_MATCH"], sqm: 28, age: 5, st: "RC" }),
  ];
  const fit = rankCompleteGroup(rows, { basis: "score", starMode: "fit" });
  const leg = rankCompleteGroup(rows, { basis: "score", starMode: "legacy" });
  t("まとめ: fit の 👑 は 2・順位の1番も 👑・記録に legacy の 1", fit.bestId === 2 && fit.order[0].id === 2 && fit.legacyBestId === 1 && fit.starMode === "fit" && fit.rule === STAR_FIT_RULE_TAG, fit);
  t("まとめ: legacy は 1", leg.bestId === 1 && leg.starMode === "legacy" && leg.rule === BEST_RULE_TAG);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
