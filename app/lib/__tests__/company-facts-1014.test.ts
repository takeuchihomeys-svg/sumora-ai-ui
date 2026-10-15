// 2026-10-14 竹内さん承認の会社の事実4つ（app/lib/company-facts.ts）のテスト。文は実物（お客様の発言 90日・scratchpad answer）
// 実行: npx tsx app/lib/__tests__/company-facts-1014.test.ts
import { matchCompanyFacts } from "../company-facts";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const ids = (t: string) => matchCompanyFacts(t).map((f) => f.id);
const has = (t: string, id: string, yes = true) => { const got = ids(t).includes(id); if (got !== yes) throw new Error(`${yes ? "当たらない" : "当たった"}: ${t} → ${ids(t).join(",")}`); };

it("① 他社で内覧した物件・弊社でも内覧", () => {
  has("別の不動産で内覧予定です。", "other_company_viewing");
  has("もうオンライン内見さっき違う不動産会社にしてもらいました😂", "other_company_viewing");
  has("内覧したいです", "other_company_viewing", false);
});
it("② 学生名義の審査", () => {
  has("学生で審査通すにはどうしたらいいですかね😭", "student_contract");
  has("あと、来年から社会人の大学生なんですが、自分の名義では通りづらいですかね💧", "student_contract");
  has("大学の近くで探しています", "student_contract", false);
});
it("③ 申込は LINE・内覧当日の持ち物", () => {
  has("もしその日のうちに契約したいってなった場合必要なものとか書類ってありますか？", "apply_line_viewing_items");
  has("内覧の時の持ち物って何かありますか？", "apply_line_viewing_items");
  has("電子契約の件なのですが、母親が契約方法について何も分かってないようで", "apply_line_viewing_items", false);
});
it("④ 即入居の部屋の入居まで", () => {
  has("今申し込んだら最短いつから住めるのでしょうか？", "immediate_move_in");
  has("この物件すぐ入居できますか？", "immediate_move_in");
  has("大阪市内で 初期費用2000円くらいで 即入居できる物件があれば知りたいです", "immediate_move_in", false);
  has("ちなみにこちら内見可能日は最短でいつ頃可能になりますでしょうか…？", "immediate_move_in", false);
});
it("確かめる人: 契約・鍵渡し・入居の当日の持ち物・退去予定のお部屋には渡さない", () => {
  has("契約当日に必要なものはありますか？", "apply_line_viewing_items", false);
  has("鍵渡し当日は何か持っていくものありますか？", "apply_line_viewing_items", false);
  has("入居当日に準備するものは？", "apply_line_viewing_items", false);
  has("申込の方法を教えてください", "apply_line_viewing_items");
  // 10/15: 申込に必要な書類は apply_docs の持ち場（両方は渡さない）・契約に必要な書類はこちら
  has("申込に必要な書類は何ですか？", "apply_line_viewing_items", false);
  has("契約に必要な書類はありますか？", "apply_line_viewing_items");
  has("このお部屋いつから住めますか？退去予定って書いてあったので", "immediate_move_in", false);
});
it("2026-10-15 軸の直し: 内覧当日の近くのパーキング（車の語なし）・繁忙期", () => {
  has("駐車場は近くのパーキングでよろしいですか？", "car_visit");
  has("近くのコインパーキングに停めれば大丈夫ですか？", "car_visit");
  has("駐車場の空きはありますか？", "car_visit", false);
  has("あと、4月とかの繁忙期より、今みたいな時期の方が家賃安いですかね、", "busy_season");
  has("今の時期の方が安いですか？", "busy_season");
  has("4月入居予定です", "busy_season", false);
});
it("止めれば渡さない", () => {
  process.env.COMPANY_FACT_1014 = "off";
  has("学生で審査通すにはどうしたらいいですかね", "student_contract", false);
  delete process.env.COMPANY_FACT_1014;
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
