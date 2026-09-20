// app/lib/__tests__/property-image-read.test.ts
// 実行: npx tsx app/lib/__tests__/property-image-read.test.ts（自己完結ハーネス。全 PASS で exit 0）
//
// 2026-09-20 竹内「その画像の読み込みに限定して deepseek V4.1 Flash のモデルを使う」
// 材料は**本番で実際に返ってきた応答**（scripts/verify-deepseek-vision2.ts の実測）。
import { parseReadResult, PROPERTY_IMAGE_MAX_TOKENS, PROPERTY_IMAGE_MODEL_DEFAULT } from "../property-image-read";
import { resolveReadProperty } from "../property-name-match";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} got ${JSON.stringify(actual)}`); },
    atLeast(n: number) { if (Number(actual) < n) throw new Error(`${actual} < ${n}`); },
  };
}

console.log("\n── ★ 本番で実際に返ってきた形を読める ──");

it("★ 日本語のキー＋号室が配列（物件一覧の画像・実測）", () => {
  // 2026-09-20 実測: {"物件名":"RISING Maison 本町橋","号室":["1005","0402",...]}
  const r = parseReadResult('{"物件名":"RISING Maison 本町橋","号室":["1005","0402","0504","1201"]}');
  expect(r.items.length).toBe(4);
  expect(r.items[0].propertyName).toBe("RISING Maison 本町橋");
  expect(r.items[0].roomNumber).toBe("1005");
  expect(r.items[3].roomNumber).toBe("1201");
});

it("★ ```json で囲まれていても読める（実測で囲まれる事がある）", () => {
  const r = parseReadResult('```json\n{"items":[{"property_name":"ハイムM&K","room_number":"306"}],"is_property":true}\n```');
  expect(r.items.length).toBe(1);
  expect(r.items[0].propertyName).toBe("ハイムM&K");
  expect(r.isProperty).toBe(true);
});

it("★ 配列で返ってきても読める（thinking disabled の時の形・実測）", () => {
  const r = parseReadResult('[{"物件名":"RISING Maison 本町筋","号室":"1005"},{"物件名":"RISING Maison 本町筋","号室":"0402"}]');
  expect(r.items.length).toBe(2);
  expect(r.items[1].roomNumber).toBe("0402");
});

it("指定した形（items つき）をそのまま読める", () => {
  const r = parseReadResult('{"items":[{"property_name":"スプランディッド堀江","room_number":"403"}],"is_property":true}');
  expect(r.items.length).toBe(1);
  expect(r.items[0].roomNumber).toBe("403");
});

console.log("\n── 壊れた応答で落ちない ──");

it("空・空文字・JSONでない文字列", () => {
  for (const s of ["", "   ", "読み取れませんでした", "```json\n```"]) {
    const r = parseReadResult(s);
    expect(r.items.length).toBe(0);
    expect(r.isProperty).toBe(false);
  }
});

it("物件名が空の項目は捨てる（号室だけ読めても物件にならない）", () => {
  const r = parseReadResult('{"items":[{"property_name":"","room_number":"502"},{"property_name":"テスト","room_number":""}]}');
  expect(r.items.length).toBe(1);
  expect(r.items[0].propertyName).toBe("テスト");
});

it("is_property が false でも items は読む（呼び出し側が判断する）", () => {
  const r = parseReadResult('{"items":[{"property_name":"テスト","room_number":"101"}],"is_property":false}');
  expect(r.items.length).toBe(1);
  expect(r.isProperty).toBe(false);
});

console.log("\n── ★ 読み取り → 照合 まで通して誤読を止める ──");

it("★ 読み取れても既知の名前と合わなければ記録しない", () => {
  const r = parseReadResult('{"物件名":"スプラッティド堀江","号室":"403"}');   // Haiku の誤読の形
  expect(r.items.length).toBe(1);
  // 照合で捨てる（0.47 ＜ 閾値）
  expect(resolveReadProperty(r.items[0], ["スプランディッド堀江"]) === null).toBe(true);
});

it("★ 既知の名前と合えば号室まで揃って記録できる", () => {
  const r = parseReadResult('{"物件名":"ハイツカトレアB","号室":"0202"}');
  const fixed = resolveReadProperty(r.items[0], ["ハイツカトレア B"]);
  expect(fixed?.propertyName).toBe("ハイツカトレア B");   // 既知の表記に揃う
  expect(fixed?.roomNumber).toBe("202");                 // 先頭ゼロは外す
});

console.log("\n── 設定の歯止め ──");

it("★ max_tokens が十分大きい（小さいと推論で使い切って空応答になる・実測200で失敗）", () => {
  expect(PROPERTY_IMAGE_MAX_TOKENS).atLeast(4000);
});

it("既定のモデルは DeepSeek-V4.1-Flash（deepseek-flash）", () => {
  expect(PROPERTY_IMAGE_MODEL_DEFAULT).toBe("deepseek-flash");
});

console.log(`\n${failed === 0 ? "✅ 全 PASS" : "❌ 失敗あり"}  ${passed} passed / ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
