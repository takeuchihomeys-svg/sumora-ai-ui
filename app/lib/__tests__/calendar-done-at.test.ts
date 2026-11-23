// npx tsx app/lib/__tests__/calendar-done-at.test.ts
// 2026-11-23 作業員L（#663）: calendar_events の済みの時刻（done_at）。済み＝今・戻し＝null・試験はその番の時刻の済み／開いたを読む・画面は変わらない
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { calendarDonePatch, doneAsOf } from "../calendar-done-at";
import { readCalendarEvents } from "../situation-timeline";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const NOW = "2026-11-23T05:00:00.000Z";
const ms = (iso: string) => Date.parse(iso);

t("済みにする時は is_done と done_at を一緒に書く・戻す時は done_at を null に", () => {
  assert.deepEqual(calendarDonePatch(true, NOW), { is_done: true, done_at: NOW });
  assert.deepEqual(calendarDonePatch(false, NOW), { is_done: false, done_at: null });
  const p = calendarDonePatch(true);
  assert.equal(p.is_done, true);
  assert.ok(Number.isFinite(Date.parse(p.done_at ?? "")));
});

t("試験の番の時刻: done_at がその番より後なら開いていた・前なら済み・同じ時刻は済み", () => {
  const row = { is_done: true, done_at: NOW };
  assert.equal(doneAsOf(row, ms("2026-11-23T04:00:00Z")), false);
  assert.equal(doneAsOf(row, ms("2026-11-23T06:00:00Z")), true);
  assert.equal(doneAsOf(row, ms(NOW)), true);
});

t("done_at が無い古い行・読めない時刻は今まで通り（今の is_done）", () => {
  assert.equal(doneAsOf({ is_done: true, done_at: null }, ms("2026-01-01T00:00:00Z")), true);
  assert.equal(doneAsOf({ is_done: true }, ms("2026-01-01T00:00:00Z")), true);
  assert.equal(doneAsOf({ is_done: true, done_at: "壊れた" }, ms("2026-01-01T00:00:00Z")), true);
  assert.equal(doneAsOf({ is_done: false, done_at: null }, ms(NOW)), false);
  assert.equal(doneAsOf({ is_done: null }, ms(NOW)), false);
  // 戻した行（is_done=false）に古い done_at が残っていても開いている
  assert.equal(doneAsOf({ is_done: false, done_at: "2026-11-01T00:00:00Z" }, ms(NOW)), false);
});

t("画面の読み（readCalendarEvents）は done_at があっても無くても同じ", () => {
  const base = [
    { title: "内覧", event_type: "viewing", all_day: false, start_at: "2026-11-24T05:00:00Z", is_done: false },
    { title: "物件送付", event_type: "property_send", all_day: true, start_at: "2026-11-22T00:00:00Z", is_done: true },
  ];
  const withAt = base.map((r) => ({ ...r, done_at: r.is_done ? NOW : null }));
  assert.deepEqual(readCalendarEvents(withAt as never), readCalendarEvents(base));
});

t("本番のコードに is_done だけを true にする書き込みが残っていない（済みは calendarDonePatch で書く）", () => {
  const root = path.resolve(__dirname, "..", "..", "..");
  const files = [
    "app/api/cron/calendar-auto-complete/route.ts", "app/api/save-reply-example/route.ts", "app/lib/contact-promise-server.ts",
    "app/lib/sent-facts.ts", "app/lib/staff-todo-reply-server.ts", "app/lib/viewing-done-after-greeting-server.ts", "app/page.tsx",
  ];
  for (const f of files) {
    const s = fs.readFileSync(path.join(root, f), "utf8");
    assert.ok(!/update\(\{\s*is_done:\s*(true|false)\s*\}\)/.test(s), `${f} に is_done だけの書き込み`);
    assert.ok(s.includes("calendarDonePatch(true)"), `${f} が calendarDonePatch を使っていない`);
  }
  // 画面の編集の保存（カレンダー・会話の予定）は is_done も done_at も書かない＝今まで通り
  const cal = fs.readFileSync(path.join(root, "app/calendar/page.tsx"), "utf8");
  assert.ok(!/done_at/.test(cal));
});

console.log(`calendar-done-at: ${n} ok`);
