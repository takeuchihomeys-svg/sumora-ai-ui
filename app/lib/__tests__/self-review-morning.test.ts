// 2026-10-18 竹内さん 10/18 OK: 朝の報告の「🧠 自己点検（夜中）」の段のテスト
// 実行: npx tsx app/lib/__tests__/self-review-morning.test.ts
import { formatSelfReviewSection, morningSelfReviewEnabled } from "../self-review-morning";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const run = { day: "2026-10-19", morning_line: "🧠 自己点検 2026-10-19: 説明 6件／一番多い原因「会社の事実の欠落→材料をつなぐ（3件・q101）」／竹内さんに聞く 1件", explained: 6, proposals: 4, ask_count: 1, questions: ["鍵は前倒しで渡せる？"], top_cause: null };

it("朝の1行・案の数・未決・聞く事（その日→未決・重ねない・3まで）", () => {
  const s = formatSelfReviewSection(run, [
    { fix_kind: "竹内さんに聞く", cause_keys: [], n: 3, needs_takeuchi: true, questions: ["鍵は前倒しで渡せる？", "二人入居の資料の書き方は？"] },
    { fix_kind: "材料をつなぐ", cause_keys: [], n: 2, needs_takeuchi: false, questions: [] },
  ], { today: "2026-10-19" });
  ok(s.startsWith("🧠 自己点検（夜中）\n🧠 自己点検 2026-10-19"), s);
  ok(s.includes("案 4件（説明 6件）・未決の案 2件（うち竹内さんに聞く 1件）"), s);
  ok((s.match(/鍵は前倒し/g) ?? []).length === 1 && s.includes("二人入居の資料の書き方は？"), s);
});
it("行が無い・古い（2日より前）時は段を出さない", () => {
  ok(formatSelfReviewSection(null, [], { today: "2026-10-19" }) === "", "null");
  ok(formatSelfReviewSection({ ...run, day: "2026-10-16" }, [], { today: "2026-10-19" }) === "", "古い");
  ok(formatSelfReviewSection({ ...run, day: "2026-10-18" }, [], { today: "2026-10-19" }) !== "", "昨日は出す");
});
it("止める MORNING_SELF_REVIEW=off", () => {
  ok(!morningSelfReviewEnabled({ MORNING_SELF_REVIEW: "off" }) && morningSelfReviewEnabled({}), "スイッチ");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
