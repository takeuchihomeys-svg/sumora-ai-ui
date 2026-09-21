// 説明文から家賃・徒歩を取り出す（竹内 2026-09-21「ちゃんと物件を読み取ることできてるんかな？」）
//
// 実測: 拡張が構造化して残す家賃は **リアプロ20,854件中 0件**。
//   理由は `/(\d+)万/` でしか数値にしていないこと（「58,000円」に当たらない）。
//   説明文の方には家賃の文字がそのまま入っているので、サーバー側で読み直す。
//
// 実行: npx tsx app/lib/__tests__/property-summary-parse.test.ts（全 PASS で exit 0）
import {
  parseRentFromSummary, parseWalkMinutesFromSummary, RENT_MIN, RENT_MAX, WALK_MAX,
} from "../property-summary-parse";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

describe("家賃を読む", () => {
  it("★ R1 「58,000円」（リアプロで 0% だった形）", () => {
    expect(parseRentFromSummary("【1】エスリード新北野\n58,000円\n1K\n徒歩8分")).toBe(58000);
  });
  it("★ R2 「¥58,000」", () => {
    expect(parseRentFromSummary("【1】エスリード新北野\n¥58,000\n1K")).toBe(58000);
  });
  it("★ R3 「5.8万円」（小数を落とさない）", () => {
    expect(parseRentFromSummary("【1】物件名\n5.8万円\n1K")).toBe(58000);
  });
  it("★ R4 「7万円」", () => {
    expect(parseRentFromSummary("【1】物件名\n7万円\n1LDK")).toBe(70000);
  });
  it("★ R5 全角の数字でも読む", () => {
    expect(parseRentFromSummary("【1】物件名\n５８，０００円\n1K")).toBe(58000);
  });
  it("★ R6 管理費が並んでいたら**家賃の方**を採る", () => {
    expect(parseRentFromSummary("【1】物件名\n58,000円 管理費5,000円\n1K")).toBe(58000);
  });
  it("★★ R7 物件名の行は見ない（名前に数字が入る物件がある）", () => {
    // 「メゾン100万ビル」のような名前を家賃にしない
    expect(parseRentFromSummary("【1】グランコート100万ビル\n58,000円\n1K")).toBe(58000);
  });
  it("★★ R8 ありえない値は捨てる（読み違いを記録しない）", () => {
    expect(parseRentFromSummary("【1】物件名\n1,000円\n1K")).toBe(null);          // 安すぎ
    expect(parseRentFromSummary("【1】物件名\n9,999,999円\n1K")).toBe(null);      // 高すぎ
    expect(RENT_MIN).toBe(20000);
    expect(RENT_MAX).toBe(500000);
  });
  it("★ R9 ありえない値の後に正しい値があれば拾う", () => {
    expect(parseRentFromSummary("【1】物件名\n礼金 0円\n68,000円\n1K")).toBe(68000);
  });
  it("R10 家賃が無ければ null", () => {
    expect(parseRentFromSummary("【1】物件名\n1K\n徒歩8分")).toBe(null);
    expect(parseRentFromSummary("")).toBe(null);
    expect(parseRentFromSummary(null)).toBe(null);
  });
  it("★ R11 敷礼の「2ヶ月」を家賃と間違えない", () => {
    expect(parseRentFromSummary("【1】物件名\n敷2ヶ月 礼1ヶ月\n1K")).toBe(null);
  });
});

describe("徒歩分数を読む", () => {
  it("★ W1 「徒歩8分」", () => {
    expect(parseWalkMinutesFromSummary("【1】物件名\n58,000円\n1K\n新北野駅 徒歩8分")).toBe(8);
  });
  it("★ W2 全角でも読む", () => {
    expect(parseWalkMinutesFromSummary("【1】物件名\n徒歩１２分")).toBe(12);
  });
  it("★ W3 ありえない値は捨てる", () => {
    expect(parseWalkMinutesFromSummary("【1】物件名\n徒歩999分")).toBe(null);
    expect(WALK_MAX).toBe(60);
  });
  it("W4 無ければ null", () => {
    expect(parseWalkMinutesFromSummary("【1】物件名\n58,000円")).toBe(null);
    expect(parseWalkMinutesFromSummary(null)).toBe(null);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
