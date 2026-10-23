// app/lib/brain-check-pattern.ts — 「物件確認した」系のピッカーの細目（check_pattern）をブレインが決める（純関数）
//
// 2026-10-15 竹内さんの決定③「物件確認したのピッカーの細目（check_pattern）をブレインに決めさせる」
//   旧: check_pattern はブレインの LLM ではなく決まり（場面の信号 → 場面の証拠 S2/S3 → 未返信の顧客発言の語＝resolveBrainCheckPattern）だけで決まっていた。
//   実測（scripts/audit-rest-1015.ts --part=check・30日・ブレインが物件確認したを選びスタッフも押した 58番）:
//     決まりが値を出した 7番のうちスタッフの選び方と合ったのは 1番（interior_photo）。違った 6番は決まりが条件のピッカー（mgmt_initial_cost 2・mgmt_guarantor 2・
//     mgmt_equipment 1・mgmt_pet 1）を出し、スタッフは募集状況の結果（物件あった 4・物件なかった 1・別の部屋 1）＝お客様が持ち込んだ物件＋条件の質問で、募集状況の確認を先にしていた。
//   新: ブレインの出力に check_pattern を足し、ブレインの値を使う。決まりは網（ブレインが値を出さない・読めない値の時だけ今まで通り）。
//       決まり自体が AIX を決めた番（場面の信号・管理会社の名前・手続きの2択など sceneSignalCheckPattern）は、その決まりの値（安全の線）。
// 戻す: BRAIN_CHECK_PATTERN=off
import { propertyCheckKindFor, availabilityKind, availabilityFirstKind, type PropertyCheckKind } from "./aix-taxonomy";
import { aixNewPickers1020Enabled, NEW_CHECK_PATTERNS_1020, screeningPickerForBrain } from "./aix-new-pickers";
import { screeningBrainEnabled } from "./aix-owner-answers-1021";
import { aixOccupantPickerEnabled } from "./aix-occupant-picker";

type Env = Record<string, string | undefined>;
export function brainCheckPatternEnabled(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_CHECK_PATTERN ?? "").trim().toLowerCase() !== "off";
}

/** ブレインが出せる値（availability＝物件確認した（募集状況）・他は aix-taxonomy の細目） */
export const BRAIN_CHECK_PATTERN_VALUES = [
  "availability", "interior_photo", "mgmt_move_in", "vacate_date", "mgmt_company", "mgmt_guarantor", "mgmt_pet",
  "mgmt_parking", "nearby_parking", "mgmt_equipment", "mgmt_initial_cost", "mgmt_proxy", "mgmt_two_person", "mgmt_lifeline",
  // 2026-10-20 竹内さんの新しいピッカー（AIX_NEW_PICKERS_1020=on の時だけ・off＝ブレインの値として読まない）
  "mgmt_screening", "mgmt_application_status", "mgmt_contract_terms", "mgmt_rent_negotiation", "mgmt_surroundings", "room_vacancies",
  // 2026-10-23 竹内さんの決定（2d860ddb）入居者の条件について（AIX_OCCUPANT_PICKER=on の時だけ読む）
  "mgmt_occupant",
] as const;
export type BrainCheckPattern = typeof BRAIN_CHECK_PATTERN_VALUES[number];

export function normalizeBrainCheckPattern(v: unknown): BrainCheckPattern | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s === "null") return null;
  if (s === "募集状況" || s === "available" || s === "unavailable" || s === "alternative") return "availability";
  // 2026-10-21 C9: 審査について（ご相談）は AIX_SCREENING_BUTTON=brain の時も読む（既定は今まで通り）
  if ((NEW_CHECK_PATTERNS_1020 as readonly string[]).includes(s) && !aixNewPickers1020Enabled() && !(s === "mgmt_screening" && screeningBrainEnabled())) return null;
  // 2026-10-22 新しいピッカーを既定 on にしても、審査について（ご相談）は明示の on か brain の時だけ（screeningPickerForBrain）
  if (s === "mgmt_screening" && !screeningPickerForBrain()) return null;
  if (s === "mgmt_occupant" && !aixOccupantPickerEnabled()) return null;
  return (BRAIN_CHECK_PATTERN_VALUES as readonly string[]).includes(s) ? (s as BrainCheckPattern) : null;
}

