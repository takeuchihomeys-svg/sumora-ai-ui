// npx tsx scripts/lib/__tests__/timeline-delivery.test.ts
// 2026-11-23 作業員L（台帳 #7）: 時系列の帳面の欄ごとの届き方と、書き手への約束と連絡の日（SITUATION_WRITER_TIMELINE_PROMISES・既定 off）
import assert from "node:assert/strict";
import { timelineDeliveryOf, sumTimelineDelivery, timelineMetricRows } from "../timeline-delivery";
import { situationWriterNote, situationWriterTimelinePromisesOn } from "../../../app/lib/situation-now";

const now = Date.parse("2026-11-23T03:00:00Z"); // JST 12時
const sn = { v: 1, timeline: {
  words: [1, 2, 3, 4].map((i) => ({ word: `来月${i}`, said: "2026-11-20T00:00:00Z", from: null, to: null, label: "12月" })),
  viewings: [{ at: "2026-11-25T05:00:00Z", type: "viewing", done: false }, { at: "2026-11-10T05:00:00Z", type: "viewing", done: true }],
  promises: [{ at: "2026-11-24T01:00:00Z", type: "follow_up" }, { at: "2026-11-01T01:00:00Z", type: "property_send" }],
} };
const off = timelineDeliveryOf(sn, now, {});
assert.deepEqual(off.words, { n: 4, toBrain: 4, toWriter: 3 });
assert.deepEqual(off.viewings, { n: 2, toBrain: 2, toWriter: 1, nW: 1 }); // 11/26: 書き手の分母は 12時間前より後で済みでない内覧
assert.deepEqual(off.promises, { n: 2, toBrain: 2, toWriter: 0, wOff: true });
const on = timelineDeliveryOf(sn, now, { SITUATION_WRITER_TIMELINE_PROMISES: "on" });
assert.deepEqual(on.promises, { n: 2, toBrain: 2, toWriter: 1, wOff: false });
// 書き手の注記: off は今と同じ・on は今日以降の約束と連絡の日だけ
assert.equal(situationWriterTimelinePromisesOn({}), false);
assert.ok(!/カレンダーの約束と連絡の日/.test(situationWriterNote(sn, now, {})));
const note = situationWriterNote(sn, now, { SITUATION_WRITER_TIMELINE_PROMISES: "on" });
assert.match(note, /カレンダーの約束と連絡の日: 11\/24（追いかけの連絡）/);
assert.ok(!/11\/1（物件の送付）/.test(note));
// 数の名前
const rows = timelineMetricRows(sumTimelineDelivery([off]), 72);
assert.ok(!rows.some((r) => r.metric === "writer_link:timeline:promises:to_writer"), "11/26: 書き手への配線が off の欄は書き手の行を出さない（作っていない）");
assert.ok(rows.some((r) => r.metric === "writer_link:timeline:viewings:to_writer" && r.value === 100 && r.n === 1), "内覧の書き手の分母は渡す対象");
// 書き手への届きで作っていない欄（a・d だけ）は分母から外す
import { notBuiltField } from "../self-improve-growth";
assert.equal(notBuiltField({ writerOk: 0, whyNo: { a: 2 } }), true);
assert.equal(notBuiltField({ writerOk: 0, whyNo: { d: 1, a: 1 } }), true);
assert.equal(notBuiltField({ writerOk: 0, whyNo: { a: 1, c: 1 } }), false, "渡したのに使われない(c)は数える");
assert.equal(notBuiltField({ writerOk: 1, whyNo: { d: 1 } }), false);
assert.ok(rows.some((r) => r.metric === "writer_link:timeline:words:to_writer" && r.value === 75));
console.log("timeline-delivery: ok");
