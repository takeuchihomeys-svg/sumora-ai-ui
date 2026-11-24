// 2026-11-25 作業員L（台帳 #664 の④）: 統括に渡す読みの「今」を本当の今に（OVERDUE_NOW_CLOCK・既定 off）
//   形は本番の 7d5c6008（会話の文は入れない・同じ形の作りの通）: 確認の約束の後にお客様の通が1つ・その後に期限（72時間）を過ぎてから裏で回った番
import assert from "node:assert/strict";
import { overdueReadClock, overdueNowClockOn, OVERDUE_PROMISES_TIMEOUT_MS, OVERDUE_PROMISES_TIMEOUT_MS_WIDE } from "../conductor-overdue-promises";
import { overduePromisesOf, promiseDropOf, type PdInput } from "../promise-drop-watch";

const H = 3_600_000;
const T0 = Date.parse("2026-11-21T06:39:00Z");
const at = (h: number) => new Date(T0 + h * H).toISOString();
const input: PdInput = {
  conversationId: "c", customerName: null, status: "searching",
  msgs: [
    { sender: "staff", text: "募集状況確認させて頂きます!", created_at: at(0), is_aix_generated: false },
    { sender: "customer", text: "よろしくお願いします", created_at: at(70) },
  ] as PdInput["msgs"],
  aix: [], sent: [], items: [], picks: [],
};
const turnAt = at(70); // 一番新しい通（お客様）
const now = T0 + 76 * H; // 期限（72時間）の後に裏で回った番

assert.equal(overdueNowClockOn({}), false, "既定は on ではない");
// off（今まで通り）: 最後の通の時刻で読む＝期限の前＝0件（本番の n=0）
const off = overdueReadClock({ turnAt, nowMs: now, env: { OVERDUE_NOW_CLOCK: "off" } });
assert.deepEqual([off.by, off.timeoutMs], ["turn", OVERDUE_PROMISES_TIMEOUT_MS]);
assert.equal(overduePromisesOf(input, off.nowMs).length, 0);
// on: 本当の今で読む＝見張り（promiseDropOf を同じ今で）と同じ 1件
const on = overdueReadClock({ turnAt, nowMs: now, env: { OVERDUE_NOW_CLOCK: "on" } });
assert.deepEqual([on.by, on.nowMs, on.timeoutMs], ["now", now, OVERDUE_PROMISES_TIMEOUT_MS_WIDE]);
const n = overduePromisesOf(input, on.nowMs).length;
assert.equal(n, 1);
assert.equal(promiseDropOf(input, now) ? 1 : 0, n, "見張りと同じ数");
// 試験の再生（REPLAY_FLOOR_FILE）は on でも最後の通の時刻（試験の時刻を崩さない）
assert.equal(overdueReadClock({ turnAt, nowMs: now, env: { OVERDUE_NOW_CLOCK: "on", REPLAY_FLOOR_FILE: "x.json" } }).by, "turn");
// 最後の通が無い時は今
assert.equal(overdueReadClock({ turnAt: null, nowMs: now, env: {} }).nowMs, now);
console.log("overdue-now-clock: ok");
// shadow: 渡すのは今まで通り・本当の今は記録用に
{
  const sh = overdueReadClock({ turnAt, nowMs: now, env: { OVERDUE_NOW_CLOCK: "shadow" } });
  assert.deepEqual([sh.by, sh.nowMs === Date.parse(turnAt) + 1, sh.shadowNowMs], ["turn", true, now]);
  assert.equal(overdueReadClock({ turnAt, nowMs: now, env: { OVERDUE_NOW_CLOCK: "shadow", REPLAY_FLOOR_FILE: "x" } }).shadowNowMs, undefined, "試験では記録しない");
  console.log("overdue-now-clock shadow: ok");
}
// 既定は shadow（記録だけ）・digest の形
{
  const { overdueNowClockShadow, overdueNowDigest, parseOverdueNowDigest } = require("../conductor-overdue-promises") as typeof import("../conductor-overdue-promises");
  assert.equal(overdueNowClockShadow({}), true, "既定 shadow");
  assert.equal(overdueNowClockShadow({ OVERDUE_NOW_CLOCK: "off" }), false);
  assert.equal(overdueReadClock({ turnAt, nowMs: now, env: {} }).shadowNowMs, now, "既定で本当の今を記録用に");
  assert.equal(overdueNowDigest({ nTurn: 0, nNow: 1, gapH: 6 }), "0|1|6");
  assert.deepEqual(parseOverdueNowDigest("-|2|3"), { nTurn: null, nNow: 2, gapH: 3 });
  console.log("overdue-now-clock default shadow: ok");
}
