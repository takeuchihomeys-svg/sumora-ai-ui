// app/lib/__tests__/condition-merge.test.ts
// 実行: npx tsx app/lib/__tests__/condition-merge.test.ts（自己完結ハーネス。全 PASS で exit 0）
// 2026-09-30 YUMA の条件の入口テストの実物（自由文の欄の丸ごと差し替え・「にも広げて」の意図）
import { mergeConditions, mergeFreeTextClauses } from "../condition-merge";
import { classifyByKeywords } from "../condition-intent";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

console.log("mergeFreeTextClauses");
it("ブレインの橋の上書き（11階以上）で今の節を消さない", () => {
  eq(mergeFreeTextClauses("バストイレ別、独立洗面台、2階以上・11階以上[必須]", "11階以上、眺めがいい部屋"),
    "バストイレ別・独立洗面台・2階以上・11階以上[必須]・眺めがいい部屋");
});
it("区切りだけ違う同じ中身は今の値のまま（履歴を増やさない）", () => {
  const cur = "バストイレ別・独立洗面台・2階以上";
  eq(mergeFreeTextClauses(cur, "バストイレ別、独立洗面台、2階以上"), cur);
});
it("今が空なら足す物だけ（重複は1つ）", () => { eq(mergeFreeTextClauses(null, "宅配ボックス、宅配ボックス"), "宅配ボックス"); });
it("足す物が空なら今のまま", () => { eq(mergeFreeTextClauses("ガスコンロ", null), "ガスコンロ"); eq(mergeFreeTextClauses(null, ""), null); });

console.log("mergeConditions");
const existing = { desired_area: "福島・野田・中津", other_requests: "ガスコンロ、カウンターキッチン、リビング8帖以上、初期費用15万円以内、収納多め", preferences: "バストイレ別・独立洗面台・2階以上", rent_max: 90000 };
it("REPLACE でも自由文の欄は節ごとに足す（その他を消さない）", () => {
  const r = mergeConditions(existing, { desired_area: "天満橋", other_requests: "エリアを天満橋方面にも広げて探す" }, "REPLACE");
  eq(r.desired_area, "天満橋");
  eq(r.other_requests, "ガスコンロ・カウンターキッチン・リビング8帖以上・初期費用15万円以内・収納多め・エリアを天満橋方面にも広げて探す");
});
it("REPLACE の数値は差し替え", () => { eq(mergeConditions(existing, { rent_max: 100000 }, "REPLACE").rent_max, 100000); });
it("ADD はエリアを足し、自由文は重複を足さない", () => {
  const r = mergeConditions(existing, { desired_area: "天満橋", preferences: "2階以上、宅配ボックス" }, "ADD");
  eq(r.desired_area, "福島・野田・中津・天満橋");
  eq(r.preferences, "バストイレ別・独立洗面台・2階以上・宅配ボックス");
});
it("FORMAL は全部差し替え（従来どおり）", () => { eq(mergeConditions(existing, { desired_area: "難波" }, "FORMAL"), { desired_area: "難波" }); });

console.log("classifyByKeywords（追加・許容）");
it("「天満橋の方にも広げて探してもらえますか」は ADD", () => {
  eq(classifyByKeywords("すみません、エリアなんですけど天満橋の方にも広げて探してもらえますか？", "福島・野田・中津")?.intent, "ADD");
});
it("「玉造付近まで広げても良い」は ADD", () => { eq(classifyByKeywords("安くなるなら玉造付近まで広げても大丈夫です", "森ノ宮")?.intent, "ADD"); });
it("差し替えの語があれば REPLACE が先（難波じゃなくて梅田でも大丈夫）", () => {
  eq(classifyByKeywords("やっぱり難波じゃなくて梅田でも大丈夫です", "難波")?.intent, "REPLACE");
});
it("「11階以上がいいです」は決めない（AI へ）", () => { eq(classifyByKeywords("あと階数は11階以上がいいです！眺めがいい部屋が良くて", "天満橋"), null); });
it("除外は従来どおり EXCLUDE", () => { eq(classifyByKeywords("天満橋は無しでお願いします", "福島・天満橋")?.intent, "EXCLUDE"); });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
