// スタッフの「お部屋探しの再開を勧める文」をピックアップの約束にしない（app/lib/resume-advice.ts・action-ledger の切替）— LLM なし
// 実行: npx tsx app/lib/__tests__/resume-advice.test.ts（全 PASS で exit 0）
import { isCustomerSearchAdvice, ledgerResumeAdviceEnabled, pickupDeclSentence } from "../resume-advice";
import { classifyStaffTextFacts, STAFF_PICKUP_DECL_RE } from "../action-ledger";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

// 実物（響夢さん 10/17 11:29 のスタッフの文・お客様の名前は伏せた）
const ADVICE = "〇〇さん\nお世話になっております！！\nお申込みからご入居まで1ヶ月以内でのご入居がほとんどのお部屋となります！！\n\n12月末ごろお引っ越しご予定ですと1ヶ月前の11月末ごろにお部屋のお申し込みいただくとスムーズに審査契約手続きが進む形となります！！\n\n12月末から1月前半ごろにお引っ越し予定お変わりない場合11月中旬ごろからお部屋探し再開いただくのをオススメ致します😊！！";
const PROMISE = "かしこまりました！！\nご条件に合ったお部屋をピックアップしてお送りさせて頂きます😊！！";
const BOTH = "11月中旬ごろからお部屋探し再開いただくのをオススメ致します！！\nそれまでに新着で良いお部屋が出ましたらピックアップしてお送りさせて頂きます！！";

console.log("resume-advice");
it("切替は既定 off", () => {
  eq(ledgerResumeAdviceEnabled({}), false);
  eq(ledgerResumeAdviceEnabled({ LEDGER_RESUME_ADVICE_NOT_PROMISE: "on" }), true);
});
it("勧めの文を見分ける", () => {
  eq(isCustomerSearchAdvice("11月中旬ごろからお部屋探し再開いただくのをオススメ致します😊！！"), true);
  eq(isCustomerSearchAdvice("11月頃からお探し始めていただくのがスムーズです"), false); // 「始めて」は網の外（語を増やす時は実送信で線を引く）
  eq(isCustomerSearchAdvice("お部屋探し開始していただくとスムーズです！！"), true);
  eq(isCustomerSearchAdvice("ピックアップしてお送りさせて頂きます"), false);
  eq(isCustomerSearchAdvice("お部屋探し全力でサポートさせて頂きます"), false);
  eq(isCustomerSearchAdvice("引き続きお部屋探しさせていただきます"), false);
});
it("文の選び: off は今まで通り・on は勧めを飛ばす", () => {
  const ss = BOTH.split("\n");
  eq(pickupDeclSentence(ss, STAFF_PICKUP_DECL_RE, false)?.sentence, ss[0]);
  eq(pickupDeclSentence(ss, STAFF_PICKUP_DECL_RE, true)?.sentence, ss[1]);
  eq(pickupDeclSentence([ss[0]], STAFF_PICKUP_DECL_RE, true), null);
});
it("台帳: off は今まで通り約束（響夢さんの文）", () => {
  delete process.env.LEDGER_RESUME_ADVICE_NOT_PROMISE;
  eq(classifyStaffTextFacts(ADVICE, null).map((e) => e.kind), ["pickup_declared"]);
});
it("台帳: on は勧めの文を約束にしない・本当の約束は残す", () => {
  process.env.LEDGER_RESUME_ADVICE_NOT_PROMISE = "on";
  try {
    eq(classifyStaffTextFacts(ADVICE, null).some((e) => e.kind === "pickup_declared"), false);
    eq(classifyStaffTextFacts(PROMISE, null).map((e) => e.kind), ["pickup_declared"]);
    const both = classifyStaffTextFacts(BOTH, null).find((e) => e.kind === "pickup_declared");
    eq(!!both, true);
    eq(/新着/.test(String(both?.detail.sentence ?? "")), true);
  } finally { delete process.env.LEDGER_RESUME_ADVICE_NOT_PROMISE; }
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
