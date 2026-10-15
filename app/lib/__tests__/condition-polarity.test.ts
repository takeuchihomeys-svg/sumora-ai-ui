// 2026-10-15 軸の直し: 探す条件の向き（ゆるめる）と「込み」の印（condition-polarity.ts）。お客様の発言は実物（名前・物件名は伏せた）
// 実行: npx tsx app/lib/__tests__/condition-polarity.test.ts
import { relaxedTermsOf, dropRelaxedClauses, feeIncludedOf, applyConditionPolarity } from "../condition-polarity";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

it("b50fd451 9/16「ペット可じゃなくてもいいので紹介していただきたいです！」→ ゆるめる語はペット可", () => eq(relaxedTermsOf("ペット可じゃなくてもいいので紹介していただきたいです！"), ["ペット可"]));
it("8f705d16「一階とかだと鉄筋コンクリートじゃなくてもいけますかね」→ 鉄筋コンクリート", () => eq(relaxedTermsOf("一階とかだと\n鉄筋コンクリートじゃなくても\nいけますかね💦"), ["鉄筋コンクリート"]));
it("条件の語でない「急ぎじゃなくてもいい」は拾わない・普通の条件は空", () => { eq(relaxedTermsOf("急ぎじゃなくてもいいです"), []); eq(relaxedTermsOf("ペット可でお願いします"), []); });
it("ゆるめた語の節を外す（NG に入れない・今の登録からも外す）", () => {
  eq(dropRelaxedClauses("ペット可[必須]・WIC", ["ペット可"]), "WIC");
  eq(dropRelaxedClauses("ペット可NG[必須]", ["ペット可"]), null);
  const r = applyConditionPolarity("ペット可じゃなくてもいいので紹介していただきたいです！", { ng_points: "ペット可NG[必須]" }, { preferences: "ペット可・WIC付き", ng_points: null }, {});
  eq(r.extracted.ng_points, undefined, "NG に書かない");
  eq(r.preferencesAfterRelax, "WIC付き", "今の登録から外す");
});
it("込みの印: 「共益費込み10万以内で」→ other_requests に家賃上限は共益費込み", () => {
  eq(feeIncludedOf("共益費込み10万以内でお願いします"), "共益費");
  eq(feeIncludedOf("管理費込で8万"), "管理費");
  eq(feeIncludedOf("家賃8万"), null);
  const r = applyConditionPolarity("共益費込み10万以内でお願いします", { rent_max: 100000 }, null, {});
  eq(r.extracted.other_requests, "家賃上限は共益費込み");
});
it("review: ゆるめた語が今の登録に無い時は区切りを直さず「変わった」にしない（エリア・家賃の欄には触らない）", () => {
  eq(dropRelaxedClauses("WIC、南向き", ["ペット可"]), "WIC、南向き");
  const r = applyConditionPolarity("ペット可じゃなくてもいい", { area: "梅田" }, { preferences: "WIC、南向き", ng_points: "1階" }, {});
  eq([r.preferencesAfterRelax, r.ngAfterRelax, r.extracted.area], [undefined, undefined, "梅田"]);
});
it("review: 「保証人不要」は物件の条件（ゆるめるではない）＝取り出した条件を消さない", () => {
  eq(relaxedTermsOf("部屋の、広さ1ルーム 保証人不要。 エアコンつき、"), []);
  const r = applyConditionPolarity("部屋の、広さ1ルーム 保証人不要。", { preferences: "保証人不要[必須]・エアコン付き" }, null, {});
  eq(r.extracted.preferences, "保証人不要[必須]・エアコン付き");
});
it("CONDITION_POLARITY=off は前の形（そのまま）", () => {
  const r = applyConditionPolarity("ペット可じゃなくてもいい", { ng_points: "ペット可NG" }, null, { CONDITION_POLARITY: "off" });
  eq(r.extracted.ng_points, "ペット可NG");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
