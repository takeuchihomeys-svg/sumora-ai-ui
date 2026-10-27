// 見積書の画面の AD の入力・選択（app/lib/estimate-ad-input.ts）— 作り物の値・DB なし
// 実行: npx tsx app/lib/__tests__/estimate-ad-input.test.ts
import { estimateAdInputEnabled, resolveAdYen, discountShareLine, parseYenInput } from "../estimate-ad-input";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

console.log("estimate-ad-input");
it("切替は既定 off", () => { eq(estimateAdInputEnabled({}), false); eq(estimateAdInputEnabled({ NEXT_PUBLIC_ESTIMATE_AD_INPUT: "on" }), true); });
it("使う AD の順: 入れた円 → 入れたヶ月×家賃 → 分かった円 → 分かったヶ月×家賃", () => {
  eq(resolveAdYen({ override: { months: null, yen: 70000 }, knownYen: 65000, rent: 65000 }), { yen: 70000, source: "input_yen" });
  eq(resolveAdYen({ override: { months: 1.5, yen: null }, knownYen: 65000, rent: 60000 }), { yen: 90000, source: "input_months" });
  eq(resolveAdYen({ override: null, knownYen: 65000, rent: 60000 }), { yen: 65000, source: "known_yen" });
  eq(resolveAdYen({ override: null, knownMonths: 2, rent: 60000 }), { yen: 120000, source: "known_months" });
  eq(resolveAdYen({ override: { months: 1, yen: null }, rent: null }), { yen: null, source: null });
});
it("割引が AD の何%か・利益", () => {
  eq(discountShareLine(65000, 35000), "AD 65,000円のうち割引 35,000円（54%）・利益 30,000円");
  eq(discountShareLine(50000, 60000), "AD 50,000円のうち割引 60,000円（120%）・利益 -10,000円（マイナス）");
  eq(discountShareLine(null, 1000), null);
});
it("円の入力", () => {
  eq(parseYenInput("65,000"), 65000); eq(parseYenInput("6.5万"), 65000); eq(parseYenInput("６５０００円"), 65000); eq(parseYenInput("abc"), null); eq(parseYenInput(""), null);
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
