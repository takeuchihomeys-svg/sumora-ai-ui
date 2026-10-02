// app/lib/__tests__/final-check-overblock-1002.test.ts — 2026-10-02 人の文を止めていた2つの規則（実行: npx tsx app/lib/__tests__/final-check-overblock-1002.test.ts）
//   CONFIRM_NO_OBJECT: 確認の対象を前の文に書く形（実送信）を止めない／対象の無い確認約束（AI の創作）は止める
//   viewing_thanks（DONE_PRESUPPOSED_WITHOUT_EVIDENCE）: お客様がその日の内覧・時間にお礼を言っている時は止めない
import { runDeterministicChecks, type FinalCheckContext } from "../final-check";
import { checkDonePresupposition, buildActionLedger, CUSTOMER_VIEWING_HAPPENED_RE } from "../action-ledger";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
const NOW = Date.parse("2026-09-20T09:00:00Z");
const ctxOf = (cust: string, history: Array<{ sender: string; text: string }> = []): FinalCheckContext => ({
  lastCustomerMessage: cust, now: NOW,
  recentMessages: [...history, { sender: "customer", text: cust }].map((m, i) => ({ ...m, createdAt: new Date(NOW - (history.length + 1 - i) * 600_000).toISOString() })),
});
const confirmBlock = (text: string, ctx: FinalCheckContext) => runDeterministicChecks(text, ctx).some((i) => i.code === "CONFIRM_NO_OBJECT" && i.severity === "block");

console.log("■ CONFIRM_NO_OBJECT（実送信の形・名前は伏せた）");
t("対象が前の文（花園の駐車場）→ 止めない",
  !confirmBlock("Hさん\n本日はお時間頂きありがとうございました！！\n花園の駐車場の件、管理会社に確認させていただきます！！\n空き状況確認出来次第ご連絡させていただきます😊！！",
    ctxOf("今日はありがとうございました！\n花園の駐車場の確認だけお願いします🥹")));
t("対象が前の文（11月中旬のご入居）→ 止めない",
  !confirmBlock("お世話になっております！！\n改めて管理会社に11月中旬でのご入居が可能か交渉頂きます！！\n確認出来次第ご連絡させて頂きます😊！",
    ctxOf("早まることはあるかもですが主人の出張の兼ね合いで確実な入居日が11月中旬なら確実なのですが難しいでしょうか")));
t("対象の無い確認約束（お礼だけへの創作約束）→ 止める",
  confirmBlock("かしこまりました！！\n確認出来次第ご連絡させて頂きます！！", ctxOf("よろしくお願いします")));
t("中身の無い語（可能・交渉）だけでは対象とみなさない → 止める",
  confirmBlock("はい😊！！\n改めて可能か交渉させて頂きます！！\n確認出来次第ご連絡させて頂きます！！", ctxOf("よろしくお願いします", [{ sender: "staff", text: "初期費用のご相談も可能ですので、交渉させて頂きます！！" }])));

console.log("■ viewing_thanks（本日はご内覧頂きありがとうございました）");
const led = buildActionLedger({ messages: [{ sender: "customer", text: "中央大通りより北側でお願いします", created_at: new Date(NOW - 3600_000).toISOString() }] } as never);
const hit = (text: string, cust: string) => checkDonePresupposition(text, led, { customerMessage: cust, name: "" }).find((h) => h.key === "viewing_thanks");
t("お客様「本日はお時間を作っていただき、ありがとうございました」→ 免除", hit("あやぴさん本日お時間頂きありがとうございました！！", "承知致しました！\n本日はお時間を作っていただき、ありがとうございました！")?.exempt === "customer_viewing_happened");
t("お客様「本日も内覧をさせていただき、ありがとうございました」→ 免除", hit("萌花さん\n本日はご内覧いただきありがとうございました😊！！", "うらんちゃんの紹介で本日も内覧をさせていただき、ありがとうございました。")?.exempt === "customer_viewing_happened");
t("内覧の話の無い会話・お客様もお礼だけ（慶次事例）→ 止める", (() => { const h = hit("本日はご内覧頂きありがとうございました！！", "ありがとうございます\nよろしくお願いします"); return !!h && !h.exempt; })());
t("お礼だけの「ありがとうございました」は内覧の証拠にしない", !CUSTOMER_VIEWING_HAPPENED_RE.test("ありがとうございました！"));

console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
