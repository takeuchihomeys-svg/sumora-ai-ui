// 2026-09-13 RAG 監査 改善5: TPO（場面ラベル）は今回のお客様の発言を先に見る・前回の出力は最後の手段
// 実行: npx tsx app/lib/__tests__/tpo-hint.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { inferTpoHint } from "../tpo-hint";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const STAFF = "こちら類似したお部屋で見木さんにオススメ出来るお部屋となります！！";
const base = { lastStaffMsg: STAFF, convStatus: "property_recommendation" };

it("8b260f7e 型: 「一旦検討してみます」は前回 action=property_send でも 検討中フォロー（実行ごとに入れ替わらない）", () => {
  expect(inferTpoHint({ ...base, customerTurn: "ありがとうございます\n一旦検討してみます", prevAction: "property_send" })).toBe("検討中フォロー");
});
it("他決の連絡「他で決めました」は前回 action=property_recommendation でも 拒否対応", () => {
  expect(inferTpoHint({ ...base, customerTurn: "すみません、他の不動産で決めました。ありがとうございました", prevAction: "property_recommendation" })).toBe("拒否対応");
});
it("「良い物件見つかりました！ここにします」は拒否ではなく申込前クロージング", () => {
  expect(inferTpoHint({ ...base, customerTurn: "良い物件見つかりました！ここにします" })).toBe("申込前クロージング");
});
it("「見てみたいです」は内覧調整", () => expect(inferTpoHint({ ...base, customerTurn: "このお部屋見てみたいです" })).toBe("内覧調整"));
it("審査中（screening）は 申込後説明", () => expect(inferTpoHint({ ...base, convStatus: "screening", customerTurn: "ありがとうございます" })).toBe("申込後説明"));
it("短い感謝は 感謝返し（前回 intent に頼らない）", () => expect(inferTpoHint({ ...base, customerTurn: "ありがとうございます！" })).toBe("感謝返し"));
it("顧客発言に手がかりが無い時だけ前回の action から 物件送付後", () => {
  expect(inferTpoHint({ ...base, customerTurn: "[スタンプ]", prevAction: "property_send" })).toBe("物件送付後");
});
it("手がかりも前回の action も無い → null（加点しない）", () => {
  expect(inferTpoHint({ lastStaffMsg: "かしこまりました！！", convStatus: "viewing", customerTurn: "はい" })).toBe(null);
});
it("スタッフ未返信は 初回対応", () => expect(inferTpoHint({ lastStaffMsg: null, convStatus: null, customerTurn: "はい" })).toBe("初回対応"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
