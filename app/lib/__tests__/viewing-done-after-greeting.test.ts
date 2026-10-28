// app/lib/__tests__/viewing-done-after-greeting.test.ts — 竹内さん #5
//   実行: npx tsx app/lib/__tests__/viewing-done-after-greeting.test.ts
import { viewingDoneOnAfterGreetingOn, isAfterViewingGreeting, pickViewingEventsDoneAfterGreeting } from "../viewing-done-after-greeting";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("既定 off", !viewingDoneOnAfterGreetingOn({}) && viewingDoneOnAfterGreetingOn({ VIEWING_DONE_ON_AFTER_GREETING: "on" }));
t("内覧後の挨拶だけ", isAfterViewingGreeting("greeting_viewing", "after") && isAfterViewingGreeting("greeting_viewing", "after:thanks") && !isAfterViewingGreeting("greeting_viewing", "before") && !isAfterViewingGreeting("viewing_invite", "after"));
// 今＝10/28 15:00 JST（06:00Z）
const now = Date.parse("2026-10-28T06:00:00Z");
const rows = [
  { id: 1, event_type: "viewing", start_at: "2026-10-28T03:00:00Z", is_done: false },   // 今日 12:00 の内覧＝済みに
  { id: 2, event_type: "viewing", start_at: "2026-10-28T08:00:00Z", is_done: false },   // 今日 17:00（これから）＝触らない
  { id: 3, event_type: "viewing", start_at: "2026-10-27T03:00:00Z", is_done: false },   // 昨日＝触らない
  { id: 4, event_type: "contract", start_at: "2026-10-28T02:00:00Z", is_done: false },  // 内覧ではない
  { id: 5, event_type: "viewing", start_at: "2026-10-28T01:00:00Z", is_done: true },    // もう済み
];
t("今日・始まった内覧だけ済みに", JSON.stringify(pickViewingEventsDoneAfterGreeting(rows, now)) === "[1]");
t("日付の境目（JST の 0時台の内覧は今日）", JSON.stringify(pickViewingEventsDoneAfterGreeting([{ id: 9, event_type: "viewing", start_at: "2026-10-27T15:30:00Z", is_done: false }], now)) === "[9]");
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
