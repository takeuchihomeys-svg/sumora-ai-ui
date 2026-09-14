// 2026-09-14 API 漏れ調査: cron が失敗した物に印を付けず、毎回同じ物を LLM に送り直していた（申込到達会話の学習 7日で29回 等）
// 実行: npx tsx app/lib/__tests__/llm-job-attempts.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { isAttemptBlocked, attemptKey, DEFAULT_MAX_ATTEMPTS } from "../llm-job-attempts";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

it("記録の無い物は送る", () => {
  expect(isAttemptBlocked(undefined)).toBe(false);
});
it(`失敗 ${DEFAULT_MAX_ATTEMPTS - 1} 回までは次の実行でもう一度送る（一時的な失敗・529 はやり直す）`, () => {
  expect(isAttemptBlocked({ attempts: DEFAULT_MAX_ATTEMPTS - 1, done_at: null })).toBe(false);
});
it(`失敗 ${DEFAULT_MAX_ATTEMPTS} 回で諦める（入力そのものが原因の失敗を送り続けない）`, () => {
  expect(isAttemptBlocked({ attempts: DEFAULT_MAX_ATTEMPTS, done_at: null })).toBe(true);
  expect(isAttemptBlocked({ attempts: 1, done_at: null }, 1)).toBe(true);
});
it("処理済み（保存する物が無かった・統合された）の印があれば送らない", () => {
  expect(isAttemptBlocked({ attempts: 0, done_at: "2026-09-14T00:00:00Z" })).toBe(true);
});
it("attemptKey: 同じ文は同じ鍵・違う文は違う鍵（後続文そのものを物の ID にする）", () => {
  const a = attemptKey("物件ピックアップした【AIX】|本日も物件ピックアップさせて頂きます");
  expect(a).toBe(attemptKey("物件ピックアップした【AIX】|本日も物件ピックアップさせて頂きます"));
  expect(a === attemptKey("物件ピックアップした【AIX】|本日も物件ピックアップさせて頂きます！")).toBe(false);
  expect(a.length).toBe(16);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
