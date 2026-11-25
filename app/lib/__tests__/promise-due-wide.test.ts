// 2026-11-25 作業員L（台帳 #664 の②）: 期限の言葉の広げ（PROMISE_DUE_WIDE・既定 off）
import assert from "node:assert/strict";
import { promiseDueDay, promiseDueWideOn } from "../promise-due";

const said = Date.parse("2026-11-20T03:00:00Z"); // 11/20（金）JST 12時
const on = { PROMISE_DUE_WIDE: "on" };
const ymd = (d: number | null) => (d == null ? null : new Date(d).toISOString().slice(0, 10));
assert.equal(promiseDueWideOn({}), false, "既定 off");
assert.equal(promiseDueDay("翌営業日に確認させて頂きます", said), null, "off は今まで通り");
assert.equal(ymd(promiseDueDay("翌営業日に確認させて頂きます", said, on)), "2026-11-23", "金曜の翌営業日は月曜");
assert.equal(ymd(promiseDueDay("25日までにお送りさせて頂きます", said, on)), "2026-11-25");
assert.equal(ymd(promiseDueDay("5日にご連絡させて頂きます", said, on)), "2026-12-05", "過ぎた日は翌月");
assert.equal(ymd(promiseDueDay("12/1にお送りします", said, on)), "2026-12-01", "月のある形は今まで通り");
assert.equal(promiseDueDay("至急確認させて頂きます", said, on), null, "至急は日が決まらない");
console.log("promise-due-wide: ok");
