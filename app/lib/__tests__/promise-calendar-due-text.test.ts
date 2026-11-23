// npx tsx app/lib/__tests__/promise-calendar-due-text.test.ts
// 2026-11-23 作業員L: カレンダーの期日を約束の文（行動台帳の dueText）から読む（CALENDAR_PROMISE_DUE_TEXT=on の時だけ・既定 off）。e4bb495d・ac34b364 の形を伏せて
import assert from "node:assert/strict";
import { promiseEventRows, promiseLaterDueStartAt, calendarPromiseDueTextOn } from "../promise-calendar";

assert.equal(calendarPromiseDueTextOn({}), false);
assert.equal(calendarPromiseDueTextOn({ CALENDAR_PROMISE_DUE_TEXT: "on" }), true);
const sentAt = "2026-11-18T01:46:00.000Z"; // JST 11/18 10:46
const e4 = { kind: "pickup_declared" as const, status: "promised" as const, evidence: "お探しさせて頂きます", detail: { sentence: "独立系の保証会社を中心にお部屋をお探しさせて頂きます", dueText: "お部屋をお探しさせて頂きます！！ 12月17日に〇〇周辺から10万以内のお部屋をピックアップしてお送りさせて頂きます！！" } };
const o = { customerName: "〇〇", conversationId: "c1", sentAt };
// off: 今まで通り【今日中】・約束した日
const off = promiseEventRows([e4], { ...o, env: {} });
assert.ok(off[0].title.startsWith("【今日中】")); assert.equal(off[0].start_at, sentAt);
// on: 12/17 の朝に置き、【今日中】を付けない
const on = promiseEventRows([e4], { ...o, env: { CALENDAR_PROMISE_DUE_TEXT: "on" } });
assert.ok(!on[0].title.startsWith("【今日中】")); assert.equal(on[0].start_at, "2026-12-17T01:00:00.000Z");
assert.ok(!on[0].notes.split("\n")[0].includes("【今日中】"));
// 「12月中旬ごろになりましたら…再開」→ 12/20（ac34b364 の形）
assert.equal(promiseLaterDueStartAt("2026-11-18T09:12:00.000Z", "1月末ごろのお引越しに向け12月中旬ごろになりましたら本格的にお部屋探し再開させていただきます！！"), "2026-12-20T01:00:00.000Z");
// 期日の言葉が無い・同じ日（本日中）・dueText が無い時は今まで通り（null）
assert.equal(promiseLaterDueStartAt(sentAt, "ご条件に合ったお部屋ピックアップしてお送りさせて頂きます"), null);
assert.equal(promiseLaterDueStartAt(sentAt, "本日中にお部屋をピックアップしてお送りさせて頂きます"), null);
assert.equal(promiseLaterDueStartAt(sentAt, null), null);
// 入居の時期は期日にしない（8739fa57 の形）
assert.equal(promiseLaterDueStartAt(sentAt, "12月初旬のご入居に間に合うよう、至急ピックアップしてお送りさせて頂きます"), null);
// 「12/13のご入居に間に合うよう最速で」の入居の日付は期日にしない（43e1cbb5 の形）・「2月14日に…お送り」は期日（7822e109 の形）
assert.equal(promiseLaterDueStartAt("2026-11-21T01:27:00.000Z", "並行して〇〇周辺のオススメできるお部屋もピックアップし、12/13のご入居に間に合うよう最速で進めさせて頂きます！！"), null);
assert.equal(promiseLaterDueStartAt("2026-11-16T06:51:00.000Z", "2月14日に〇〇さんのご条件に合ったお部屋をピックアップしお送りさせて頂きます！！"), "2027-02-14T01:00:00.000Z");
console.log("promise-calendar-due-text: ok");
