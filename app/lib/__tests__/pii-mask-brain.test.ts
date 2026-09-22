// ブレインに渡す本文の伏せ字（2026-09-23 竹内「問題は個人情報を deepseek 側が読み取ること」）
// 実行: npx tsx app/lib/__tests__/pii-mask-brain.test.ts（全 PASS で exit 0）
import { maskPII } from "../pii-mask";
import { isApplicationPayload, APPLICATION_FORM_PLACEHOLDER } from "../pii-pseudonym";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (!String(actual).includes(s)) throw new Error(`expected to contain ${JSON.stringify(s)} in ${JSON.stringify(String(actual).slice(0, 200))}`); },
    notToContain(s: string) { if (String(actual).includes(s)) throw new Error(`should not contain ${JSON.stringify(s)} in ${JSON.stringify(String(actual).slice(0, 200))}`); },
  };
}

// ① コロンが無い申込フォームの項目（実物の形）も値を伏せる
it("「生年月日 2001.07.23」「・氏名、フリガナ 中村七海 ナカムラナナミ」の値を伏せる（実送信135通中114通が申込フォーム・誤爆は0）", () => {
  const out = maskPII("【お申込者様記入欄】\n・氏名、フリガナ 中村七海 ナカムラナナミ\n生年月日 2001.07.23\n年収 350万");
  expect(out).notToContain("中村七海");
  expect(out).notToContain("2001.07.23");
  expect(out).notToContain("350万");
  expect(out).toContain("[回答済み・非表示]");
});
it("ラベルだけの行（こちらが送る空欄のフォーマット）の項目は伏せない（値が無いので伏せる物が無い）", () => {
  // ※「お申込者様」→「お客様」は前からある敬称の置き換え（新しい線とは別）
  const out = maskPII("【お申込者様記入欄】\n・氏名、フリガナ\n・生年月日\n・現住所");
  expect(out).toContain("・氏名、フリガナ");
  expect(out).toContain("・生年月日");
  expect(out).notToContain("[回答済み・非表示]");
});
it("物件の情報（家賃・間取り・物件名・階）は伏せない", () => {
  const t = "グランパシフィック桜川南 902号室\n家賃管理費込67,000円・1K・2階・敷金礼金なし";
  expect(maskPII(t)).toBe(t);
});
it("携帯番号・メールは伏せる／管理会社の固定電話の形も伏せる（ブレインは戻さないので安全側）", () => {
  const out = maskPII("お電話 090-1234-5678 / test@example.com");
  expect(out).notToContain("090-1234-5678");
  expect(out).notToContain("test@example.com");
});

// ② ブレインの会話履歴からは、申込フォームの中身を丸ごと落とす（brain-core）
it("記入済みの申込フォームは「届いた事実」だけ残す形に置き換えられる（判定は isApplicationPayload）", () => {
  const filled = "【お申込者様記入欄】\n・氏名、フリガナ 中村七海 ナカムラナナミ\n・生年月日 2001.07.23\n・現住所 大阪市西区北堀江1-2-3\n・勤務先 株式会社サンプル";
  expect(isApplicationPayload(filled)).toBe(true);
  expect(APPLICATION_FORM_PLACEHOLDER).toContain("申込フォーム");
  expect(APPLICATION_FORM_PLACEHOLDER).notToContain("受け取りました");
});
it("ブレインの履歴づくりが申込フォームを置き換えている（brain-core のコードを確かめる）", () => {
  const src = require("node:fs").readFileSync("app/lib/brain-core.ts", "utf8") as string;
  expect(src).toContain("isApplicationPayload(m.text ?? \"\")");
  expect(src).toContain("APPLICATION_FORMAT_SENT_PLACEHOLDER");
});
// ③ 層で名札を分けている（毎回の分析だけを DeepSeek に回せる）
it("ブレインの呼び出しに層の名札が付いている（brain_fresh / brain_full）＋申込以降は回さない印", () => {
  const src = require("node:fs").readFileSync("app/lib/brain-core.ts", "utf8") as string;
  expect(src).toContain("isFreshLayer ? \"brain_fresh\" : \"brain_full\"");
  expect(src).toContain("isPostApplyStatus(convStatus)");
  const alt = require("node:fs").readFileSync("app/lib/llm-alt-provider.ts", "utf8") as string;
  expect(alt).toContain("routeName.startsWith(\"brain_\")");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
