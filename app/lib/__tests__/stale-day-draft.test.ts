// 日付をまたいだ古い下書き（2026-10-28 竹内さん #4 愛実）
// 実行: npx tsx app/lib/__tests__/stale-day-draft.test.ts
import { staleDayDraftClearEnabled, isStaleRelativeDayDraft } from "../stale-day-draft";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const D = "愛実さんお世話になっております！！\nはい😊！！\n明日24日17:30にお会いできるのを楽しみにしております！！";
const NEXT_MORNING = Date.parse("2026-10-24T00:34:00Z"); // JST 10/24 9:34

it("既定 off・on で入る", () => { eq(staleDayDraftClearEnabled({}), false); eq(staleDayDraftClearEnabled({ STALE_DAY_DRAFT_CLEAR: "on" }), true); });
it("#4 愛実: 前日（10/23 JST）に作った「明日24日」の下書きを翌朝に出さない", () => eq(isStaleRelativeDayDraft(D, "2026-10-23T05:52:00Z", NEXT_MORNING), true));
it("同じ日に作った下書きは出す", () => eq(isStaleRelativeDayDraft(D, "2026-10-24T00:10:00Z", NEXT_MORNING), false));
it("日の言い方が無い下書き・見張りの印・時刻が無い物は触らない", () => {
  eq(isStaleRelativeDayDraft("かしこまりました！！何卒よろしくお願い致します！！", "2026-10-23T05:52:00Z", NEXT_MORNING), false);
  eq(isStaleRelativeDayDraft("[AIX誘導中]", "2026-10-23T05:52:00Z", NEXT_MORNING), false);
  eq(isStaleRelativeDayDraft(D, null, NEXT_MORNING), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
