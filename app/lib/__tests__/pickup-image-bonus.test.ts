// 2026-09-27 竹内「ここは合わせる」（画像の点を判定の点に足す・二重に数えない）と
//   「物件ピックアップの場合、質の高い10件のボタン、3件ではない10件で行う」「NG 条件の物件は10件にならなくても入れない」のテスト
// 実行: npx tsx app/lib/__tests__/pickup-image-bonus.test.ts
// 値は YUMA（テスト用の会話）の回 cg_509cd061_706・cg_509cd061_716 の実物（property_pickups の reason_codes・image_analysis の希望と答え）
import { imageBonusOf, totalPointOf, totalPointsLabel, judgedFeatures, IMAGE_BONUS_MAX, IMAGE_BONUS_MIN } from "../pickup-image-bonus";
import { compareOverall, pickCustomerBest, bestPointLabel, overallPoints, BEST_RULE_TAG, bestRuleTag } from "../pickup-best";
import { pickQualityTop, qualityPickLabel, qualityPickMessage, defaultAixChecks } from "../pickup-review-order";
import { ngHitCodes } from "../property-brain";
import { pointsLabel, imageChipOf } from "../pickup-listing-text";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}

// ── 実物（YUMA）──
const W_716 = [
  { id: "W1", text: "バストイレ別", ng: false, must: false, source: "条件" },
  { id: "W2", text: "2階以上がいいです", ng: false, must: false, source: "会話" },
  { id: "W3", text: "少し条件を変えて、もう少し広い1LDKで難波あたりの部屋も見てみたいです", ng: false, must: false, source: "会話" },
  { id: "W4", text: "お風呂綺麗", ng: false, must: false, source: "会話" },
  { id: "W5", text: "オートロック", ng: false, must: false, source: "会話" },
  { id: "W6", text: "クローゼットが壁に埋め込まれてるとこ", ng: false, must: false, source: "会話" },
];
const CODES_163 = ["RENT_OK", "RENT_ABOVE_USUAL", "ZERO_ZERO", "FLOOR_PLAN_MATCH", "WALK_OK", "BUILDING_AGE_OK", "AD_HIGH", "EQUIP_BATH_TOILET_MUST_OK", "AREA_WARD_MATCH", "AGE_COL_W5", "SEARCH_PINPOINT", "FIT_ALL"];
const ck = (...r: string[]) => r.map((result, i) => ({ id: `W${i + 1}`, result }));
// #740 エスリードレジデンス梅田グランゲート 0412（163点・画像 80点）
const r740 = { id: 740, rank: 25, recommended: 0, created_at: "2026-09-27T09:06:00Z", batch_id: "b716", status: "pending", property_name: "エスリードレジデンス梅田グランゲート", verdict: "pass", score: 163, reason_codes: CODES_163,
  image_analysis: { match: 80, match_raw: 80, review: { status: "ok" }, wants: W_716, checks: ck("ok", "ok", "ng", "unknown", "ok", "ok") } };
// #716 CRESTTAPP野田 204（163点・画像 75点・収納は分からない）
const r716 = { ...r740, id: 716, rank: 1, property_name: "CRESTTAPP野田", created_at: "2026-09-27T09:04:00Z",
  reason_codes: [...CODES_163, "AD_2_5M", "AD_VERY_HIGH"], image_analysis: { match: 75, match_raw: 75, review: { status: "ok" }, wants: W_716, checks: ck("ok", "ok", "ng", "unknown", "ok", "unknown") } };
// #708 ラ・フォーレ東天満 703（162点・画像 86点・条件の「1階不可」が判定の EQUIP_FLOOR2_OK に入っている）
const r708 = { id: 708, rank: 1, recommended: 0, created_at: "2026-09-27T05:41:00Z", batch_id: "b706", status: "pending", property_name: "ラ・フォーレ東天満", verdict: "pass", score: 162,
  reason_codes: ["RENT_OK", "RENT_ABOVE_USUAL", "FLOOR_PLAN_MATCH", "SQM_OK", "WALK_OK", "BUILDING_AGE_OK", "AD_HIGH", "EQUIP_BATH_TOILET_MUST_OK", "EQUIP_FLOOR2_OK", "AREA_WARD_MATCH", "COMMUTE_OK", "SEARCH_PINPOINT", "FIT_ALL"],
  image_analysis: { match: 86, match_raw: 86, review: { status: "ok" }, wants: [
    { id: "W1", text: "バストイレ別", ng: false, must: false }, { id: "W2", text: "NG条件: 1階不可", ng: false, must: false }, { id: "W3", text: "1階不可", ng: true, must: false },
    { id: "W4", text: "少し条件を変えて、もう少し広い1LDKで難波あたりの部屋も見てみたいです", ng: false, must: false }, { id: "W5", text: "お風呂綺麗", ng: false, must: false },
    { id: "W6", text: "オートロック", ng: false, must: false }, { id: "W7", text: "クローゼットが壁に埋め込まれてるとこ", ng: false, must: false }],
    checks: ck("ok", "ok", "ok", "ng", "unknown", "ok", "ok") } };
