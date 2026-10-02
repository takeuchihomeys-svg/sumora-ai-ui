// app/lib/__tests__/two-stage.test.ts — 2026-10-02 竹内さんの決定「2段の場面: 先に約束の返信・後で AIX」（実行: npx tsx app/lib/__tests__/two-stage.test.ts）
import { resolveTwoStage, TWO_STAGE_WORDING } from "../two-stage";
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
  t(`約束を果たす・待ちの判断（${src}）は AIX のまま`, resolveTwoStage({ ...base, finalAix: "property_send", decisionSource: src }) === null && resolveTwoStage({ ...base, finalAix: "property_check_result", decisionSource: src }) === null);
}
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
  t("ペットの可否の確認 → 今まで通り確認の約束", resolveTwoStage({ ...base, finalAix: "property_check_result", customerText: "ペット2匹飼えますか？" })?.source === "rule:two_stage_promise(check)");
}
t("申込以降は触らない", resolveTwoStage({ ...base, finalAix: "estimate_sheet", postApply: true }) === null);
t("他の AIX（内覧調整・申込へ）は触らない", resolveTwoStage({ ...base, finalAix: "viewing_invite" }) === null && resolveTwoStage({ ...base, finalAix: "application_push" }) === null);
function kinds0(x: string) { return classifyStaffTextFacts(x, null).filter((e) => e.status === "promised").map((e) => e.kind); }
// 約束の文が行動台帳で「約束」と読まれる（送った後に promise:* で AIX が立つ）
const kinds = (s: string) => classifyStaffTextFacts(s.replace("〇〇", "YUMA"), null).filter((e) => e.status === "promised").map((e) => e.kind);
t("ピックアップの約束の言い回し → pickup_declared", kinds(TWO_STAGE_WORDING.pickup).includes("pickup_declared"), JSON.stringify(kinds(TWO_STAGE_WORDING.pickup)));
t("確認の約束の言い回し → confirmation_promised", kinds(TWO_STAGE_WORDING.check).includes("confirmation_promised"), JSON.stringify(kinds(TWO_STAGE_WORDING.check)));
t("見積書の約束の言い回し → estimate_declared", kinds(TWO_STAGE_WORDING.estimate).includes("estimate_declared"), JSON.stringify(kinds(TWO_STAGE_WORDING.estimate)));
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
