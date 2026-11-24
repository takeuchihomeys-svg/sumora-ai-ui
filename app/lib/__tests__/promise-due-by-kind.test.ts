// 2026-11-25 作業員L（台帳 #664 の②）: 期限の言葉が無い約束の期限を種類ごとに（PROMISE_DUE_BY_KIND・既定 off）
import assert from "node:assert/strict";
import { promiseDeadlineMs, promiseDueByKindOn } from "../promise-drop-watch";

const at = Date.parse("2026-11-20T03:00:00Z"), H = 3_600_000;
const on = { PROMISE_DUE_BY_KIND: "on" };
assert.equal(promiseDueByKindOn({}), false, "既定 off");
assert.equal(promiseDeadlineMs("確認させて頂きます", at, "check", {}).ms, at + 72 * H, "off は72時間");
assert.equal(promiseDeadlineMs("確認させて頂きます", at, "check", on).ms, at + 24 * H, "確認は24時間");
assert.equal(promiseDeadlineMs("ピックアップさせて頂きます", at, "pickup", on).ms, at + 48 * H, "ピックアップは48時間");
assert.equal(promiseDeadlineMs("御見積書を作成させて頂きます", at, "estimate", on).ms, at + 72 * H, "見積は72時間のまま");
assert.equal(promiseDeadlineMs("明日確認させて頂きます", at, "check", on).by, "words", "期限の言葉があれば今まで通り");
assert.equal(promiseDeadlineMs("確認させて頂きます", at).ms, at + 72 * H, "種類を渡さない呼び方は今まで通り");
console.log("promise-due-by-kind: ok");
