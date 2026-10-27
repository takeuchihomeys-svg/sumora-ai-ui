// 下書きが触れた会社の事実を最終チェックに渡す（app/lib/company-facts-by-draft.ts・FC_COMPANY_FACTS_BY_DRAFT）— 実物の文（名前なし）・LLM なし
// 実行: npx tsx app/lib/__tests__/company-facts-by-draft.test.ts
import { companyFactsMentionedByDraft, draftCompanyFactsBlock, fcCompanyFactsByDraftEnabled } from "../company-facts-by-draft";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

// 実物（watch_turn 7560・8271 の下書きの一節）
const D7560 = "初期費用のクレジットカード決済も可能です！！カード手数料として合計金額に3.24%が別途かかりますが、カード会社の方で分割の設定も頂けます！！";
const D8271 = "初期費用も最大限割引させて頂き、〇〇さんのお引越しにかかる費用を出来る限り抑えさせて頂きます！！";
console.log("company-facts-by-draft");
it("切替は既定 off", () => { eq(fcCompanyFactsByDraftEnabled({}), false); eq(fcCompanyFactsByDraftEnabled({ FC_COMPANY_FACTS_BY_DRAFT: "on" }), true); });
it("7560: カード払い・分割・3.24% → credit_card", () => eq(companyFactsMentionedByDraft(D7560, "giga").map((f) => f.id), ["credit_card"]));
it("8271: 最大限割引 → アカウントのブランドの事実だけ", () => {
  eq(companyFactsMentionedByDraft(D8271, "giga").map((f) => f.id), ["max_discount_ieyasu_giga"]);
  eq(companyFactsMentionedByDraft(D8271, "sumora").map((f) => f.id), ["max_discount_sumora"]);
  eq(companyFactsMentionedByDraft(D8271, null).map((f) => f.id), []);
});
it("お客様の質問で載った事実は重ねない・触れていなければ空", () => {
  eq(draftCompanyFactsBlock(D7560, "giga", new Set(["credit_card"])), "");
  eq(draftCompanyFactsBlock("よろしくお願い致します！！", "giga", new Set()), "");
  eq(draftCompanyFactsBlock(D7560, "giga", new Set()).startsWith("[COMPANY_FACTS_IN_DRAFT]"), true);
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
