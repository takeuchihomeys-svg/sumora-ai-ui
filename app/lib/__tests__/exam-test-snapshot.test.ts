// app/lib/__tests__/exam-test-snapshot.test.ts — 試験の写しはテスト専用の会話＋手元だけ・本番では読まない
import { examTestSnapshot, snapshotRows } from "../exam-test-snapshot";
import { NO_LINE_TEST_CONVERSATIONS, YUMA_CONVERSATION_ID } from "../test-conversations";

let passed = 0, failed = 0; const failures: string[] = [];
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const it = (name: string, fn: () => void) => { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : e}`); console.log(`  ✗ ${name}`); } };

const TEST = NO_LINE_TEST_CONVERSATIONS[0].id;
const body = { testSnapshot: { pickups: [{ room_no: "201", created_at: "2026-10-01T00:00:00Z" }, { room_no: "201", created_at: "2026-10-03T00:00:00Z" }, { room_no: "305", created_at: "2026-10-02T00:00:00Z" }] } };
it("手元＋テスト専用の会話なら写しを返す", () => { eq(!!examTestSnapshot(body, TEST, {}), true); });
it("本番（VERCEL）では読まない", () => { eq(examTestSnapshot(body, TEST, { VERCEL: "1" }), null); eq(examTestSnapshot(body, TEST, { NODE_ENV: "production" }), null); });
it("お客様の会話では読まない", () => { eq(examTestSnapshot(body, "00000000-0000-0000-0000-000000000000", {}), null); });
it("YUMA もテストの会話（isTestOnlyConversation は YUMA を含む）", () => { eq(!!examTestSnapshot(body, YUMA_CONVERSATION_ID, {}), true); });
it("写しが無い・形が違う時は null", () => { eq(examTestSnapshot({}, TEST, {}), null); eq(examTestSnapshot({ testSnapshot: "x" }, TEST, {}), null); });
it("行は新しい順・絞り・上限", () => {
  const r = snapshotRows(body.testSnapshot.pickups, { where: (x) => x.room_no === "201", limit: 1 });
  eq(r, [{ room_no: "201", created_at: "2026-10-03T00:00:00Z" }]);
  eq(snapshotRows(undefined).length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
