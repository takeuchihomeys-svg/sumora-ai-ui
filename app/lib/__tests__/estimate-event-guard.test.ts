// npx tsx app/lib/__tests__/estimate-event-guard.test.ts
// 2026-11-22 作業員K2（台帳 #580・#596）: 見積の予定の重複を1つにする（ESTIMATE_EVENT_GUARD・既定 off）。形は本番の9会話（伏せた）
import assert from "node:assert/strict";
import { estimateEventGuardOn, duplicateEstimateEventIds } from "../estimate-event-guard";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
t("既定 off", () => { assert.equal(estimateEventGuardOn({}), false); assert.equal(estimateEventGuardOn({ ESTIMATE_EVENT_GUARD: "on" }), true); });
// 会話 A: ブレインの行どうしが同じ時刻に2つ（作成が1秒以内）
const A = [
  { id: 1, conversation_id: "convA", start_at: "2026-11-05T09:00:00Z", created_at: "2026-11-05T17:57:38.832Z", notes: "[Brain AIX] action=estimate_sheet", is_done: false },
  { id: 2, conversation_id: "convA", start_at: "2026-11-05T09:00:00Z", created_at: "2026-11-05T17:57:38.876Z", notes: "[Brain AIX] action=estimate_sheet", is_done: false },
];
// 会話 B: ブレインの行と【必ず】の行
const B = [
  { id: 3, conversation_id: "convB", start_at: "2026-11-16T09:00:00Z", created_at: "2026-11-16T14:46:06Z", notes: "[Brain AIX] action=estimate_sheet", is_done: false },
  { id: 4, conversation_id: "convB", start_at: "2026-11-16T09:00:01Z", created_at: "2026-11-16T14:46:07Z", notes: "【必ず】御見積書をお送りする", is_done: false },
];
t("ブレインの行どうしは早く作った方を残す", () => { assert.deepEqual(duplicateEstimateEventIds(A), [2]); });
t("【必ず】の行を残す", () => { assert.deepEqual(duplicateEstimateEventIds(B), [3]); });
t("日が違う・会話が違う・済みの行は束ねない", () => {
  assert.deepEqual(duplicateEstimateEventIds([{ ...A[0] }, { ...A[1], start_at: "2026-11-06T09:00:00Z" }]), []);
  assert.deepEqual(duplicateEstimateEventIds([{ ...A[0] }, { ...A[1], conversation_id: "convZ" }]), []);
  assert.deepEqual(duplicateEstimateEventIds([{ ...A[0] }, { ...A[1], is_done: true }]), []);
});
console.log(`${n} ok`);
