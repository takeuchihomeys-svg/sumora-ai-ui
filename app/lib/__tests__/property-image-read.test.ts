// app/lib/__tests__/property-image-read.test.ts
// 実行: npx tsx app/lib/__tests__/property-image-read.test.ts（自己完結ハーネス。全 PASS で exit 0）
//
// 2026-09-20 竹内「その画像の読み込みに限定して deepseek V4.1 Flash のモデルを使う」
// 材料は**本番で実際に返ってきた応答**（scripts/verify-deepseek-vision2.ts の実測）。
import { parseReadResult, parseDetailResult, clipLongLine, propertyImageReadThinking, parseTranscript, sentImageDetailMode, PROPERTY_IMAGE_TRANSCRIBE_MAX_TOKENS, PROPERTY_IMAGE_TRANSCRIBE_PROMPT, PROPERTY_IMAGE_READ_NO_THINKING_MAX_TOKENS, PROPERTY_IMAGE_MAX_TOKENS, PROPERTY_IMAGE_MODEL_DEFAULT } from "../property-image-read";
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

console.log("\n── 2026-09-29 推論なしの読み取りと行の形 ──");
it("★ 物件名などの読み取りは既定で推論なし（PROPERTY_IMAGE_READ_THINKING=on で旧に戻る）", () => {
  expect(propertyImageReadThinking({})).toBe(false);
  expect(propertyImageReadThinking({ PROPERTY_IMAGE_READ_THINKING: "on" })).toBe(true);
  expect(PROPERTY_IMAGE_READ_NO_THINKING_MAX_TOKENS).atLeast(1500);
});
it("★ 設備欄を全部写した長い行（推論なし・125〜978字）は捨てずに区切りで120字以内に切る", () => {
  const long = "設備: " + Array.from({ length: 40 }, (_, i) => `設備${i}`).join("、");
  const r = parseDetailResult(JSON.stringify({ kind: "property", lines: [long, "ペット: 不可"] }));
  expect(r.lines.length).toBe(2);
  expect(r.lines[0].startsWith("設備: 設備0、設備1")).toBe(true);
  expect(r.lines[0].length <= 120).toBe(true);
  expect(/、$/.test(r.lines[0])).toBe(false);
});
it("区切りの無い長い地の文は今まで通り捨てる", () => {
  expect(clipLongLine("備考: " + "あ".repeat(200)).length > 120).toBe(true);
  const r = parseDetailResult(JSON.stringify({ kind: "property", lines: ["備考: " + "あ".repeat(200)] }));
  expect(r.lines.length).toBe(0);
});
it("★ 値が空の行（「ペット: 」）・資料の空欄の横線（「駐車場: ー」）は材料にしない", () => {
  const r = parseDetailResult(JSON.stringify({ kind: "property", lines: ["ペット: ", "楽器:", "駐車場: ー", "駐輪場: －", "間取り: 1K"] }));
  expect(r.lines.join("|")).toBe("間取り: 1K");
});

it("既定のモデルは DeepSeek-V4.1-Flash（deepseek-flash）", () => {
  expect(PROPERTY_IMAGE_MODEL_DEFAULT).toBe("deepseek-flash");
});


// ─── 2026-09-29（B・その2）書き写し → 文字の読み取り ───
console.log("\n■ parseTranscript / sentImageDetailMode");
it("1行目の種類を分け、本文は2行目から（本番の書き写しの形）", () => {
  const t = parseTranscript("【物件の資料】\n物件名: HRフロントリーガル城北\n駐車場: なし\n備考: ●ペット飼育可");
  expect(t.kind).toBe("property");
  expect(t.body.startsWith("物件名:")).toBe(true);
});
it("見積書・本人確認書類・その他は種類だけ（本文は使わない側で捨てる）", () => {
  expect(parseTranscript("【見積書】").kind).toBe("estimate");
  expect(parseTranscript("【本人確認書類・申込書】").kind).toBe("document");
  expect(parseTranscript("【その他】\n").kind).toBe("other");
});
it("種類の行が無ければ kind=null・本文は全部（文字の読み取りに種類を決めさせる）", () => {
  const t = parseTranscript("間取り: 1K\n構造: RC");
  expect(t.kind).toBe(null);
  expect(t.body).toBe("間取り: 1K\n構造: RC");
});
it("コードブロックで囲まれても読む", () => {
  expect(parseTranscript("```\n【物件の資料】\n間取り: 1K\n```").kind).toBe("property");
});
it("既定は書き写し・SENT_IMAGE_DETAIL_MODE=image で旧の画像読み", () => {
  expect(sentImageDetailMode({})).toBe("transcribe");
  expect(sentImageDetailMode({ SENT_IMAGE_DETAIL_MODE: "image" })).toBe("image");
  expect(sentImageDetailMode({ SENT_IMAGE_DETAIL_MODE: " IMAGE " })).toBe("image");
});
it("書き写しは推論なしで上限 3000（上限は費用にならない・推論が無いので空応答にならない）", () => {
  expect(PROPERTY_IMAGE_TRANSCRIBE_MAX_TOKENS).toBe(3000);
  expect(PROPERTY_IMAGE_TRANSCRIBE_PROMPT.includes("判断は不要")).toBe(true);
});

console.log(`\n${failed === 0 ? "✅ 全 PASS" : "❌ 失敗あり"}  ${passed} passed / ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
