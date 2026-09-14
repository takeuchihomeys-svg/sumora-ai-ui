// 2026-09-14 タクミ事例: 審査管理からの同期で状態を後戻りさせない（先の段階へ進める時だけ書く）
// 実行: npx tsx app/lib/__tests__/synced-status.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { resolveSyncedStatus } from "../conversation-status";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

it("タクミ: 申込中（applying）を審査管理の物件提案中（property_recommendation）で戻さない", () =>
  expect(resolveSyncedStatus("applying", "property_recommendation")).toBe(null));
it("申込後の印（is_post_apply）がある会話は、状態が物件提案中でも申込より前には書かない", () =>
  expect(resolveSyncedStatus("property_recommendation", "viewing", { isPostApply: true })).toBe(null));
it("同じ段階の言い換え（proposing ↔ property_recommendation）は書かない", () =>
  expect(resolveSyncedStatus("proposing", "property_recommendation")).toBe(null));
it("先の段階へは進める（物件提案中 → 内覧）", () => expect(resolveSyncedStatus("property_recommendation", "viewing")).toBe("viewing"));
it("状態がまだ無い会話には入れる", () => expect(resolveSyncedStatus(null, "new_inquiry")).toBe("new_inquiry"));
it("成約・失注はスタッフが決める（同期で入れない・外さない）", () => {
  expect(resolveSyncedStatus("applying", "closed_lost")).toBe(null);
  expect(resolveSyncedStatus("closed_won", "property_recommendation")).toBe(null);
});
it("知らない状態名・空は書かない", () => {
  expect(resolveSyncedStatus("hearing", "unknown_status")).toBe(null);
  expect(resolveSyncedStatus("hearing", null)).toBe(null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
