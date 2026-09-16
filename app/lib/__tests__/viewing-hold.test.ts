// 2026-09-16 竹内（カイナ事例）: 内覧の候補日時を「時間確保」でカレンダーに置き、決まったら残りを消す
// 実行: npx tsx app/lib/__tests__/viewing-hold.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { parseCandidateSlots, holdEventRow, planHoldCleanup, isViewingHoldNotes, holdNotes, holdTitle, VIEWING_HOLD_MARK } from "../viewing-hold";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toEqual(exp: unknown) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
  };
}
// 2026-09-16(水) 8:51 JST に AIX【内覧日調整】を送った場面（カイナ＝🐈‍⬛）
const NOW = Date.parse("2026-09-15T23:51:00Z");

it("カイナ: 「明日 9/16(水) 15:30〜17:00」を 9/16 15:30〜17:00 の確保に（(水) を時刻と読まない）", () => {
  const slots = parseCandidateSlots("明日 9/16(水) 15:30〜17:00", NOW);
  expect(slots.length).toBe(1);
  expect(slots[0]).toEqual({ ymd: "2026-09-16", start: "15:30", end: "17:00", label: "9/16(水) 15:30〜17:00" });
});
it("複数の日・1日に2枠の候補（スタッフ実送信の形）", () => {
  const slots = parseCandidateSlots("本日 9/16(水) 13:00〜16:00\n9/18(金) 10:30〜11:30 / 17:00〜18:30", NOW);
  expect(slots.length).toBe(3);
  expect(slots.map((s) => `${s.ymd} ${s.start}-${s.end}`).join(", ")).toBe("2026-09-16 13:00-16:00, 2026-09-18 10:30-11:30, 2026-09-18 17:00-18:30");
});
it("時刻が1つだけなら2時間の枠・日付が読めない行は落とす・同じ枠は1つ", () => {
  expect(parseCandidateSlots("明日 9/16(水) 15:30", NOW)[0].end).toBe("17:30");
  expect(parseCandidateSlots("ご都合よろしいお時間お聞かせください", NOW).length).toBe(0);
  expect(parseCandidateSlots("9/16(水) 15:30〜17:00\n明日 9/16(水) 15:30〜17:00", NOW).length).toBe(1);
});
it("カレンダーに入れる行は手入力と同じ形（title「〇〇 内覧」・notes 先頭【時間確保】・日本時間）", () => {
  const row = holdEventRow(parseCandidateSlots("明日 9/16(水) 15:30〜17:00", NOW)[0], "🐈‍⬛", "6fdadc8b-b3d7-4c71-a998-89866b92deb8");
  expect(row.title).toBe("🐈‍⬛ 内覧");
  expect(row.event_type).toBe("viewing");
  expect(row.all_day).toBe(false);
  expect(row.start_at).toBe(new Date("2026-09-16T15:30:00+09:00").toISOString());
  expect(row.end_at).toBe(new Date("2026-09-16T17:00:00+09:00").toISOString());
  expect(row.notes.startsWith(VIEWING_HOLD_MARK)).toBe(true);
  expect(isViewingHoldNotes(row.notes)).toBe(true);
});
it("手入力の確保（notes が「【時間確保】」だけ）も確保として扱う・本当の内覧は確保ではない", () => {
  expect(isViewingHoldNotes("【時間確保】")).toBe(true);
  expect(isViewingHoldNotes(holdNotes("9/16(水) 15:30〜17:00"))).toBe(true);
  expect(isViewingHoldNotes("【物件】カーザSunI 202号室 / 内覧方法: 未入力")).toBe(false);
  expect(isViewingHoldNotes(null)).toBe(false);
  expect(holdTitle(null)).toBe("内覧");
});
it("決まったら: 同じ日時の確保を残し（本当の内覧に書き換える）、そのお客さんの他の候補は消す", () => {
  const holds = [
    { id: 1, start_at: "2026-09-16T06:30:00Z", notes: "【時間確保】\n候補: 9/16(水) 15:30〜17:00" }, // 9/16 15:30 JST
    { id: 2, start_at: "2026-09-18T01:30:00Z", notes: "【時間確保】\n候補: 9/18(金) 10:30〜11:30" },
    { id: 3, start_at: "2026-09-18T08:00:00Z", notes: "【時間確保】\n候補: 9/18(金) 17:00〜18:30" },
    { id: 4, start_at: "2026-09-17T02:00:00Z", notes: "【物件】カーザSunI 202号室 / 内覧方法: 未入力" }, // 本当の内覧は触らない
  ];
  const r = planHoldCleanup(holds, "2026-09-16", "15:30");
  expect(r.keepId).toBe(1);
  expect(r.deleteIds).toEqual([2, 3]);
});
it("決まった日に確保が無ければ全部消す（keepId なし）・確保が無ければ何もしない", () => {
  const holds = [{ id: 2, start_at: "2026-09-18T01:30:00Z", notes: "【時間確保】" }];
  expect(planHoldCleanup(holds, "2026-09-16", "15:30")).toEqual({ keepId: null, deleteIds: [2] });
  expect(planHoldCleanup([{ id: 9, start_at: "2026-09-18T01:30:00Z", notes: "【物件】〇〇" }], "2026-09-16", null)).toEqual({ keepId: null, deleteIds: [] });
});
it("𝒮: 決まった時刻（12:00）の確保が無ければ、同じ日の別の枠（16:00）も消す", () => {
  // 実データ: 9/17 12:00 で決まったのに 16:00〜18:00 の確保が残っていた（ev 536）。
  //   12:00 の確保は本当の内覧に書き換え済みで、呼び出し側が除外して渡す
  const holds = [{ id: 536, start_at: "2026-09-17T07:00:00Z", notes: "【時間確保】\n候補: 9/17(木) 16:00〜18:00" }];
  expect(planHoldCleanup(holds, "2026-09-17", "12:00")).toEqual({ keepId: null, deleteIds: [536] });
});
it("決まった時刻が分からない時は同じ日の確保を1つ残す", () => {
  const holds = [
    { id: 1, start_at: "2026-09-16T06:30:00Z", notes: "【時間確保】" },
    { id: 2, start_at: "2026-09-16T09:00:00Z", notes: "【時間確保】" },
  ];
  const r = planHoldCleanup(holds, "2026-09-16", null);
  expect(r.keepId).toBe(1);
  expect(r.deleteIds).toEqual([2]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