// #706 エストドミール野田 00105（1階・お客様の「1階不可」に当たって保留 107点・分析なし）
const r706 = { id: 706, rank: 9, recommended: 0, created_at: "2026-09-27T05:41:00Z", batch_id: "b706", status: "pending", property_name: "エストドミール野田", verdict: "hold", score: 107,
  reason_codes: ["RENT_OK", "RENT_ABOVE_USUAL", "FLOOR_PLAN_MATCH", "SQM_OK", "WALK_OK", "BUILDING_AGE_OK", "AD_1M_HELD", "EQUIP_BATH_TOILET_MUST_OK", "EQUIP_FLOOR2_NG", "AREA_WARD_MATCH", "COMMUTE_OK", "AGE_COL_W10", "SEARCH_PINPOINT_HELD"], image_analysis: null };
// #747 プレサンス梅田東アルファ 905（定期借家で保留 98点）
const r747 = { ...r706, id: 747, rank: 31, batch_id: "b716", property_name: "プレサンス梅田東アルファ", score: 98,
  reason_codes: ["RENT_OK", "RENT_ABOVE_USUAL", "FLOOR_PLAN_MATCH", "WALK_OK", "BUILDING_AGE_OK", "AD_HIGH_HELD", "CONTRACT_FIXED", "EQUIP_BATH_TOILET_MUST_OK", "AREA_WARD_MATCH", "SEARCH_PINPOINT_HELD"] };

console.log("■ 判定に入っている設備（二重に数えない物）");
t("EQUIP_BATH_TOILET_MUST_OK → バストイレ別は判定に入っている", judgedFeatures(CODES_163).has("bath_toilet"));
t("EQUIP_FLOOR2_OK → 2階以上も", judgedFeatures(r708.reason_codes).has("floor2"));
t("_UNLISTED（資料に書いていない・0点）は入っていない＝画像で確かめた分を足してよい", !judgedFeatures(["EQUIP_BATH_TOILET_UNLISTED"]).has("bath_toilet"));
t("IMAGE_*（間取り図の読み取り）も判定に入っている", judgedFeatures(["IMAGE_BATH_TOILET_SEPARATE_OK", "IMAGE_STORAGE_NG"]).has("storage"));
t("AD の保留の印（_HELD）は外して見る", judgedFeatures(["EQUIP_AUTOLOCK_OK_HELD"]).has("autolock"));

