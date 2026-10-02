// app/lib/__tests__/apply-sub-mode.test.ts
// 2026-10-02 竹内「こんなかんじじゃない。実際の言い回しを確認する。AIっぽい文となっている」（AIX【申込へ！】）の回帰テスト。
//   お客様の文は本番の実物（scripts/audit-apply-intent-wording.ts・名前は伏せた）。
// 実行: npx tsx app/lib/__tests__/apply-sub-mode.test.ts
import { isApplyDecision, decideApplySubMode, APPLICATION_FORMAT_RE } from "../apply-sub-mode";
import { classifyAixAutofill } from "../aix-autofill-readiness";
import { buildApplicationFormat } from "../application-format";
import { canAutoReply } from "../auto-reply-policy";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

console.log("── 申込を決めた番（スタッフは『かしこまりました！！／〇〇号室お申込みさせていただきます』）→ 申込確定");
for (const s of [
  "昨日はありがとうございました。\n\n一つ目の福島駅の物件の申し込みをお願いしたいです。",
  "江坂の方よろしくお願いします\n審査一旦通してもらって行けそうでしたら今月お金振り込みます",
  "申し込みお願いします",
  "この物件で決めます。",
  "この物件審査通して欲しいです",
  "なるほど！ドミール諦めて\nここに決めます！！",
  "それでは608で申し込みしたいです！",
  "ありがとうございます！\nぜひ申し込みさせていただきたいです！",
  "ここも埋まると困るので一旦申し込みおねがいします！",
  "でしたらRenatus新大阪の方で1度審査通して頂いてもよろしいでしょうか？",
]) {
  t(`確定: ${s.replace(/\n/g, " / ").slice(0, 40)}`, isApplyDecision(s) && decideApplySubMode({ customerText: s }).mode === "confirm");
}

console.log("── 確定にしない（条件付き・質問・他社・条件フォーム）");
for (const s of [
  "ありがとうございます！ 大丈夫ならすぐ申し込みします！",
  "二匹大丈夫なら明日申し込みお願いします！",
  "カシータがいけましたらそこに決めます！",
  "申し込んでもいいですか？",
  "他の不動産屋で審査通しており返信していなかったのですが、そちらで物件決まりました。",
  "【お部屋お探し中！】\n（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒10/1\n⑧【その他ご要望あれば】⇒ここに決めます",
]) {
  t(`確定でない: ${s.replace(/\n/g, " / ").slice(0, 40)}`, !isApplyDecision(s));
}

console.log("── 迷い・申込書の後");
t("迷い → 申込誘導", decideApplySubMode({ customerText: "どっちにしようか迷ってます" }).mode === "push");
t("申込書を送った後の書類の話 → 書類依頼", decideApplySubMode({ customerText: "免許証の裏も送りますね", recentStaffTexts: ["【お申込者様記入欄】\n・入居希望日"] }).mode === "docs_request");

console.log("── 自動反映（テストの道具・見張り）も同じ形で作る");
{
  const a = classifyAixAutofill({ action: "application_push", customerText: "一つ目の福島駅の物件の申し込みをお願いしたいです。", propertyName: "S-RESIDENCE福島Luxe 1308号室" });
  t("申込確定＋物件名を渡す", a.request?.app_sub_mode === "confirm" && a.request?.property_name === "S-RESIDENCE福島Luxe 1308号室", JSON.stringify(a.request));
  t("申込へは自動では送らない（作れる≠送ってよい）", a.autoSend.ok === false);
  const b = classifyAixAutofill({ action: "application_push", customerText: "ありがとうございます！検討してみます" });
  t("決めていない → 申込誘導", b.request?.app_sub_mode === "push", JSON.stringify(b.request));
}

console.log("── 申込確定の2行の後のフォーマットは AIX で止める（2026-10-02 竹内「ここはAIXでいまはスタッフが送る形にするので、AIXで止めておく」）");
{
  const staff = ["🌟S-RESIDENCE福島Luxe 1308号室…", "かしこまりました！！\nS-RESIDENCE福島Luxe 1308号室お申込みさせていただきます😊！！"];
  const d = decideApplySubMode({ customerText: "よろしくお願いします！", recentStaffTexts: staff });
  t("確定の2行の後 → 次は申込フォーマット", d.mode === "format", JSON.stringify(d));
  const a = classifyAixAutofill({ action: "application_push", customerText: "よろしくお願いします！", staffTexts: staff });
  t("フォーマットは自動では作らない（staff_confirm・request なし）", a.level === "staff_confirm" && a.request === null, JSON.stringify(a));
  t("申込へは自動で送らない（autoSend=false）", a.autoSend.ok === false);
  t("誘導の文（お申込しお部屋抑えさせて頂きます）は確定の2行と読まない", decideApplySubMode({ customerText: "ありがとうございます", recentStaffTexts: ["お気に召されましたらお申込しお部屋抑えさせて頂きます😌！！"] }).mode === "push");
  t("申込フォーマットの文は自動返信に積まない形と読める", APPLICATION_FORMAT_RE.test(buildApplicationFormat("single", "emergency")) && APPLICATION_FORMAT_RE.test(buildApplicationFormat("shared", "guarantor")));
  t("普通の文は当たらない", !APPLICATION_FORMAT_RE.test("かしこまりました！！\nお部屋お申込みさせていただきます😊！！"));
  const v = canAutoReply({ autoSendEnabled: true, lastSender: "customer", replyMode: "aix", suggestedAixAction: "application_push", draft: "かしこまりました！！お部屋お申込みさせていただきます😊！！", draftHasBlock: false, status: "viewing", hasPendingScheduled: false } as Parameters<typeof canAutoReply>[0]);
  t("ブレインが申込へ（AIX）の番は自動返信しない", !v.ok, JSON.stringify(v));
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
