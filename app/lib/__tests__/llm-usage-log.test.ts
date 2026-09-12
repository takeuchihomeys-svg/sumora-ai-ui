// 2026-09-13 RAG 監査: Anthropic の usage を全経路で同じ形（read/write/uncached/total）にする
// 実行: npx tsx app/lib/__tests__/llm-usage-log.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { toUsageLine } from "../llm-usage-log";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

it("Anthropic の input_tokens は非キャッシュ分として扱い、合計を足し算で出す", () => {
  const u = toUsageLine("brain", { input_tokens: 16426, cache_read_input_tokens: 33546, cache_creation_input_tokens: 0, output_tokens: 900 });
  expect(u.uncached).toBe(16426); expect(u.read).toBe(33546); expect(u.total).toBe(49972); expect(u.hit).toBe(true); expect(u.out).toBe(900);
});
it("usage が無くても 0 で出す（ログで本処理を止めない）", () => {
  const u = toUsageLine("aix", undefined);
  expect(u.total).toBe(0); expect(u.hit).toBe(false); expect(u.tag).toBe("llm:usage");
});
it("書き込みだけ（キャッシュを作った回）は hit=false", () => {
  expect(toUsageLine("checkpoint", { input_tokens: 500, cache_creation_input_tokens: 4000 }).hit).toBe(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
