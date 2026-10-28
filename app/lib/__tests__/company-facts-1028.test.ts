// 実行: npx tsx app/lib/__tests__/company-facts-1028.test.ts — #14 KID・#32 R（10/28 竹内さん）の実物
import { matchCompanyFacts } from "../company-facts";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const ids = (t: string) => matchCompanyFacts(t).map((f) => f.id).filter((i) => ["new_listing_timing", "screening_two_stage", "move_in_day_prorated"].includes(i));
const on = <T,>(f: () => T): T => { process.env.COMPANY_FACT_1028 = "on"; try { return f(); } finally { delete process.env.COMPANY_FACT_1028; } };
const KID = "ただ今の家が1ヶ月前の月割りなので\n今家が見つかってないとなると\n11月に申告すると12月末になります\n\n年末に引っ越しをしたくないので\n来年まで見送ろうと思っているので\nいったん紹介は大丈夫です";
const R = "25日以降にお金のお支払いしたいと思っているのですが、今審査通したら少し早いですか？";
console.log("company-facts-1028");
it("off は渡さない", () => { eq(ids(KID), []); eq(ids(R), []); });
it("on: KID の見送りに新着の出方と審査の2段", () => eq(on(() => ids(KID)), ["new_listing_timing", "screening_two_stage"]));
it("on: R の支払い時期の希望に入居日と日割", () => eq(on(() => ids(R)), ["move_in_day_prorated"]));
it("on: 審査の通りやすさの不安には2段を出さない（保証会社の事実の受け持ち）", () => eq(on(() => ids("夜職のみなので審査も不安です😭")), []));
it("on: 条件のフォーム・審査に落ちた報告には出さない", () => { eq(on(() => ids("①【ご入居の時期】⇒11月 ②【ご希望の家賃】⇒7万 審査期間 不安")), []); eq(on(() => ids("さっき審査落ちたって連絡きました…😢")), []); });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