console.log("■ 画像の加点（実物）");
{
  const b = imageBonusOf(r740)!;
  // バストイレ別＝判定と同じ（足さない）・2階以上 +3・広い1LDK × −5・お風呂綺麗 ？0・オートロック +3・収納 +3 → +4
  t("#740: 判定と同じバストイレ別は足さず +4（2階以上 +3・オートロック +3・収納 +3・広い1LDK −5）", b.points === 4 && b.covered === 1 && b.ok === 3 && b.ng === 1, b);
  t("#740: 合計 167（判定 163＋4）", totalPointOf(r740) === 167 && overallPoints(r740) === 167);
  t("#740: 見せ方「合計 167点（判定 163・画像 +4）」", totalPointsLabel(r740) === "合計 167点（判定 163・画像 +4）", totalPointsLabel(r740));
  const b716 = imageBonusOf(r716)!;
  t("#716: 収納が分からない分だけ低い +1（合計 164）", b716.points === 1 && totalPointOf(r716) === 164, b716);
  const b708 = imageBonusOf(r708)!;
  // 「NG条件: 1階不可」「1階不可」は同じ設備で1つ・判定の EQUIP_FLOOR2_OK に入っている → 足さない
  t("#708: 1階不可の2つは1つに数えて判定と同じ（足さない）・+1（オートロック +3・収納 +3・広い1LDK −5）", b708.points === 1 && b708.covered === 2 && totalPointOf(r708) === 163, b708);
  t("画像の点の割合（86点）をそのまま足さない（判定 162＋86 にならない）", totalPointOf(r708) !== 248);
  t("分析なし → null（合計に入れない・判定の点のまま）", imageBonusOf(r706) === null && totalPointOf(r706) === 107 && totalPointsLabel(r706) === "判定 107点");
  const nc = { ...r740, image_analysis: { ...r740.image_analysis, review: { status: "要確認" } } };
  t("要確認 → 足さない（判定の点のまま）", imageBonusOf(nc) === null && totalPointOf(nc) === 163);
  const old = { ...r740, image_analysis: { match: 86, match_raw: 86, checks: ck("ok", "ok") } };
  t("希望の一覧が無い古い形 → 足さない（どの希望が判定と同じか分からない）", imageBonusOf(old) === null && totalPointOf(old) === 163);
}
console.log("■ 重さと上限");
{
  const w = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, text, ng: false, must: false, ...extra });
  const many = { score: 150, reason_codes: [], image_analysis: { match: 100, wants: [w("W1", "WIC"), w("W2", "対面キッチン"), w("W3", "独立洗面"), w("W4", "室内洗濯機置場"), w("W5", "角部屋"), w("W6", "宅配ボックス")], checks: ck("ok", "ok", "ok", "ok", "ok", "ok") } };
  t(`○ が6つ（+18）でも +${IMAGE_BONUS_MAX} まで（設備の ○ の合計の上限と同じ）`, imageBonusOf(many)!.points === IMAGE_BONUS_MAX && imageBonusOf(many)!.raw === 18);
  const bad = { score: 150, reason_codes: [], image_analysis: { match: 0, wants: [w("W1", "WIC", { must: true }), w("W2", "対面キッチン", { must: true }), w("W3", "独立洗面", { ng: true })], checks: ck("ng", "ng", "ng") } };
  t(`必須の × は −10・合計は ${IMAGE_BONUS_MIN} まで`, imageBonusOf(bad)!.raw === -30 && imageBonusOf(bad)!.points === IMAGE_BONUS_MIN);
  const must = { score: 150, reason_codes: [], image_analysis: { match: 100, wants: [w("W1", "WIC", { must: true })], checks: ck("ok") } };
  t("必須の ○ は +5（EQUIP_*_MUST_OK と同じ）", imageBonusOf(must)!.points === 5);
}

console.log("■ 並び・👑（合計で決める）");
{
  // YUMA の回 716 の 163点の物件どうし: 前の版（判定の点 → 画像の点）でも #740（80点）が #716（75点）より上。合計でも 167 > 164
  t("163点どうしは合計で #740（167）が #716（164）より上", compareOverall(r740, r716) < 0);
  // 画像の加点で判定の点の差を越える例: 判定 160＋画像 +15 は 判定 163＋画像 −5 より上
  const hi = { ...r740, id: 1, score: 160, reason_codes: [], image_analysis: { match: 100, review: { status: "ok" }, wants: [{ id: "W1", text: "WIC" }, { id: "W2", text: "対面キッチン" }, { id: "W3", text: "独立洗面" }, { id: "W4", text: "角部屋" }, { id: "W5", text: "宅配ボックス" }], checks: ck("ok", "ok", "ok", "ok", "ok") } };
  const lo = { ...r740, id: 2, score: 163, reason_codes: [], image_analysis: { match: 0, review: { status: "ok" }, wants: [{ id: "W1", text: "WIC" }], checks: ck("ng") } };
  t("判定 160＋15＝175 は 判定 163−5＝158 より上（画像を合わせて並べる）", compareOverall(hi, lo) < 0);
  const same = { ...r706, id: 3, verdict: "pass", score: 167, image_analysis: null };
  t("合計が同じ（167）なら判定の点が高い方（分析待ちの 167 が 163＋4 より上）", compareOverall(same, r740) < 0);
  const best = pickCustomerBest([r740, r716, r747], { basis: "score" })!;
  t("👑 は合計の一番 #740・点の出し方「合計 167点（判定 163・画像 +4）」", best.id === 740 && best.total === 167 && best.bonus === 4 && bestPointLabel(best) === "合計 167点（判定 163・画像 +4）", best);
  t("画面の👑の行も同じ文（pointsLabel）", pointsLabel(163, r740.image_analysis, r740.reason_codes) === "合計 167点（判定 163・画像 +4）");
  t("カードの札「🔍 画像 +4点（◎3・×1）」", imageChipOf(r740.image_analysis, false, r740.reason_codes)?.text === "🔍 画像 +4点（◎3・×1）", imageChipOf(r740.image_analysis, false, r740.reason_codes));
  t("決まりの版が変わった（前の版のまとめの best_id は使わない）", BEST_RULE_TAG === "score+imagebonus@2026-09-27b" && bestRuleTag("score") === BEST_RULE_TAG);
}

