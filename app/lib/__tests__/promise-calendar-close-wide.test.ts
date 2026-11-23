// npx tsx app/lib/__tests__/promise-calendar-close-wide.test.ts
// 2026-11-23 作業員L（台帳 #652）: カレンダーの【必ず】の閉じ方を2つ広げる（PROMISE_CALENDAR_CLOSE_WIDE=on の時だけ・既定 off）。本番の行の形を伏せて使う
import assert from "node:assert/strict";
import { planPromiseCompletion, promiseCalendarCloseWideOn } from "../promise-calendar";

const ON = { PROMISE_CALENDAR_CLOSE_WIDE: "on" }, OFF = {};
assert.equal(promiseCalendarCloseWideOn({}), false);
assert.equal(promiseCalendarCloseWideOn(ON), true);
const row = (id: number, head: string) => ({ id, event_type: "follow_up", notes: `${head}\n約束: 「…」`, is_done: false });

// ①「保証会社の確認」の行 ← 報告の要件「審査」（7f73dc32 の形）
{
  const open = [row(1, "【必ず】保証会社の確認→ご連絡")];
  const done = [{ kind: "confirmation_reported" as const, object: "審査" }];
  assert.deepEqual(planPromiseCompletion(done, open, OFF), []);
  assert.deepEqual(planPromiseCompletion(done, open, ON), [1]);
  // 言い換えの組の外は今まで通り閉じない（退去 ← 入居時期・内覧可否 ← 募集状況）
  assert.deepEqual(planPromiseCompletion([{ kind: "confirmation_reported", object: "入居時期" }], [row(2, "【必ず】退去の確認→ご連絡")], ON), []);
}
// ②物件名のある「初期費用の確認」← その物件の「募集に出ていない」の報告（dbe2cf9c の形）
{
  const open = [row(3, "【必ず】初期費用の確認→ご連絡（〇〇タワー大阪）"), row(4, "【必ず】初期費用の確認→ご連絡（△△レジデンス）")];
  const done = [{ kind: "confirmation_reported" as const, object: "募集状況", checkPattern: "unavailable", propertyNames: ["〇〇タワー大阪"] }];
  assert.deepEqual(planPromiseCompletion(done, open, OFF), []);
  assert.deepEqual(planPromiseCompletion(done, open, ON), [3]); // 別の物件の行（4）は閉じない
  // 報告に物件名が無い時は閉じない・募集中の報告では閉じない
  assert.deepEqual(planPromiseCompletion([{ kind: "confirmation_reported", object: "募集状況", checkPattern: "unavailable" }], open, ON), []);
  assert.deepEqual(planPromiseCompletion([{ kind: "confirmation_reported", object: "募集状況", checkPattern: "available", propertyNames: ["〇〇タワー大阪"] }], open, ON), []);
}
console.log("promise-calendar-close-wide: ok");
