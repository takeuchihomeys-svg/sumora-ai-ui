// app/lib/__tests__/staff-confirm-facts.test.ts
// 2026-10-02 竹内さんの決定「スタッフの確認が要る物は AIX で止める（自動で送らない）」の回帰テスト。
//   下書きの文は返信生成の実物（scripts/audit-staff-confirm-facts.ts で出た物・名前なし）。
// 実行: npx tsx app/lib/__tests__/staff-confirm-facts.test.ts
import { aixAutoSendGate, findStaffOnlyFact, STAFF_CONFIRM_AIX, findUngroundedAmount, findUngroundedAgeRange } from "../staff-confirm-facts";
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

console.log("── 2026-10-02 ⑫ 会話に無い金額の言い切り（YUMA 再生 cost_12 の実物）");
{
  const draft = "YUMAさんお世話になっております！！\n堺筋本町駅周辺は10万円〜11万円台からお部屋が出てきます！！";
  const ground = "家賃をいくらまでにしたら、堺筋本町あたりに物件が出てきますか？\n②【ご希望の家賃（◯万円〜◯万円）】⇒9万まで";
  t("会話に無い 10万・11万 → 当たる", !!findUngroundedAmount(draft, ground));
  t("会話にある金額だけ → 当たらない", !findUngroundedAmount("家賃9万円までのお部屋をピックアップさせて頂きます！！", ground));
  t("90,000円 と 9万 を同じ金額として読む", !findUngroundedAmount("家賃90,000円のお部屋です", ground));
  t("会社の決まった金額（2,980円）は当てない", !findUngroundedAmount("初期費用2,980円＋前家賃で", ground));
  t("根拠が渡されない時は判定しない", !findUngroundedAmount(draft, null));
  t("お客様の「65,000まで」（円なし）を根拠に読む（11巡目 first_contact_02）", !findUngroundedAmount("西淀川区内から家賃65,000円まで・二人入居可のお部屋をピックアップ", "2、65,000まで"));
  const v = canAutoReply({ autoSendEnabled: true, lastSender: "customer", replyMode: "auto_reply", suggestedAixAction: null, draft, draftHasBlock: false, status: "proposing", hasPendingScheduled: false, groundText: ground });
  t("canAutoReply: 自動で送らない（本文は変えない）", !v.ok && v.reason === "staff_only_fact:ungrounded_amount", JSON.stringify(v));
}

// 2026-10-02 ⑫ 21巡（flow23_db3722_t05 の実物）: 会話に無い築年数の幅は自動で送らない
{
  const d = "かしこまりました！！\n\n初期費用10万以下・家賃5万円台ですと、傾向として築年数は古め（15〜25年程）の物件が多くなりますが、エリアによっては比較的新しいお部屋もございます😊";
  const v = canAutoReply({ autoSendEnabled: true, lastSender: "customer", replyMode: "auto_reply", suggestedAixAction: null, draft: d, draftHasBlock: false, status: "proposing", hasPendingScheduled: false, groundText: "初期費用を10万以下と家賃5万円代の物件ってやはり築が古くなりますか？" });
  t("築年数の幅（15〜25年）→ ungrounded_age", !v.ok && v.reason === "staff_only_fact:ungrounded_age", JSON.stringify(v));
  t("お客様の条件の築年数（築20年以内）は当てない", findUngroundedAgeRange("築20年以内のお部屋をピックアップさせて頂きます", "築20年以内") === null);
}
// 2026-10-02 ⑫ 19巡（phone_17 の実物）: こちらから電話をかける約束は自動で送らない
t("今お電話いたします → phone_call_promise", findStaffOnlyFact("かしこまりました！！\n電話番号確認しました！！\n今お電話いたします！！")?.kind === "phone_call_promise");
t("折り返しお電話させて頂きます → phone_call_promise", findStaffOnlyFact("折り返しお電話させて頂きます！！")?.kind === "phone_call_promise");
for (const d of ["19時までですと何時でもお電話可能です😊！！", "お電話お待ちしております！！", "こちらの電話をかけるボタンよりお電話お願い致します！！", "お電話ありがとうございました😊！！"]) {
  t(`電話の案内・お礼は当てない: ${d}`, findStaffOnlyFact(d) === null);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
