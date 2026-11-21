// npx tsx scripts/lib/__tests__/timeline-coverage.test.ts
// 2026-11-21 作業員L（台帳 #7）: お客様の時の言葉が絶対の日付で記録に入ったか・窓の外の言葉を分ける
import assert from "node:assert/strict";
import { timelineCoverageOf, summarizeTimeline } from "../timeline-coverage";
import { buildTimeline, situationTimelineWideOn } from "../../../app/lib/situation-timeline";

assert.equal(situationTimelineWideOn({}), false);
assert.equal(situationTimelineWideOn({ SITUATION_TIMELINE_WIDE: "on" }), true);
const old = Date.parse("2026-11-01T03:00:00Z"), now = Date.parse("2026-11-21T03:00:00Z");
const msgs = [{ text: "入居は11月末くらいで考えています", atMs: old }, { text: "明日ならいけます", atMs: now - 36e5 }];
// 記録は窓の中の言葉だけ（今の本番の形）
const winOnly = buildTimeline({ customerMsgs: msgs.slice(1), calendar: [], nowMs: now }).words.map((w) => ({ word: w.word, from: w.fromMs ? new Date(w.fromMs).toISOString() : null }));
const r = timelineCoverageOf({ conv: "c1", msgs, recWords: winOnly, nowMs: now, windowStartMs: now - 2 * 36e5 });
assert.equal(r.expected, 2);
assert.equal(r.hit, 1);
assert.deepEqual(r.missing, ["11月末"]);
assert.equal(r.outOfWindow, 1);
assert.equal(r.outOfWindowHit, 0);
// 記録が無い番
assert.equal(timelineCoverageOf({ conv: "c2", msgs, recWords: null, nowMs: now }).noRecord, true);
const s = summarizeTimeline([r]);
assert.equal(s.expected, 2); assert.equal(s.hit, 1); assert.equal(s.outOfWindow, 1);
console.log("timeline-coverage: ok");
