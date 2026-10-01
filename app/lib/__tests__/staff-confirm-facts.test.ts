// app/lib/__tests__/staff-confirm-facts.test.ts
// 2026-10-02 竹内さんの決定「スタッフの確認が要る物は AIX で止める（自動で送らない）」の回帰テスト。
//   下書きの文は返信生成の実物（scripts/audit-staff-confirm-facts.ts で出た物・名前なし）。
// 実行: npx tsx app/lib/__tests__/staff-confirm-facts.test.ts
import { aixAutoSendGate, findStaffOnlyFact, STAFF_CONFIRM_AIX } from "../staff-confirm-facts";
import { canAutoReply, type AutoReplyInput } from "../auto-reply-policy";
import { classifyAixAutofill } from "../aix-autofill-readiness";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

console.log("── AIX の種類: スタッフの確認が要る物は自動で送らない");
for (const a of ["property_check_result", "acknowledge_check", "estimate_sheet", "meeting_place", "viewing_invite", "application_push", "cost_explain", "cost_breakdown", "guarantor_info", "property_send", "property_recommendation"]) {
  const g = aixAutoSendGate(a);
  t(`${a} → 送らない`, !g.ok && g.reason === `staff_confirm:${a}`, JSON.stringify(g));
}
t("知らない AIX も送らない（迷ったら人）", !aixAutoSendGate("something_new").ok);
t("AIX なしは対象外（no_action）", aixAutoSendGate(null).reason === "no_action");
t("条件ヒアリング・電話は確認の要らない AIX", aixAutoSendGate("condition_hearing").ok && aixAutoSendGate("phone_call").ok);
t("申込へは確認の要る側（同居人の有無）", /同居人/.test(STAFF_CONFIRM_AIX.application_push));

console.log("── 自動反映の度合い（作れる）と送ってよいか（送らない）は別");
{
  const ap = classifyAixAutofill({ action: "application_push", customerText: "608で申し込みしたいです" });
  t("申込へは入力なしで作れても autoSend=false", ap.level === "auto" && ap.autoSend.ok === false, JSON.stringify(ap.autoSend));
  const pc = classifyAixAutofill({ action: "property_check_result", customerText: "こちら３階は空きありますか？" });
  t("物件確認した は autoSend=false", pc.autoSend.ok === false);
  const ch = classifyAixAutofill({ action: "condition_hearing", customerText: "難波周辺でワンルーム探してます" });
  t("条件ヒアリングは autoSend=true", ch.autoSend.ok === true);
}

console.log("── 返信の下書きの言い切り（実物）");
const hits: Array<[string, string]> = [
  ["グレース金岡 102号室は現在空室となっておりますので、お申込から最短2週間程でご入居頂けます！", "vacancy"],
  ["6件もお申込み入っている状況となります！", "vacancy"],
  ["現在募集中のお部屋は全室空室となっております😊！", "vacancy"],
  ["①見積書の初期費用：133,175円", "estimate_amount"],
  ["9/19 12:00に現地にてお待ちしております！", "viewing_fixed"],
  ["待ち合わせ場所は大阪府大阪市北区天満3丁目5-2 エントランス前となります！", "meeting_address"],
];
for (const [s, kind] of hits) t(`止める（${kind}）: ${s.slice(0, 30)}`, findStaffOnlyFact(s)?.kind === kind, JSON.stringify(findStaffOnlyFact(s)));
const keeps = [
  "お送り頂きました物件の募集状況確認させて頂きます😊！！確認出来次第ご連絡させて頂きます！！",
  "空いていればご案内させて頂きます！！",
  "申込が入っているお部屋でもご内覧は可能です😊！",
  "家賃7万円以内でお探しさせて頂きます！！",
  "初期費用は最大限割引させて頂き、出来る限り抑えさせて頂きます！！",
  "初期費用10万円以内のお部屋を中心にピックアップさせて頂きます！！",
];
for (const s of keeps) t(`止めない: ${s.slice(0, 30)}`, findStaffOnlyFact(s) === null, JSON.stringify(findStaffOnlyFact(s)));

console.log("── canAutoReply（自動返信の関所）");
const base: AutoReplyInput = { autoSendEnabled: true, lastSender: "customer", replyMode: "auto_reply", suggestedAixAction: null, draft: "", draftHasBlock: false, status: "proposing", hasPendingScheduled: false };
{
  const v = canAutoReply({ ...base, draft: "かしこまりました！！\nグレース金岡 102号室は現在空室となっておりますので、お申込から最短2週間程でご入居頂けます！" });
  t("空室の言い切り → staff_only_fact:vacancy", !v.ok && v.reason === "staff_only_fact:vacancy", JSON.stringify(v));
  const ok = canAutoReply({ ...base, draft: "かしこまりました！！\nお送り頂きました物件の募集状況確認させて頂きます😊！！確認出来次第ご連絡させて頂きます！！" });
  t("確認の宣言だけ → 送ってよい", ok.ok, JSON.stringify(ok));
  const aix = canAutoReply({ ...base, draft: "確認させて頂きます！！", suggestedAixAction: "property_check_result" });
  t("AIX（物件確認した）が付いていれば送らない", !aix.ok && aix.reason === "aix_suggested");
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
