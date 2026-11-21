// npx tsx app/lib/__tests__/viewing-confirmed.test.ts
// 2026-11-21 作業員N2（台帳 #579 の続き）: カレンダーの viewing が決まった内覧か（ブレインの内覧調整のタスク・時間確保の候補は違う）
import assert from "node:assert/strict";
import { isConfirmedViewingEvent, viewingConfirmedOnlyOn } from "../viewing-confirmed";

// ブレインの「内覧調整」（brain-core createCalendarEventFromBrainAction の形そのまま）
assert.equal(isConfirmedViewingEvent({ event_type: "viewing", all_day: true, title: "山田 内覧調整", notes: "件数: 1件\n物件: （未確定）（現地）" }), false);
// save-reply-example の終日の約束（題は内覧調整でなくても物件が未確定の終日）
assert.equal(isConfirmedViewingEvent({ event_type: "viewing", all_day: true, title: "山田 内覧", notes: "件数: 1件\n物件: （未確定）（現地）" }), false);
// 時間確保の候補
assert.equal(isConfirmedViewingEvent({ event_type: "viewing", all_day: false, title: "【確保】山田 内覧", notes: "【時間確保】\n候補: 明日 15:30" }), false);
// 時刻のある未確定（スタッフが「14時にご案内」と約束した物）は日時の決まった内覧として残す
assert.equal(isConfirmedViewingEvent({ event_type: "viewing", all_day: false, title: "山田 内覧", notes: "件数: 1件\n物件: （未確定）（現地）" }), true);
// 待ち合わせで作った内覧（AixModal・内覧方法が未入力の形も）
assert.equal(isConfirmedViewingEvent({ event_type: "viewing", all_day: false, title: "山田 内覧 メゾンA", notes: "住所: 大阪市" }), true);
assert.equal(isConfirmedViewingEvent({ event_type: "viewing", all_day: false, title: "山田 内覧", notes: "【物件】メゾンA / 内覧方法未入力" }), true);
assert.equal(isConfirmedViewingEvent({ event_type: "phone", all_day: false, title: "電話", notes: null }), false);
assert.equal(isConfirmedViewingEvent({ all_day: false, title: "x", notes: null }), true, "event_type を渡さなければ種類は見ない");
assert.equal(viewingConfirmedOnlyOn({}), false, "既定 off");
assert.equal(viewingConfirmedOnlyOn({ VIEWING_CONFIRMED_ONLY: "on" }), true);
console.log("viewing-confirmed: ok");
