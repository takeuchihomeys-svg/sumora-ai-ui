// app/lib/__tests__/two-stage.test.ts — 2026-10-02 竹内さんの決定「2段の場面: 先に約束の返信・後で AIX」（実行: npx tsx app/lib/__tests__/two-stage.test.ts）
import { resolveTwoStage, TWO_STAGE_WORDING, twoStageOtherQuestions, freshPickupReady, broughtPropertyAsk, broughtPropertyCount, conditionChangedThisTurn } from "../two-stage";
import { resolveStaffPromiseAix } from "../aix-task-link";
import { classifyStaffTextFacts } from "../action-ledger";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
const base = { decisionSource: "llm", pickupReady: false, postApply: false };

t("物件ピックアップ・送れる物件なし → 約束の返信（pickup）", resolveTwoStage({ ...base, finalAix: "property_send" })?.kind === "pickup");
t("物件ピックアップ・売上サポに送れる物件あり → AIX のまま", resolveTwoStage({ ...base, finalAix: "property_send", pickupReady: true }) === null);
t("物件確認した（持ち込み・確認の約束なし）→ 約束の返信（check）", resolveTwoStage({ ...base, finalAix: "property_check_result" })?.kind === "check");
t("確認します → 約束の返信（check）＝AIX【確認します】をブレインの候補から外す", resolveTwoStage({ ...base, finalAix: "acknowledge_check" })?.kind === "check");
t("費用も聞いている確認 → 募集状況と御見積書の約束", /御見積書/.test(resolveTwoStage({ ...base, finalAix: "property_check_result", asksCost: true })?.direction ?? ""));
t("見積書送る（見積書なし）→ 約束の返信（estimate）・物件名つき", /エスリード難波の最大限割引/.test(resolveTwoStage({ ...base, finalAix: "estimate_sheet", estimateTarget: "エスリード難波" })?.direction ?? ""));
for (const src of ["promise:pickup", "promise:check", "promise:estimate", "signal:pending_pickup", "rule:closed_ack_wait", "correction:check_already_declared"]) {
  t(`約束を果たす・待ちの判断（${src}）は AIX のまま`, resolveTwoStage({ ...base, finalAix: "property_send", decisionSource: src, pickupReady: true }) === null && resolveTwoStage({ ...base, finalAix: "property_check_result", decisionSource: src }) === null);
}
// 2026-10-02 ⑫（本番 60日: 送れる物件が無いピックアップの約束の番でスタッフが物件の AIX を押したのは 18%）
for (const src of ["promise:pickup", "signal:pending_pickup"]) t(`送れる物件が無い時のピックアップの約束（${src}）→ 約束の返信`, resolveTwoStage({ ...base, finalAix: "property_send", decisionSource: src })?.kind === "pickup");
// 2026-10-07 3巡目: 約束の直後のお礼・了承だけの番は約束の言い直しにしない（本番 120日 199番の 80% はスタッフが打たずに後で果たす）
for (const src of ["promise:pickup", "signal:pending_pickup"]) t(`約束の直後のお礼だけ（${src}）→ AIX のまま（下書きなし）`, resolveTwoStage({ ...base, finalAix: "property_send", decisionSource: src, ackRightAfterPromise: true }) === null);
t("お礼でもこちらの最後が約束でない（ackRightAfterPromise=false）→ 今まで通り約束の返信", resolveTwoStage({ ...base, finalAix: "property_send", decisionSource: "signal:pending_pickup", ackRightAfterPromise: false })?.kind === "pickup");
t("LLM のピックアップ（約束の外）はお礼の印があっても今まで通り", resolveTwoStage({ ...base, finalAix: "property_send", decisionSource: "llm", ackRightAfterPromise: true })?.kind === "pickup");
// 3巡目（10/07・A2）: LLM の物件確認したでも、募集状況でない質問は聞かれた事への答え（無ければその事の確認の約束）
t("設備の質問に物件確認した → 聞かれた事への答え", resolveTwoStage({ ...base, finalAix: "property_check_result", customerText: "ここって宅配ボックスありますか？" })?.source === "rule:two_stage_promise(check_question)");
t("空きの質問に物件確認した → 今まで通り募集状況の約束", resolveTwoStage({ ...base, finalAix: "property_check_result", customerText: "まだ空いてますか？" })?.source === "rule:two_stage_promise(check)");
t("URL の持ち込み → 今まで通り募集状況の約束", resolveTwoStage({ ...base, finalAix: "property_check_result", customerText: "https://suumo.jp/x ここはどうですか？" })?.source === "rule:two_stage_promise(check)");
// 3巡目（10/07）: 送れる物件は新しさで（古い pending は数えない）
{
  const now = Date.parse("2026-10-07T03:00:00Z");
  t("最後の送付より後・3日以内の候補 → 送れる", freshPickupReady([{ created_at: "2026-10-06T03:00:00Z" }], { lastPropertiesSentAt: "2026-10-05T00:00:00Z", nowMs: now, env: {} }));
  t("最後の送付より前の候補（選ばれなかった残り）→ 送れない", !freshPickupReady([{ created_at: "2026-10-04T03:00:00Z" }], { lastPropertiesSentAt: "2026-10-05T00:00:00Z", nowMs: now, env: {} }));
  t("4日前の候補 → 送れない", !freshPickupReady([{ created_at: "2026-10-03T00:00:00Z" }], { lastPropertiesSentAt: null, nowMs: now, env: {} }));
  t("期限切れ → 送れない", !freshPickupReady([{ created_at: "2026-10-06T23:00:00Z", expired_at: "2026-10-07T00:00:00Z" }], { lastPropertiesSentAt: null, nowMs: now, env: {} }));
  t("PICKUP_READY_FRESH=off は今まで通り（有無だけ）", freshPickupReady([{ created_at: "2026-09-01T00:00:00Z" }], { lastPropertiesSentAt: null, nowMs: now, env: { PICKUP_READY_FRESH: "off" } }));
}
t("見積書の約束（promise:estimate）は今まで通り AIX", resolveTwoStage({ ...base, finalAix: "estimate_sheet", decisionSource: "promise:estimate" }) === null);
{ // 16巡 other_45: 元が確認します（夜職の審査など）→ 募集状況に寄せず聞かれた事の確認の約束
  const v = resolveTwoStage({ ...base, finalAix: "property_check_result", decisionSource: "llm+ack_to_check" });
  t("元が確認します → 聞かれた事を確認する約束（募集状況・管理会社と書かせない）", v?.kind === "check" && /聞かれた事/.test(v.direction) && !/「お部屋の募集状況/.test(v.direction), v?.direction);
  t("元が物件確認した → 募集状況の約束のまま", /募集状況確認させていただきます/.test(resolveTwoStage({ ...base, finalAix: "property_check_result" })?.direction ?? ""));
  t("聞かれた事の確認の約束の結び → confirmation_promised", kinds0("夜職の方でのご入居の可否確認させて頂きます！！確認出来次第ご連絡させて頂きます！！").includes("confirmation_promised"));
}
{ // 最後の確かめ other_45: 夜職のアリバイ会社 → 確認の約束にせずお仕事面のサポート（実送信の形）
  const v = resolveTwoStage({ ...base, finalAix: "property_check_result", decisionSource: "llm+ack_to_check", customerText: "夜職なのですがアリバイ会社使えますか？" });
  t("アリバイの質問 → お仕事面のサポート（管理会社に確認と書かせない）", v?.source === "rule:two_stage_promise(work_support)" && /お仕事面こちらでサポート/.test(v.direction), v?.direction);
  t("勤務先を空欄で → お仕事面のサポート", resolveTwoStage({ ...base, finalAix: "property_check_result", customerText: "勤務先は空欄でよろしいですか？" })?.source === "rule:two_stage_promise(work_support)");
  t("アリバイの質問に保証会社について → お仕事面のサポート", resolveTwoStage({ ...base, finalAix: "guarantor_info", customerText: "夜職なのですがアリバイ会社使えますか？" })?.source === "rule:two_stage_promise(work_support)");
  t("保証会社の質問の保証会社について → AIX のまま", resolveTwoStage({ ...base, finalAix: "guarantor_info", customerText: "保証会社はどこになりますか？" }) === null);
  // 3巡目（A2）: ペットの可否は募集状況ではない＝聞かれた事への答え（資料に無ければペットの可否を確認する約束）
  t("ペットの可否の確認 → 聞かれた事（ペット）への答え・無ければその確認の約束", resolveTwoStage({ ...base, finalAix: "property_check_result", customerText: "ペット2匹飼えますか？" })?.source === "rule:two_stage_promise(check_question)");
}
{ // 2026-10-06 ⑫ ゆいと（10/03 の実物）: ピックアップの約束と別の質問も必須に
  const q = twoStageOtherQuestions("見てきました。\nここは最短11月中旬でしょうか？\n10月後半くらいに入れるところとかありますか？", "pickup");
  t("別の質問（最短11月中旬でしょうか？）を必須の話題に・約束が答えになる問いは外す", q.length === 1 && q[0].includes("最短11月中旬でしょうか"), JSON.stringify(q));
}
t("申込以降は触らない", resolveTwoStage({ ...base, finalAix: "estimate_sheet", postApply: true }) === null);
t("他の AIX（内覧調整・申込へ）は触らない", resolveTwoStage({ ...base, finalAix: "viewing_invite" }) === null && resolveTwoStage({ ...base, finalAix: "application_push" }) === null);
function kinds0(x: string) { return classifyStaffTextFacts(x, null).filter((e) => e.status === "promised").map((e) => e.kind); }
// 約束の文が行動台帳で「約束」と読まれる（送った後に promise:* で AIX が立つ）
const kinds = (s: string) => classifyStaffTextFacts(s.replace("〇〇", "YUMA"), null).filter((e) => e.status === "promised").map((e) => e.kind);
t("ピックアップの約束の言い回し → pickup_declared", kinds(TWO_STAGE_WORDING.pickup).includes("pickup_declared"), JSON.stringify(kinds(TWO_STAGE_WORDING.pickup)));
t("確認の約束の言い回し → confirmation_promised", kinds(TWO_STAGE_WORDING.check).includes("confirmation_promised"), JSON.stringify(kinds(TWO_STAGE_WORDING.check)));
t("見積書の約束の言い回し → estimate_declared", kinds(TWO_STAGE_WORDING.estimate).includes("estimate_declared"), JSON.stringify(kinds(TWO_STAGE_WORDING.estimate)));
// ── 10/07 竹内さんの決定①: 見積の依頼は約束の返信（文はスタッフの実送信の型）→ 後で AIX【見積書送る】 ──
{
  const v = resolveTwoStage({ ...base, finalAix: "estimate_sheet", decisionSource: "signal:focused_estimate_request", estimateTarget: "エスリード難波" });
  t("見積の依頼（こちらが送ったお部屋）→ 約束の返信（estimate）・初期費用の御見積書・物件名つき", v?.kind === "estimate" && /エスリード難波の最大限割引させていただいた初期費用の御見積書を作成しお送り/.test(v?.direction ?? ""), v?.direction);
  t("見積の依頼（LLM の見積書送る）→ 約束の返信", resolveTwoStage({ ...base, finalAix: "estimate_sheet", asksCost: true })?.kind === "estimate");
  t("見積書の後の総額の確認（S6）も約束の返信", resolveTwoStage({ ...base, finalAix: "estimate_sheet", decisionSource: "signal:scene_S6_amount_confirm" })?.kind === "estimate");
  t("約束を果たす番（promise:estimate）は AIX【見積書送る】のまま", resolveTwoStage({ ...base, finalAix: "estimate_sheet", decisionSource: "promise:estimate" }) === null);
  const w = "かしこまりました！！\nエスリード難波の最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます😊！！";
  t("見積の約束の文 → 台帳の estimate_declared（後で見積書送るが立つ）", kinds(w).includes("estimate_declared"), JSON.stringify(kinds(w)));
  const link = resolveStaffPromiseAix({ lastStaffEntry: { kind: "estimate_declared", status: "promised" }, estimatePromisedUnfulfilled: true, pickupPromisedUnfulfilled: false, confirmationPromisedUnfulfilled: false } as never,
    [{ sender: "customer", text: "ここの初期費用いくらですか？" }, { sender: "staff", text: w }] as never, { propertyInPlay: true } as never);
  t("約束を送った後 → AIX【見積書送る】（aix-task-link）", link?.action === "estimate_sheet", JSON.stringify(link));
}
// ── 10/07 竹内さんの決定（けんじじ）: 持ち込みの約束は 募集状況＋最大限割引の初期費用の御見積書 の両方・件数を書く ──
{
  const two = resolveTwoStage({ ...base, finalAix: "property_check_result", customerText: "", brought: { ask: "none", count: 2 } });
  t("持ち込み2件・物件確認した → 両方の約束・「2件の」", two?.source === "rule:two_stage_promise(brought_both)" && /2件の募集状況確認/.test(two?.direction ?? "") && /初期費用の御見積書/.test(two?.direction ?? ""), two?.direction);
  const est = resolveTwoStage({ ...base, finalAix: "estimate_sheet", customerText: "この二つで初期費用出してもらえたら嬉しいです！", brought: { ask: "cost", count: 2 } });
  t("持ち込み・費用だけ聞いた（見積書送る）→ それでも両方（実送信の過半数）・御見積書を先に書いてよい", est?.kind === "check" && /募集状況/.test(est?.direction ?? "") && /御見積書の事を先に/.test(est?.direction ?? ""), est?.direction);
  const one = resolveTwoStage({ ...base, finalAix: "property_check_result", customerText: "この物件空いてるか調べてもらえますか？", brought: { ask: "vacancy", count: 1 } });
  t("持ち込み1件・空きだけ聞いた → 両方（「物件の」）", /お送り頂きました物件の募集状況確認させて頂きます/.test(one?.direction ?? "") && /御見積書/.test(one?.direction ?? ""), one?.direction);
  t("確認の約束を既にしている（correction:check_already_declared）は AIX のまま", resolveTwoStage({ ...base, finalAix: "property_check_result", decisionSource: "correction:check_already_declared", brought: { ask: "none", count: 1 } }) === null);
  t("申込以降は触らない", resolveTwoStage({ ...base, finalAix: "property_check_result", postApply: true, brought: { ask: "none", count: 1 } }) === null);
  t("物件ピックアップ（条件の言い直し）は持ち込みがあってもピックアップの約束", resolveTwoStage({ ...base, finalAix: "property_send", brought: { ask: "none", count: 1 } })?.kind === "pickup");
  const prev = process.env.TWO_STAGE_BROUGHT_BOTH; process.env.TWO_STAGE_BROUGHT_BOTH = "off";
  t("TWO_STAGE_BROUGHT_BOTH=off で今まで（募集状況だけ）", !/御見積書/.test(resolveTwoStage({ ...base, finalAix: "property_check_result", brought: { ask: "none", count: 1 } })?.direction ?? ""));
  if (prev === undefined) delete process.env.TWO_STAGE_BROUGHT_BOTH; else process.env.TWO_STAGE_BROUGHT_BOTH = prev;
  const bw = "かしこまりました！！\nお送り頂きました2件の募集状況確認させて頂きます😊！！確認出来次第、最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます！！";
  t("両方の約束の文 → 台帳は見積の約束＋確認の約束", kinds(bw).includes("estimate_declared") && kinds(bw).includes("confirmation_promised"), JSON.stringify(kinds(bw)));
  const link = resolveStaffPromiseAix({ lastStaffEntry: { kind: "estimate_declared", status: "promised" }, estimatePromisedUnfulfilled: true, pickupPromisedUnfulfilled: false, confirmationPromisedUnfulfilled: true } as never,
    [{ sender: "customer", text: "https://suumo.jp/chintai/jnc_1/" }, { sender: "staff", text: bw }] as never, { propertyInPlay: true, customerRequestedCheck: true } as never);
  t("両方の約束の後（お客様の物件確認の依頼）→ AIX【物件確認した】（御見積書同封）", link?.action === "property_check_result", JSON.stringify(link));
  t("お客様の言葉: 費用だけ／空きだけ／両方／なし", broughtPropertyAsk("この二つで初期費用出してもらえたら嬉しいです！") === "cost" && broughtPropertyAsk("この物件空いてるか調べてもらえますか？") === "vacancy"
    && broughtPropertyAsk("ここ空いてますか？初期費用もしりたいです") === "both" && broughtPropertyAsk("https://suumo.jp/chintai/jnc_1/\nby SUUMO") === "none");
  t("件数: URL（同じ物は1件）＋画像", broughtPropertyCount(["https://suumo.jp/a/?x=1", "https://suumo.jp/a/?x=2", "[画像] 物件情報", "ここ"]) === 2);
  t("2段の他の質問: 確認の約束でも費用の問いは約束が答え", twoStageOtherQuestions("ここの初期費用いくらですか？", "check").length === 0);
}
// 2026-10-07 5巡目: 室内写真の依頼（S11）は手元に室内イメージがあれば AIX を直接・無ければ撮影の約束
{
  const s11 = { ...base, finalAix: "property_check_result", decisionSource: "signal:scene_S11_room_photo", customerText: "この部屋の中って写真もらう事とかってできますか？" };
  t("室内写真・手元にある → AIX のまま", resolveTwoStage({ ...s11, roomPhoto: { atHand: true } }) === null);
  const v = resolveTwoStage({ ...s11, roomPhoto: { atHand: false } });
  t("室内写真・手元にない → 撮影の約束", v?.source === "rule:two_stage_promise(room_photo_shoot)" && /撮影出来次第/.test(v?.direction ?? ""));
  t("室内写真の印が無い時（旧）→ 質問の答えの約束", resolveTwoStage(s11)?.source === "rule:two_stage_promise(check_question)");
}
// 2026-10-07 5巡目: 条件が変わった番は売上サポの候補があっても約束の文を先に（brain-core の pickupReady を外す判定）
t("条件の言い直し（area_change）→ 変わった", conditionChangedThisTurn("area_change", "question"));
t("場面が conditions（「塚本駅、加島駅では同じ価格帯の物件ありますか？」）→ 変わった", conditionChangedThisTurn(null, "conditions"));
t("ピックアップの依頼だけ（pickup_request）・場面が質問 → 変わっていない", !conditionChangedThisTurn("pickup_request", "question"));
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
