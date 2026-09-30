// 2026-09-30 竹内「AD1未満の物件は基本的に送らない。家賃10万で AD0.5 等 売上5万以上ある場合で、他に物件ない場合や
//   お客さんにしばらく新着物件送れていない人などは送っても良い。しかし 1K の AD1未満はきほんおくらない」のテスト
// 実行: npx tsx app/lib/__tests__/ad-under1-policy.test.ts
// 行の形は 2026-09-24〜30 の property_pickups の実物（説明文・札は id 843・858・991・1111・1178・1189・1708・2319 のまま）。お客様の名前・電話番号は無い
import {
  adUnder1Policy, isOneRoomPlan, adUnder1KindOfCodes, isAdUnder1Code, isStaleForAdUnder1, adUnder1CodeFor,
  AD_UNDER1_MIN_SALES_YEN, AD_UNDER1_STALE_DAYS,
} from "../ad-under1-policy";
import {
  buildCustomerProfile, judgeProperty, parsePropertyFacts, applyEquipmentMatch, applyImageFacts, rejudgeWithoutDiscount, dropDiscountFromRow,
  reasonPoints, reasonJa, ngHitCodes, scoreFromCodes, DROP_REASON_CODES, HOLD_REASON_CODES, type CustomerLike, type Judgment,
} from "../property-brain";
import { pickupAdTier, lastProposalSentAt } from "../pickup-ad-priority";
import { pickQualityTop, defaultAixChecks, qualityPickMessage, adUnder1ConfirmMessage, pickTopForAix, isAdUnder1FallbackRow, type AixPickRow } from "../pickup-review-order";
import { buildPickupCardView } from "../pickup-card-view";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ""}`); }
}

console.log("■ 1K の範囲");
t("1K・1R・1SK・全角・ワンルームは 1K 扱い", ["1K", "1R", "1SK", "１Ｋ", "1 K", "ワンルーム"].every((p) => isOneRoomPlan(p)));
t("1DK・1LDK・2K・空・null は 1K でない", ["1DK", "1LDK", "1SLDK", "2K", "2LDK", "", null, undefined].every((p) => !isOneRoomPlan(p as never)));

console.log("■ 売上の計算と政策（実物の行）");
{
  // #991 ラパンジール恵美須2: 2LDK・家賃100,000円・AD 60,000円（円で書いてある）＝売上6万円・1K でない → 穴埋め
  const a = adUnder1Policy({ adMonths: null, adYen: 60000, rentYen: 100000, floorPlan: "2LDK" });
  t("#991 2LDK 家賃10万 AD6万円 → fallback（売上6万円）", a.policy === "fallback" && a.salesYen === 60000 && Math.abs((a.months ?? 0) - 0.6) < 1e-9, a);
  // #858 フジパレス新大阪サウス: 1LDK・76,000円・AD 60,000円（0.79ヶ月）→ 穴埋め
  t("#858 1LDK AD6万円（0.79ヶ月）→ fallback", adUnder1Policy({ adYen: 60000, rentYen: 76000, floorPlan: "1LDK" }).policy === "fallback");
  // #1178 メゾン東田辺: 2LDK・133,000円・AD 0.5ヶ月＝66,500円 → 穴埋め
  t("#1178 2LDK 家賃13.3万 AD0.5ヶ月 → fallback（売上6.65万円）", (() => { const r = adUnder1Policy({ adMonths: 0.5, rentYen: 133000, floorPlan: "2LDK" }); return r.policy === "fallback" && r.salesYen === 66500; })());
  // #1189 AZU PATIO: 2LDK・125,000円・AD 0.3ヶ月＝37,500円 → 送らない
  t("#1189 2LDK AD0.3ヶ月（売上3.75万円）→ never", (() => { const r = adUnder1Policy({ adMonths: 0.3, rentYen: 125000, floorPlan: "2LDK" }); return r.policy === "never" && r.salesYen === 37500 && /5万円未満/.test(r.why); })());
  // #1708 エスリード難波ザ・メゾン: 1K・65,000円・AD 50,000円 → 売上5万円だが 1K なので送らない
  t("#1708 1K AD5万円（売上5万円ちょうど）→ 1K なので never", (() => { const r = adUnder1Policy({ adYen: 50000, rentYen: 65000, floorPlan: "1K" }); return r.policy === "never" && r.oneRoom && r.salesYen === 50000; })());
  // #843 エスリード難波SOUTH: 1K・68,000円・AD なし（0）
  t("#843 1K AD なし（月数0・売上0）→ never", adUnder1Policy({ adMonths: 0, rentYen: 68000, floorPlan: "1K" }).policy === "never");
  // 家賃10万で AD0.5＝5万円ちょうどは「5万円以上」
  t("家賃10万・AD0.5ヶ月（売上5万円ちょうど）・2LDK → fallback（5万円以上）", adUnder1Policy({ adMonths: 0.5, rentYen: 100000, floorPlan: "2LDK" }).policy === "fallback" && AD_UNDER1_MIN_SALES_YEN === 50000);
  t("売上49,999円 → never", adUnder1Policy({ adYen: 49999, rentYen: 100000, floorPlan: "2LDK" }).policy === "never");
  t("AD1ヶ月以上は対象外 na（1ヶ月・1.5ヶ月・端数の 0.995）", ["1", "1.5", "2"].every((m) => adUnder1Policy({ adMonths: Number(m), rentYen: 80000, floorPlan: "1K" }).policy === "na") && adUnder1Policy({ adYen: 159999, rentYen: 160000, floorPlan: "2LDK" }).policy === "na");
  t("AD が読めない（月数も円も無い）は対象外 na（AD_UNKNOWN・アズ・スタットのみなしは別）", adUnder1Policy({ rentYen: 80000, floorPlan: "1K" }).policy === "na" && adUnder1Policy({}).policy === "na");
  // 誤って外さない: 売上が読めない（月数だけで家賃が無い）・間取りが読めない
  t("売上が読めない（家賃なし）・1K でない → never にしない（fallback）", adUnder1Policy({ adMonths: 0.5, floorPlan: "1LDK" }).policy === "fallback");
  t("売上が読めなくても 1K なら never", adUnder1Policy({ adMonths: 0.5, floorPlan: "1K" }).policy === "never");
  t("間取りが読めず売上5万円以上 → fallback（1K と決めつけない）", adUnder1Policy({ adMonths: 0.6, rentYen: 100000, floorPlan: null }).policy === "fallback");
  t("札の対応: never→NEVER・fallback→FALLBACK・na→null", adUnder1CodeFor("never") === "AD_UNDER_1M_NEVER" && adUnder1CodeFor("fallback") === "AD_UNDER_1M_FALLBACK" && adUnder1CodeFor("na") === null);
}

console.log("■ 札の表（点・日本語・カテゴリ）");
{
  t("点は AD_UNDER_1M と同じ −30（AD1 との差を保つ）", reasonPoints("AD_UNDER_1M_NEVER") === -30 && reasonPoints("AD_UNDER_1M_FALLBACK") === -30 && reasonPoints("AD_UNDER_1M") === -30);
  t("日本語がある", reasonJa("AD_UNDER_1M_NEVER") !== "AD_UNDER_1M_NEVER" && reasonJa("AD_UNDER_1M_FALLBACK") !== "AD_UNDER_1M_FALLBACK");
  t("NEVER・AD_NONE は外す候補・FALLBACK・旧は保留", DROP_REASON_CODES.has("AD_UNDER_1M_NEVER") && DROP_REASON_CODES.has("AD_NONE") && HOLD_REASON_CODES.has("AD_UNDER_1M_FALLBACK") && HOLD_REASON_CODES.has("AD_UNDER_1M") && !HOLD_REASON_CODES.has("AD_UNDER_1M_NEVER"));
  t("AD1未満の札の見分け（_HELD が付いても同じ）", ["AD_UNDER_1M", "AD_UNDER_1M_NEVER", "AD_UNDER_1M_FALLBACK", "AD_NONE", "AD_NONE_HELD"].every(isAdUnder1Code) && !isAdUnder1Code("AD_1M") && !isAdUnder1Code("AD_UNKNOWN"));
  t("行の読み: NEVER・AD_NONE→never／FALLBACK→fallback／旧→legacy／なし→null", adUnder1KindOfCodes(["RENT_OK", "AD_UNDER_1M_NEVER"]) === "never" && adUnder1KindOfCodes(["AD_NONE"]) === "never" && adUnder1KindOfCodes(["AD_UNDER_1M_FALLBACK"]) === "fallback" && adUnder1KindOfCodes(["AD_UNDER_1M"]) === "legacy" && adUnder1KindOfCodes(["AD_1M"]) === null && adUnder1KindOfCodes(null) === null);
  t("AD の段は「AD1未満」（選び方の段・画面）", ["AD_UNDER_1M_NEVER", "AD_UNDER_1M_FALLBACK", "AD_UNDER_1M", "AD_NONE"].every((c) => pickupAdTier([c]) === "low"));
  t("NG 条件には数えない（お客様の条件ではない）", ngHitCodes(["AD_UNDER_1M_NEVER", "AD_UNDER_1M_FALLBACK", "AD_NONE"]).length === 0);
  // 画面の札（pickup-card-view）: AD の項目は ng の色・一言
  const v = buildPickupCardView({ id: 991, property_name: "ラパンジール恵美須2", summary_text: "【11】ラパンジール恵美須2 602号室\n100,000円 7,000円\n2LDK 40.97㎡\nAD 60,000円", reason_codes: ["RENT_WIDE", "FLOOR_PLAN_MATCH", "AD_UNDER_1M_FALLBACK"], score: 73, verdict: "hold" } as never);
  const adCell = JSON.stringify(v).includes("他に無い時だけ");
  t("カードに「他に無い時だけ」の一言が出る", adCell);
}

console.log("■ 判定（judgeProperty）: 実物の説明文で 送らない側／穴埋め用／対象外");
const prof = buildCustomerProfile({ rent_max: 150_000, floor_plan: "1K以上" } as CustomerLike);
const J = (s: string): Judgment => judgeProperty(parsePropertyFacts(s), prof);
const S = {
  fb991: "【11】ラパンジール恵美須2 602号室\n100,000円 7,000円\n2LDK 40.97㎡\n堺筋線「恵美須町」徒歩2分\nAD 60,000円",
  fb1178: "【2】メゾン東田辺 202号室\n133,000円 6,000円\n2LDK 59.8㎡\n南大阪線「針中野」徒歩4分\nAD 0.5ヶ月",
  nv1189: "【4】AZU PATIO 00201号室\n125,000円 12,000円\n2LDK 53.71㎡\n谷町線「太子橋今市」徒歩4分\nAD 0.3ヶ月",
  nv1708: "【5】エスリード難波ザ・メゾン 1001号室\n65,000円 9,000円\n1K 22.42㎡\n千日前線「桜川」徒歩6分\nAD 50,000円",
  none843: "【3】エスリード難波SOUTH 802号室\n68,000円 8,000円\n1K 25.69㎡\n大阪メトロ御堂筋線 大国町駅 徒歩7分\nAD なし",
  one: "【6】ファーストフィオーレ 1109号室\n90,000円\n1LDK 40㎡\n徒歩5分\nAD 1ヶ月",
  unknown: "【7】ルーミナル 101号室\n90,000円\n1LDK 40㎡\n徒歩5分",
};
const jFb = J(S.fb991), jFb2 = J(S.fb1178), jNv = J(S.nv1189), jNv1k = J(S.nv1708), jNone = J(S.none843), jOne = J(S.one), jUnk = J(S.unknown);
{
  t("2LDK・家賃10万・AD 6万円 → AD_UNDER_1M_FALLBACK・保留（−30・外す候補でない）", jFb.reasonCodes.includes("AD_UNDER_1M_FALLBACK") && !jFb.reasonCodes.includes("AD_UNDER_1M_NEVER") && jFb.verdict === "hold" && jFb.flagCodes.includes("AD_UNDER_1M_FALLBACK"), [jFb.reasonCodes, jFb.verdict]);
  t("2LDK・家賃13.3万・AD0.5ヶ月（売上6.65万円）→ FALLBACK・保留", jFb2.reasonCodes.includes("AD_UNDER_1M_FALLBACK") && jFb2.verdict === "hold");
  t("2LDK・AD0.3ヶ月（売上3.75万円）→ NEVER・外す候補", jNv.reasonCodes.includes("AD_UNDER_1M_NEVER") && jNv.verdict === "drop" && jNv.imageChecks.length === 0, [jNv.reasonCodes, jNv.verdict]);
  t("1K・AD5万円（売上5万円・1K）→ NEVER・外す候補", jNv1k.reasonCodes.includes("AD_UNDER_1M_NEVER") && jNv1k.verdict === "drop");
  t("1K・AD なし → AD_NONE・外す候補（売上0）", jNone.reasonCodes.includes("AD_NONE") && !jNone.reasonCodes.some((c) => /^AD_UNDER_1M/.test(c)) && jNone.verdict === "drop");
  t("AD1ヶ月・AD 不明は AD1未満の札を付けない・通す", !jOne.reasonCodes.some((c) => isAdUnder1Code(c)) && jOne.verdict === "pass" && jUnk.reasonCodes.includes("AD_UNKNOWN") && jUnk.verdict === "pass");
  const sum50 = (j: Judgment) => Math.max(0, Math.min(200, 50 + j.reasonCodes.reduce((a, c) => a + reasonPoints(c), 0)));
  t("点は 50＋札の合計のまま（新しい札も表どおり）", [jFb, jFb2, jNv, jNv1k, jNone].every((j) => j.reasonCodes.includes("EQUIP_MUST_NG_CAP") || sum50(j) === j.score), [jFb, jNv].map((j) => [j.score, sum50(j)]));
  t("穴埋めの候補（行の形）: FALLBACK・保留・NG なし・点 ≧ 10", isAdUnder1FallbackRow({ verdict: "hold", score: jFb.score, reason_codes: jFb.reasonCodes }), jFb.score);
  t("送らない側は穴埋めの候補にならない", !isAdUnder1FallbackRow({ verdict: "drop", score: 100, reason_codes: jNv.reasonCodes }) && !isAdUnder1FallbackRow({ verdict: "hold", score: 100, reason_codes: ["AD_UNDER_1M"] }));
}

console.log("■ 判定を付け直す段でも同じ結果（設備欄・画像・割引の札の付け直し）");
{
  const same = (j: Judgment, after: { verdict: string; reasonCodes: string[]; score?: number }) =>
    after.verdict === j.verdict && adUnder1KindOfCodes(after.reasonCodes) === adUnder1KindOfCodes(j.reasonCodes);
  for (const [nm, j] of [["穴埋め用", jFb], ["送らない側", jNv], ["1K", jNv1k], ["AD なし", jNone]] as const) {
    const eq = applyEquipmentMatch(j, null);
    t(`applyEquipmentMatch（${nm}）: 判定・AD1未満の種類が変わらない`, same(j, eq) && eq.score === j.score, [j.verdict, eq.verdict, eq.reasonCodes]);
    const img = applyImageFacts(j, { bath_toilet_separate: true });
    t(`applyImageFacts（${nm}）: 判定・AD1未満の種類が変わらない`, same(j, img), [j.verdict, img.verdict]);
  }
  // 割引の札（旧）を外して付け直す行（PROFIT_NEGATIVE があった行は AD_UNDER_1M を付け直す）: 材料（家賃・円・間取り）を渡すと同じ札になる
  const withNeg = rejudgeWithoutDiscount(["RENT_OK", "PROFIT_NEGATIVE"], { adMonths: 0.6, adPolicy: { adMonths: null, adYen: 60000, rentYen: 100000, floorPlan: "2LDK" } });
  t("rejudgeWithoutDiscount（売上6万円・2LDK）→ AD_UNDER_1M_FALLBACK・保留", withNeg.reasonCodes.includes("AD_UNDER_1M_FALLBACK") && withNeg.verdict === "hold", withNeg.reasonCodes);
  const withNeg1k = rejudgeWithoutDiscount(["RENT_OK", "PROFIT_NEGATIVE"], { adMonths: 0.6, adPolicy: { adYen: 60000, rentYen: 100000, floorPlan: "1K" } });
  t("rejudgeWithoutDiscount（1K）→ AD_UNDER_1M_NEVER・外す候補", withNeg1k.reasonCodes.includes("AD_UNDER_1M_NEVER") && withNeg1k.verdict === "drop", withNeg1k.reasonCodes);
  t("rejudgeWithoutDiscount（材料なし）は旧の AD_UNDER_1M（保留）のまま", rejudgeWithoutDiscount(["RENT_OK", "PROFIT_NEGATIVE"], { adMonths: 0.5 }).reasonCodes.includes("AD_UNDER_1M"));
  const dd = dropDiscountFromRow({ reason_codes: ["RENT_OK", "FLOOR_PLAN_MATCH", "PROFIT_NEGATIVE"], score: 60, verdict: "hold", summary_text: S.fb991 });
  t("dropDiscountFromRow: 実物の説明文から売上・間取りを読んで FALLBACK", !!dd && dd.reason_codes.includes("AD_UNDER_1M_FALLBACK"), dd?.reason_codes);
  // 保存済みの旧の札（AD_UNDER_1M）の行に設備欄を当て直しても種類は変わらない（旧のまま・保留）
  const legacy = applyEquipmentMatch({ reasonCodes: ["RENT_OK", "FLOOR_PLAN_MATCH", "AD_UNDER_1M"] }, null);
  t("旧の行（AD_UNDER_1M）は付け直しても保留のまま（保存済みの行は付け直さない）", legacy.verdict === "hold" && legacy.reasonCodes.includes("AD_UNDER_1M"), legacy);
  const stored = applyEquipmentMatch({ reasonCodes: ["RENT_OK", "FLOOR_PLAN_MATCH", "AD_NONE"] }, null);
  t("保存済みの AD_NONE の行に当て直すと外す候補（売上0）", stored.verdict === "drop", stored.verdict);
  t("scoreFromCodes: 新しい札も −30", scoreFromCodes(["AD_UNDER_1M_NEVER"]) === 20 && scoreFromCodes(["AD_UNDER_1M_FALLBACK"]) === 20);
}

console.log("■ 選び方（pickQualityTop）: 他に無い時・しばらく送れていない時だけ穴埋め");
{
  let id = 0;
  const row = (over: Partial<AixPickRow> & { reason_codes?: string[] }): AixPickRow => ({ id: ++id, rank: id, recommended: 0, score: 100, status: "pending", verdict: "pass", expired: false, reason_codes: ["RENT_OK", "AD_1M"], ...over });
  const fb = (score = 73, more: string[] = []) => row({ verdict: "hold", score, reason_codes: ["RENT_WIDE", "FLOOR_PLAN_MATCH", ...more, "AD_UNDER_1M_FALLBACK"] });
  const nv = () => row({ verdict: "drop", score: 20, reason_codes: ["RENT_OK", "AD_UNDER_1M_NEVER"] });
  const leg = () => row({ verdict: "hold", score: 90, reason_codes: ["RENT_OK", "AD_UNDER_1M"] });
  const normal = (n: number) => Array.from({ length: n }, (_, i) => row({ score: 150 - i, reason_codes: ["RENT_OK", "AD_HIGH"] }));

  // 他に選べる物件が無い → 穴埋めの候補が入る（never・旧・NG のある行は入らない）
  const a = [fb(70), fb(60), nv(), leg(), fb(80, ["RENT_OVER_110"])];
  const qa = pickQualityTop(a, null, 10);
  t("ほかに選べる物件が無い → 売上5万円以上（穴埋め用）だけが入る（点の高い順）", qa.ids.length === 2 && qa.ids[0] === a[0].id && qa.ids[1] === a[1].id && qa.adUnder1FillWhy === "no_other" && qa.adUnder1Filled === 2, qa);
  t("never・旧の札・ほかの NG がある穴埋め用の行は入らない・数える（AD1未満で選ばない件数）", !qa.ids.includes(a[2].id) && !qa.ids.includes(a[3].id) && !qa.ids.includes(a[4].id) && qa.adUnder1Excluded === 2 && qa.ngExcluded === 1, qa);
  // ほかに物件がある・しばらく送れていない訳でもない → 入らない
  const b = [...normal(3), fb(70)];
  const qb = pickQualityTop(b, null, 10);
  t("ほかに選べる物件がある・送れていない訳でもない → 穴埋めは入らない", qb.ids.length === 3 && qb.adUnder1Filled === 0 && qb.adUnder1FillWhy === null && qb.adUnder1Excluded === 1, qb);
  // しばらく送れていない → 通常の候補の後ろに足す
  const qc = pickQualityTop(b, null, 10, { staleSinceLastSend: true });
  t("しばらく送れていない → 通常の候補（3件）の後ろに穴埋め1件", qc.ids.length === 4 && qc.ids[3] === b[3].id && qc.adUnder1FillWhy === "stale", qc);
  // 10件で埋まる → 入らない（枠が無い）
  const d = [...normal(10), fb(70)];
  const qd = pickQualityTop(d, null, 10, { staleSinceLastSend: true });
  t("通常の候補で10件埋まる時は穴埋めを入れない（しばらくでも）", qd.ids.length === 10 && !qd.ids.includes(d[10].id) && qd.adUnder1Filled === 0 && qd.adUnder1Excluded === 1, qd);
  // 枠が余る分だけ
  const e = [...normal(9), fb(70), fb(60)];
  const qe = pickQualityTop(e, null, 10, { staleSinceLastSend: true });
  t("枠が1つ余る時は穴埋めを1件だけ（点の高い方）", qe.ids.length === 10 && qe.ids[9] === e[9].id && qe.adUnder1Filled === 1 && qe.adUnder1Excluded === 1, qe);
  // 審査中・商談中の穴埋め候補は入らない
  const dealFb = { ...fb(70), deal_status: "審査中" };
  t("資料の現況が審査中・商談中の穴埋め候補は入れない", pickQualityTop([dealFb], null, 10).ids.length === 0);
  // 点の線: AD の −30 が無くても通す線（40）に届かない行は入れない
  t("AD の低さ以外でも点が足りない行（点 5）は穴埋めにしない", pickQualityTop([fb(5)], null, 10).ids.length === 0 && pickQualityTop([fb(10)], null, 10).ids.length === 1);
  // 送付済みの部屋は穴埋めにも入らない
  const sentFb = fb(70);
  t("送付済みの部屋は穴埋めにも入らない", pickQualityTop([sentFb], null, 10, { sentBefore: new Set([sentFb.id]) }).ids.length === 0);
  // 新規のお客様（AD の段で選ぶ回）でも同じ
  const f2 = [...normal(2), fb(70)];
  t("新規のお客様の回: ほかに選べる物件がある間は入らない・無ければ入る", pickQualityTop(f2, null, 10, { firstProposal: true }).ids.length === 2 && pickQualityTop([fb(70)], null, 10, { firstProposal: true }).ids.length === 1);
  // 送信済み・期限切れの行は数えない
  t("送信済み・期限切れの行は対象外", pickQualityTop([{ ...fb(70), status: "sent" }, { ...fb(70), expired: true }], null, 10).ids.length === 0);

  // defaultAixChecks（詳細を開いた時の既定のチェック）: しばらく送れていない判定は回の時刻と最後の送付で
  const round = { created_at: "2026-09-30T03:00:00Z", items: b };
  const chkNo = defaultAixChecks([round], null, 10, { lastProposalSentAt: "2026-09-29T03:00:00Z" });
  const chkStale = defaultAixChecks([round], null, 10, { lastProposalSentAt: "2026-09-20T03:00:00Z" });
  const chkUnknown = defaultAixChecks([round], null, 10, {});
  const chkNever = defaultAixChecks([round], null, 10, { lastProposalSentAt: null });
  t("既定のチェック: 昨日送った人は穴埋めなし", chkNo[b[3].id] === false && chkNo[b[0].id] === true);
  t("既定のチェック: 10日前に送った人（8日以上）は穴埋めが入る", chkStale[b[3].id] === true);
  t("既定のチェック: 送付が分からない／一度も送っていない人は「他に無い時だけ」に倒す", chkUnknown[b[3].id] === false && chkNever[b[3].id] === false);
  t("しばらくの線は 8日（自動検索の止まっている）", AD_UNDER1_STALE_DAYS === 8 && isStaleForAdUnder1("2026-09-30T00:00:00Z", "2026-09-22T00:00:00Z") && !isStaleForAdUnder1("2026-09-30T00:00:00Z", "2026-09-22T00:00:01Z") && !isStaleForAdUnder1("2026-09-30T00:00:00Z", null) && !isStaleForAdUnder1("2026-09-30T00:00:00Z", undefined) && !isStaleForAdUnder1("2026-09-30T00:00:00Z", "壊れた値"));
  t("最後の送付は届けたご提案だけ（共有・物件確認・見積書は数えない）", lastProposalSentAt([
    { sent_at: "2026-09-20T00:00:00Z", delivery: "customer", channel: "pickup" },
    { sent_at: "2026-09-28T00:00:00Z", delivery: "shared", source: "line_group" },
    { sent_at: "2026-09-27T00:00:00Z", delivery: "customer", channel: "check" },
    { sent_at: "2026-09-26T00:00:00Z", delivery: "customer", channel: "estimate" },
  ]) === "2026-09-20T00:00:00Z" && lastProposalSentAt([]) === null);

  // 画面の知らせ（理由が出る）
  const m1 = qualityPickMessage(qa.ids.length, qa.ngExcluded, 10, { adUnder1Excluded: qa.adUnder1Excluded, adUnder1Filled: qa.adUnder1Filled, adUnder1FillWhy: qa.adUnder1FillWhy });
  t("知らせ: ほかに選べる物件が無い理由と外した件数が出る", /AD1ヶ月未満（売上5万円以上）を2件入れました＝ほかに選べる物件が無いため/.test(m1) && /AD1ヶ月未満は選びません・2件/.test(m1), m1);
  const m2 = qualityPickMessage(4, 0, 10, { adUnder1Filled: 1, adUnder1FillWhy: "stale" });
  t("知らせ: しばらく新着を送れていない理由が出る", /しばらく新着を送れていないため/.test(m2), m2);
  t("知らせ: AD1未満が無ければ今まで通り", qualityPickMessage(3, 1, 10, {}) === "✨ 質の高い3件を選びました（10件に足りません・NG 条件・保留の物件は選びません・1件）", qualityPickMessage(3, 1, 10, {}));

  // 手で選んだ時の確認（審査中・商談中と同じ形）
  const msg = adUnder1ConfirmMessage([
    { reason_codes: ["AD_UNDER_1M_FALLBACK"], property_name: "ラパンジール恵美須2", room_no: "602" },
    { reason_codes: ["AD_UNDER_1M_NEVER"], property_name: "エスリード難波ザ・メゾン", room_no: "1001" },
    { reason_codes: ["AD_1M"], property_name: "普通の物件", room_no: null },
  ]);
  t("手で選んだ AD1未満は確認の文が出る（件数・名前・種類）", !!msg && /2件入っています/.test(msg) && /ラパンジール恵美須2 602：AD1未満（売上5万円以上）/.test(msg) && /エスリード難波ザ・メゾン 1001：AD1未満（1K か売上5万円未満）/.test(msg) && /このまま AIX に渡しますか/.test(msg) && !/普通の物件/.test(msg), msg);
  t("AD1未満が無ければ確認しない（null）", adUnder1ConfirmMessage([{ reason_codes: ["AD_HIGH"], property_name: "A" }]) === null && adUnder1ConfirmMessage([]) === null);
  t("旧の札・AD なしも確認に出る", !!adUnder1ConfirmMessage([{ reason_codes: ["AD_UNDER_1M"], property_name: "A" }]) && !!adUnder1ConfirmMessage([{ reason_codes: ["AD_NONE"], property_name: "B" }]));

  // 10件に絞る時（手でチェックが10件を超えた時）は AD1未満が先に外れる
  const many = [...normal(9), fb(70), { ...normal(1)[0], score: 999 }];
  const top = pickTopForAix([many[9], many[10], ...many.slice(0, 9)], null, 10);
  t("手で選んだ11件を10件に絞る時は AD1未満が先に外れる", top.length === 10 && !top.includes(many[9].id), top);
}

console.log("■ 実物の6行（保存の札のまま）を選び方に通す");
{
  // 2026-09-24〜30 の実物: 保存の札は旧の AD_UNDER_1M／AD_NONE（付け直していない）＝穴埋めに入らない（保存済みの行は付け直さない方針）
  const real: AixPickRow[] = [
    { id: 991, rank: 11, recommended: 0, score: 73, status: "pending", verdict: "hold", reason_codes: ["RENT_WIDE", "FLOOR_PLAN_MATCH", "SQM_OK", "MOVE_IN_UNKNOWN", "EQUIP_COUNTER_KITCHEN_NOT_UNLISTED", "AREA_WARD_MATCH", "WALK_NEAR_N", "AD_UNDER_1M"] },
    { id: 1708, rank: 5, recommended: 0, score: 122, status: "pending", verdict: "hold", reason_codes: ["RENT_OK", "ZERO_ZERO_MATCH", "FLOOR_PLAN_MATCH", "WALK_OK", "BUILDING_AGE_OK", "EQUIP_BLDG_TYPE_OK", "AREA_STATION_MATCH", "AGE_COL_W5", "RENT_CHEAP_W95", "AD_UNDER_1M", "SEARCH_PINPOINT_HELD"] },
    { id: 843, rank: 3, recommended: 0, score: 35, status: "pending", verdict: "hold", reason_codes: ["RENT_OK", "INITIAL_COST_NOT_ZERO", "FLOOR_PLAN_NEAR", "AD_NONE", "MOVE_IN_UNKNOWN", "SEARCH_PINPOINT_HELD"] },
  ];
  const q = pickQualityTop(real, null, 10, { staleSinceLastSend: true });
  t("保存の旧の札の行は（しばらくでも）既定の候補に入らない＝今までと同じ・AD1未満で外した件数に数える", q.ids.length === 0 && q.adUnder1Excluded === 2 && q.ngExcluded === 1 /* #843 は敷礼あり（INITIAL_COST_NOT_ZERO）の保留も持つので NG に数える */, q);
  t("保存の判定 hold の行は AD 1ヶ月未満のまま『送らない側』に近い扱い（legacy）", adUnder1KindOfCodes(real[0].reason_codes) === "legacy" && adUnder1KindOfCodes(real[2].reason_codes) === "never");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