console.log("■ NG の見分け（今の判定の札をそのまま）");
t("#706 1階（EQUIP_FLOOR2_NG）は NG", ngHitCodes(r706.reason_codes).includes("EQUIP_FLOOR2_NG"));
t("#747 定期借家（保留の理由 CONTRACT_FIXED）は NG", ngHitCodes(r747.reason_codes).includes("CONTRACT_FIXED"));
t("AD の保留の印（AD_HIGH_HELD・SEARCH_PINPOINT_HELD）は NG ではない", !ngHitCodes(r747.reason_codes).some((c) => /AD_HIGH|SEARCH_PINPOINT/.test(c)));
t("#740（通す・NG なし）は空", ngHitCodes(r740.reason_codes).length === 0);
t("書いた条件の ×（間取り違い・築年超過・入居時期）も NG", ["FLOOR_PLAN_MISMATCH", "BUILDING_AGE_OVER", "MOVE_IN_LATE", "PET_NG", "EQUIP_MUST_NG_CAP", "IMAGE_FLOOR_2_PLUS_NG"].every((c) => ngHitCodes([c]).length === 1));
t("少しの超過（幅の中・soft_ng）は NG にしない", ngHitCodes(["RENT_SLIGHTLY_OVER", "WALK_SLIGHTLY_OVER", "EQUIP_BATH_TOILET_UNLISTED"]).length === 0);

console.log("■ 質の高い10件（物件ピックアップ）");
{
  // 実物の回 716 の形: 通す 25件＋保留（定期借家）5件＋送信済み 1件（#745）
  const passes = Array.from({ length: 25 }, (_, i) => ({ ...r716, id: 800 + i, rank: i + 2, score: 140 + i, image_analysis: null }));
  const holds = Array.from({ length: 5 }, (_, i) => ({ ...r747, id: 900 + i, score: 180 + i }));   // 点が高くても NG
  const sent = { ...r740, id: 745, status: "sent" };
  const items = [...passes, ...holds, sent, r740];
  const q = pickQualityTop(items, 740);
  t("10件（3件ではない）", q.ids.length === 10, q);
  t("👑 #740 が先頭・残りは合計の高い順", q.ids[0] === 740 && q.ids[1] === 824 && q.ids[9] === 816, q.ids);
  t("NG（保留）の物件は点が高くても選ばない・送信済みも選ばない", !q.ids.some((id) => id >= 900 || id === 745) && q.ngExcluded === 5, q);
  const few = [...passes.slice(0, 7), ...holds, r706];
  const qf = pickQualityTop(few);
  t("通すが7件しか無い → 7件のまま（NG の物件で10件に埋めない）", qf.ids.length === 7 && qf.ngExcluded === 6, qf);
  t("文字「✨ 質の高い7件を選ぶ」「✨ 質の高い7件を選びました（10件に足りません・NG 条件・保留の物件は選びません・6件）」",
    qualityPickLabel(7) === "✨ 質の高い7件を選ぶ" && qualityPickMessage(7, 6) === "✨ 質の高い7件を選びました（10件に足りません・NG 条件・保留の物件は選びません・6件）", qualityPickMessage(7, 6));
  t("10件そろえば「✨ 質の高い10件を選びました」", qualityPickMessage(10, 0) === "✨ 質の高い10件を選びました");
  t("全部 NG → 選べない", pickQualityTop([r706, r747]).ids.length === 0 && qualityPickMessage(0, 2) === "選べる物件がありません（NG 条件・保留の物件は選びません・2件）");
  const expired = pickQualityTop([{ ...r740, expired: true }, { ...r740, id: 1, status: "skipped" }]);
  t("保存期間切れ・見送りは選ばない（NG の数にも入れない）", expired.ids.length === 0 && expired.ngExcluded === 0, expired);
  const dc = defaultAixChecks([{ items: few }]);
  t("詳細を開いた時の既定のチェックも NG を付けない", !dc[706] && !dc[900] && Object.values(dc).filter(Boolean).length === 7, dc);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
