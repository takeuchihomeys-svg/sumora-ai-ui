// 「審査だけ先に…できかねます」を会社の事実違いにする（company-fact-guard・COMPANY_FACT_SCREENING_FIRST_GUARD）— 実物（watch_turn 8112・名前なし）・LLM なし
// 実行: npx tsx app/lib/__tests__/screening-first-guard.test.ts
import { findCompanyFactContradiction } from "../company-fact-guard";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const DRAFT = "〇〇さん、お見積もりのご確認ありがとうございます！！\n審査はお部屋のお申込み後に進める形となりますので、審査だけ先にお通しすることはできかねます！！";
const ASK = ["お世話になっております。\n見積もりまでありがとうございます🙇\nこちら審査を先に通していただくこと可能でしょうか？💦"];
const on = (f: () => void) => { process.env.COMPANY_FACT_SCREENING_FIRST_GUARD = "on"; try { f(); } finally { delete process.env.COMPANY_FACT_SCREENING_FIRST_GUARD; } };
console.log("screening-first-guard");
it("off は今まで通り当てない", () => { delete process.env.COMPANY_FACT_SCREENING_FIRST_GUARD; eq(findCompanyFactContradiction(DRAFT, ASK), null); });
it("on: 審査だけ先に…できかねます は事実違い", () => on(() => eq(findCompanyFactContradiction(DRAFT, ASK)?.factId, "screening_first")));
it("on: お客様が聞いていない時は当てない", () => on(() => eq(findCompanyFactContradiction(DRAFT, ["ありがとうございます"]), null)));
it("on: 正しい答え（お申込し審査かけさせて頂きます）は当てない", () => on(() => eq(findCompanyFactContradiction("かしこまりました！！\nお申込し審査かけさせて頂きます！！", ASK), null)));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