/** ブレインの出力の1項目（aix が property_check_result の時だけ値を入れる） */
export function brainCheckPatternSchemaField(env?: Env): string {
  if (!brainCheckPatternEnabled(env)) return "";
  return `"check_pattern": "aix が property_check_result の時だけ、押すボタンの細目を1つ（他の aix の時は null）。availability＝AIX【物件確認した（募集状況）】（物件そのものの空き・募集状況を確かめて結果で報告。お客様が持ち込んだ物件・まだ募集状況を確かめていない物件への質問は、条件を聞かれていても先にこれ＝スタッフは30日の同じ場面で6/6番が募集状況を先に確かめた）／interior_photo＝室内の写真・動画・別の部屋・間取り／確認した（条件・交渉）の細目: mgmt_move_in（入居可能日）・vacate_date（退去予定日）・mgmt_company（管理会社の名前・連絡先）・mgmt_guarantor（保証会社・保証人）・mgmt_pet（ペット）・mgmt_parking（${aixNewPickers1020Enabled(env) ? "駐車場・バイク置き場" : "駐車場"}）・nearby_parking（近隣の月極）・mgmt_equipment（設備）・mgmt_initial_cost（初期費用・礼金等の交渉）・mgmt_proxy（代理契約）・mgmt_two_person（二人入居）${aixOccupantPickerEnabled(env) ? "・mgmt_occupant（入居者の条件＝お子様のご入居・年齢の条件）" : ""}・mgmt_lifeline（ライフラインの指定・連絡先）${!aixNewPickers1020Enabled(env) && screeningBrainEnabled(env) ? "・mgmt_screening（審査の相談＝名義・保証人なし・職業・国籍・審査が通るか・AIX【審査について】）" : ""}${aixNewPickers1020Enabled(env) ? "・mgmt_screening（審査の相談＝名義・保証人なし・職業・国籍・審査が通るか）・mgmt_application_status（ほかの方の申込の有無・何番手・何人待ち）・mgmt_contract_terms（短期解約の違約金・クリーニング代・フリーレント）・mgmt_rent_negotiation（家賃の値下げの交渉の結果）・mgmt_surroundings（日当たり・音・騒音・周辺の様子を確かめた結果）／物件について の細目: room_vacancies（建物の募集中の号室・何部屋空いているか）" : ""}。募集状況がもう分かっている物件（こちらが送って募集中と伝えた・物件確認した済み）への条件の質問だけ条件の細目", `;
}

/**
 * ブレインの値で細目を決める（決まりは網）。
 *   ruleKind: 今までの決まりの答え（resolveBrainCheckPattern）／ruleDecided: 決まりが AIX そのものを決めた番（sceneSignalCheckPattern あり）
 */
export function resolveCheckKindWithBrain(i: { finalAix: string | null; brainValue: unknown; ruleKind: PropertyCheckKind | null; ruleDecided: boolean; env?: Env }): { kind: PropertyCheckKind | null; source: "brain" | "rule" } {
  if (i.finalAix !== "property_check_result" || !brainCheckPatternEnabled(i.env) || i.ruleDecided) return { kind: i.ruleKind, source: "rule" };
  const v = normalizeBrainCheckPattern(i.brainValue);
  if (!v) return { kind: i.ruleKind, source: "rule" };
  if (v === "availability") {
    // 条件の話題を添えた「物件確認した（募集状況）」（話題は決まりが読めた時だけ）
    const topic = i.ruleKind && i.ruleKind.ui_button === "確認した（条件・交渉）" ? i.ruleKind.topic : null;
    return { kind: topic ? availabilityFirstKind(topic) : (i.ruleKind && i.ruleKind.ui_button !== "確認した（条件・交渉）" && !i.ruleKind.check_pattern ? i.ruleKind : availabilityKind()), source: "brain" };
  }
  const k = propertyCheckKindFor(v);
  return k ? { kind: k, source: "brain" } : { kind: i.ruleKind, source: "rule" };
}
