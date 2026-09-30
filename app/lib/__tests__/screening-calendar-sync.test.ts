// 2026-09-30 竹内「内覧カレンダー登録したら、申込ツールのカレンダーにも連動して入れる」— 行の鍵と中身
// 実行: npx tsx app/lib/__tests__/screening-calendar-sync.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { buildScreeningTaskPayload, isValidSyncKey, screeningTaskIdFor, shouldSyncViewingToScreening } from "../screening-calendar-sync";
import { pendingViewingNotes } from "../meeting-calendar";
import { holdNotes } from "../viewing-hold";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

it("同じ予定は何回作っても同じ行の id（二重に入らない鍵）", () => {
  expect(screeningTaskIdFor(504)).toBe("dt_sumora_cal_504");
  expect(screeningTaskIdFor("504")).toBe(screeningTaskIdFor(504));
});
it("鍵に使えるのは予定の id の形だけ（数字・UUID）", () => {
  expect(isValidSyncKey(504)).toBe(true);
  expect(isValidSyncKey("3f0a1c2e-aaaa-bbbb-cccc-1234567890ab")).toBe(true);
  expect(isValidSyncKey("")).toBe(false);
  expect(isValidSyncKey("1;drop")).toBe(false);
  expect(isValidSyncKey("a/b")).toBe(false);
  expect(isValidSyncKey(null)).toBe(false);
});
it("待ち合わせの送信直後の内覧の予定 → 申込ツールの行（【内覧】タイトル — メモ・日本時間の日付と時刻）", () => {
  const notes = pendingViewingNotes("カーザSunⅠ 202号室", "大阪府大阪市福島区海老江7丁目18-5");
  const p = buildScreeningTaskPayload({ eventId: 504, eventType: "viewing", title: "YUMA 内覧", customerName: "YUMA", ymd: "2026-10-02", start: "13:00", end: null, notes });
  expect(JSON.stringify(p)).toBe(JSON.stringify({
    sync_key: "504", customer_name: "YUMA",
    content: "【内覧】YUMA 内覧 — 【物件】カーザSunⅠ 202号室 / 内覧方法: 未入力\n住所: 大阪府大阪市福島区海老江7丁目18-5",
    date: "2026-10-02", time: "13:00", end_time: "",
  }));
});
it("時刻が未定（終日）は時刻を空で入れる・日付が読めなければ作らない", () => {
  expect(buildScreeningTaskPayload({ eventId: 1, eventType: "viewing", title: "内覧", ymd: "2026-10-02", start: null, end: null })?.time).toBe("");
  expect(buildScreeningTaskPayload({ eventId: 1, eventType: "viewing", title: "内覧", ymd: "10/2", start: "13:00" })).toBe(null);
  expect(buildScreeningTaskPayload({ eventId: "a b", eventType: "viewing", title: "内覧", ymd: "2026-10-02" })).toBe(null);
});
it("入れるのは決まった内覧だけ（時間確保・未確定の自動の予定・内覧以外は入れない）", () => {
  expect(shouldSyncViewingToScreening("viewing", pendingViewingNotes("A", "大阪市北区"))).toBe(true);
  expect(shouldSyncViewingToScreening("viewing", "【1件目】A / 現地\n【2件目】B / 現地")).toBe(true);
  expect(shouldSyncViewingToScreening("viewing", holdNotes("10/2(金) 13:00〜15:00"))).toBe(false);
  expect(shouldSyncViewingToScreening("viewing", "件数: 1件\n物件: （未確定）（現地）")).toBe(false);
  expect(shouldSyncViewingToScreening("property_send", "【必ず】物件ピックアップ")).toBe(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
