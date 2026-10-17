// 2026-10-18 竹内さん 10/16 の答えの会社の事実（鍵の受け取り・ライフライン・更新料・支払いは一括の振込だけ）のテスト。文は実物（お客様の発言 365日）
// 実行: npx tsx app/lib/__tests__/company-facts-1016.test.ts
import { matchCompanyFacts, COMPANY_FACTS } from "../company-facts";
import { findCompanyFactContradiction, findMissingCardFee, ensureCardFeeLine } from "../company-fact-guard";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const ids = (t: string) => matchCompanyFacts(t).map((f) => f.id);
const has = (t: string, id: string, yes = true) => { const got = ids(t).includes(id); if (got !== yes) throw new Error(`${yes ? "当たらない" : "当たった"}: ${t} → ${ids(t).join(",")}`); };
const eq = (a: unknown, b: unknown, m = "") => { if (a !== b) throw new Error(`${m} 期待 ${String(b)} 実際 ${String(a)}`); };

it("鍵の受け取り（入居日に弊社の事務所）", () => {
  has("ありがとうございます！ 鍵の引渡しはどのような方法になりますでしょうか？？", "key_handover");
  has("部屋の鍵はどこに取りに行ったらいいですか？", "key_handover");
  has("鍵受け渡しいつですか？", "key_handover");
  has("鍵の受け渡し等は入居日当日に蓮産業株式会社様にお伺いさせて頂く形で大丈夫でしょうか？", "key_handover");
  has("藤和シティの物件は鍵交換済みで受け渡しですか？", "key_handover", false);
  has("今鍵取りにむかっています！ 30〜5分後くらいです", "key_handover", false);
  // 事務所へ鍵を取りに行く話は「来社での相談は受けていない」（store）を渡さない
  has("鍵の受け渡し等は入居日当日に事務所にお伺いさせて頂く形で大丈夫でしょうか？", "store", false);
  has("当日はそちらの店舗へ伺います", "store");
});
it("ライフライン（返信では案内しない）", () => {
  has("電気、ガス、水道の手続き先を 教えていただきたいです！", "utilities_procedure");
  has("水道の開栓は入居日と同時になりますか？", "utilities_procedure");
  has("ガス電気の契約したいんですけど、このお家は水道出ますか？？どこかに電話したら良いんですかね", "utilities_procedure");
  has("電気の申し込みはどうすればいいですか？", "utilities_procedure");
  has("水道代は家賃に込みですか？", "utilities_procedure", false);
  has("ガスは都市ガスですか？", "utilities_procedure", false);
  const f = COMPANY_FACTS.find((x) => x.id === "utilities_procedure")!;
  if (!/案内しない/.test(f.fact)) throw new Error("案内しないが無い");
});
it("更新料（物件によって異なる・2年毎に1ヶ月・保証会社 年1万・火災保険 2年毎）", () => {
  has("ちなみに更新料は家賃一ヶ月分でしょうか？", "renewal_fee");
  has("更新料はどちらとも何年更新のいくらかわかりますか？", "renewal_fee");
  has("火災保険って更新ありますか？", "renewal_fee");
  has("駅徒歩10分以内・更新料なしの物件でお願いします", "renewal_fee", false);
  const f = COMPANY_FACTS.find((x) => x.id === "renewal_fee")!;
  for (const w of ["物件によって異なる", "2年毎に賃料の1ヶ月分", "保証会社の更新料", "年間1万円", "火災保険の更新は基本2年毎"]) if (!f.fact.includes(w)) throw new Error(`無い: ${w}`);
});
it("家賃相場の言い方（同じ地域・同じ間取りで安い時だけ「相場的にも好条件」）", () => {
  has("この家賃って相場的にどうですか？", "rent_market_wording");
  has("北区の1LDKの相場っていくらくらいですか", "rent_market_wording");
  const f = COMPANY_FACTS.find((x) => x.id === "rent_market_wording")!;
  if (!f.fact.includes("同じ地域・同じ間取りで相場より安い時だけ")) throw new Error("線が無い");
});
it("支払いは一括の振込だけ（既定）", () => {
  const f = COMPANY_FACTS.find((x) => x.id === "credit_card")!;
  if (!/一括のお振込のみ/.test(f.fact)) throw new Error("一括のお振込のみが無い");
  if (/3\.24%が別途必要\*\*/.test(f.fact)) throw new Error("旧のカード手数料が残っている");
  const cust = ["初期費用分割は難しいですよね🥲"];
  // 旧で止めていた「一括のみ」は止めない・カード払い可／分割可の断定を止める
  eq(findCompanyFactContradiction("初期費用のお支払い方法はお振込での一括のみでの対応となります！！", cust), null, "一括のみ");
  eq(findCompanyFactContradiction("初期費用はクレジットカード払いですと分割可能です！！", cust)?.factId, "credit_card", "カード分割可");
  eq(findCompanyFactContradiction("クレジットカード払いにも対応しております！！", ["クレカ払いはできますか？"])?.factId, "credit_card", "カード払い可");
  eq(findCompanyFactContradiction("分割でのお支払いも可能でございます😊！！", cust)?.factId, "credit_card", "分割可");
  // 否定の文（カード払い・分割は出来ない）は止めない
  eq(findCompanyFactContradiction("クレジットカード払い・分割でのお支払いはご対応しておりません", cust), null, "否定");
  eq(findMissingCardFee("初期費用はクレジットカード払いですと分割可能です！！", cust), null, "手数料の一文");
  eq(ensureCardFeeLine("初期費用はクレジットカード払いですと分割可能です！！", cust).added, false, "足さない");
});
it("支払い: COMPANY_FACT_PAYMENT_LUMP=off で旧のカード払い", () => {
  process.env.COMPANY_FACT_PAYMENT_LUMP = "off";
  try {
    const f = COMPANY_FACTS.find((x) => x.id === "credit_card")!;
    if (!/クレジットカード払いに対応している/.test(f.fact)) throw new Error("旧の事実に戻らない");
    const cust = ["初期費用分割は難しいですよね🥲"];
    eq(findCompanyFactContradiction("初期費用のお支払い方法はお振込での一括のみでの対応となります！！", cust)?.factId, "credit_card", "旧: 一括のみを止める");
    eq(findCompanyFactContradiction("初期費用はクレジットカード払いですと分割可能です！！", cust), null, "旧: カード分割可は通す");
    eq(ensureCardFeeLine("初期費用はクレジットカード払いですと分割可能です！！", cust).added, true, "旧: 手数料を足す");
  } finally { delete process.env.COMPANY_FACT_PAYMENT_LUMP; }
});

console.log(`\n${passed} passed / ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
