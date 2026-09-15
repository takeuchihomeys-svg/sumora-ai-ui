// 2026-09-15 竹内（隼斗事例）: AIX 待ち合わせを送ったら内覧の予定を作り、内覧方法を入れてもらう
// 実行: npx tsx app/lib/__tests__/meeting-calendar.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { meetingToJst, pendingViewingNotes, isReplaceableViewingNotes, VIEWING_METHOD_PENDING } from "../meeting-calendar";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const NOW = Date.parse("2026-09-15T15:32:00+09:00");
const j = (d: string, t: string) => JSON.stringify(meetingToJst(d, t, NOW));

it("隼斗「9/18（金）」「10:30」→ 2026-09-18 10:30", () => expect(j("9/18（金）", "10:30")).toBe(JSON.stringify({ ymd: "2026-09-18", start: "10:30", end: null })));
it("「9月20日」「13:00〜14:00」→ 開始・終了", () => expect(j("9月20日", "13:00〜14:00")).toBe(JSON.stringify({ ymd: "2026-09-20", start: "13:00", end: "14:00" })));
it("「明日」「10時半」", () => expect(j("明日", "10時半")).toBe(JSON.stringify({ ymd: "2026-09-16", start: "10:30", end: null })));
it("年またぎ「1/5」→ 来年", () => expect(meetingToJst("1/5", "11:00", NOW)?.ymd).toBe("2027-01-05"));
it("全角「９／１８」「１０：３０」", () => expect(j("９／１８", "１０：３０")).toBe(JSON.stringify({ ymd: "2026-09-18", start: "10:30", end: null })));
it("日付が読めなければ null", () => expect(meetingToJst("", "10:30", NOW)).toBe(null));
it("送信直後の予定のメモ（内覧方法 未入力・住所）", () => {
  expect(pendingViewingNotes("Designers KomiNka TAKADONO", "大阪府大阪市旭区高殿6-13-1")).toBe(`【物件】Designers KomiNka TAKADONO / ${VIEWING_METHOD_PENDING}\n住所: 大阪府大阪市旭区高殿6-13-1`);
});
it("上書きしてよい予定: 自動の「件数: 1件 物件: （未確定）」・内覧方法 未入力。内覧方法を入れた予定は上書きしない", () => {
  expect(isReplaceableViewingNotes("件数: 1件\n物件: （未確定）（現地）")).toBe(true);
  expect(isReplaceableViewingNotes(pendingViewingNotes("A", null))).toBe(true);
  expect(isReplaceableViewingNotes("【物件】S-RESIDENCE / 現地(オートロック: ※4809呼 / ダイヤル: 0723)")).toBe(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
