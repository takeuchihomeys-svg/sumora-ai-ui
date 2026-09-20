// app/lib/__tests__/vision-alt-provider.test.ts
// 実行: npx tsx app/lib/__tests__/vision-alt-provider.test.ts（自己完結ハーネス。全 PASS で exit 0）
//
// 2026-09-20 竹内「物件オススメ置き換える」
// 実測で「文を作る所は置き換えてよい・数値を抜く所は置き換えない」と決めたので、
// **見積書が誤って回らないこと**を固定する（ここが崩れると金額の誤読がお客様に届く）。
import { shouldRouteVisionAlt, visionAltActions, toOpenAiContent, flattenSystem, VISION_ALT_MAX_TOKENS, VISION_ALT_ACTIONS_DEFAULT } from "../vision-alt-provider";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が無い`); },
    atLeast(n: number) { if (Number(actual) < n) throw new Error(`${actual} < ${n}`); },
  };
}
const KEY = { DEEPSEEK_API_KEY: "dummy" };

console.log("\n── ★ 回す種類を間違えない（ここが崩れると金額の誤読が届く）──");

it("★ 既定で回すのは物件オススメだけ", () => {
  expect(VISION_ALT_ACTIONS_DEFAULT).toBe("property_recommendation");
  expect(shouldRouteVisionAlt("property_recommendation", KEY)).toBe(true);
});

it("★ 見積書は回さない（一致6/9・物件名と号室の誤読・5.6倍遅い）", () => {
  for (const a of ["estimate_sheet", "cost_breakdown", "property_check_result", "guarantor_info", "move_in_check"]) {
    if (shouldRouteVisionAlt(a, KEY)) throw new Error(`回してはいけない: ${a}`);
  }
});

it("鍵が無ければ1つも回さない（必ず Claude へ）", () => {
  expect(shouldRouteVisionAlt("property_recommendation", {})).toBe(false);
  expect(shouldRouteVisionAlt("property_recommendation", { DEEPSEEK_API_KEY: "   " })).toBe(false);
});

it("★ VISION_ALT_ACTIONS を空にすれば全部 Claude に戻る（戻し方）", () => {
  expect(shouldRouteVisionAlt("property_recommendation", { ...KEY, VISION_ALT_ACTIONS: "" })).toBe(false);
  expect(visionAltActions({ VISION_ALT_ACTIONS: "" }).size).toBe(0);
});

it("環境変数で足せる（カンマ区切り・空白は無視）", () => {
  const env = { ...KEY, VISION_ALT_ACTIONS: "property_recommendation, move_in_check ,, zenryoku_support" };
  expect(shouldRouteVisionAlt("move_in_check", env)).toBe(true);
  expect(shouldRouteVisionAlt("zenryoku_support", env)).toBe(true);
  expect(shouldRouteVisionAlt("estimate_sheet", env)).toBe(false);
  expect(visionAltActions(env).size).toBe(3);
});

console.log("\n── 形を直す（Anthropic → OpenAI 互換）──");

it("text と 画像URL を直せる", () => {
  const out = toOpenAiContent([
    { type: "text", text: "この物件資料からオススメ文を作ってください。" },
    { type: "image", source: { type: "url", url: "https://example.com/a.jpg" } },
  ]);
  expect(out?.length).toBe(2);
  expect(JSON.stringify(out?.[1])).toContain("https://example.com/a.jpg");
});

it("base64 の画像は data URL に直す", () => {
  const out = toOpenAiContent([{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }]);
  expect(JSON.stringify(out?.[0])).toContain("data:image/png;base64,QUJD");
});

it("画像が2枚（条件スクショ＋物件資料）でも直せる", () => {
  const out = toOpenAiContent([
    { type: "text", text: "指示" },
    { type: "image", source: { type: "url", url: "https://example.com/cond.jpg" } },
    { type: "image", source: { type: "url", url: "https://example.com/prop.jpg" } },
  ]);
  expect(out?.length).toBe(3);
});

it("★ 画像が1枚も無ければ回さない（文だけの呼び出しは既存の経路に任せる）", () => {
  expect(toOpenAiContent([{ type: "text", text: "文だけ" }]) === null).toBe(true);
  expect(toOpenAiContent([]) === null).toBe(true);
});

it("★ 知らない形が混ざったら回さない（黙って壊さない）", () => {
  expect(toOpenAiContent([{ type: "tool_use", id: "x" }]) === null).toBe(true);
  expect(toOpenAiContent([{ type: "image", source: { type: "file", url: "" } }]) === null).toBe(true);
});

console.log("\n── system のまとめ方 ──");

it("キャッシュ用の配列を1つの文字列にする", () => {
  const s = flattenSystem([
    { type: "text", text: "共通のルール", cache_control: { type: "ephemeral" } },
    { type: "text", text: "この経路のルール" },
  ]);
  expect(s).toContain("共通のルール");
  expect(s).toContain("この経路のルール");
});

it("文字列・空・想定外でも落ちない", () => {
  expect(flattenSystem("そのまま")).toBe("そのまま");
  expect(flattenSystem(undefined)).toBe("");
  expect(flattenSystem([])).toBe("");
});

console.log("\n── 設定の歯止め ──");

it("★ max_tokens が十分大きい（推論モデルなので小さいと答えが出ない）", () => {
  expect(VISION_ALT_MAX_TOKENS).atLeast(4000);
});

console.log(`\n${failed === 0 ? "✅ 全 PASS" : "❌ 失敗あり"}  ${passed} passed / ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
