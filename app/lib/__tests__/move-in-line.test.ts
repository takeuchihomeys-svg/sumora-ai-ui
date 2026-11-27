// 2026-11-27 作業員L: 入居の時期と期限の1行（MOVE_IN_LINE・既定 off）と作業員A の時間の地図の入力（moveInFor・openPromisesWithDue）
// 実行: npx tsx app/lib/__tests__/move-in-line.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moveInFor, moveInLine, moveInLineOn } from "../move-in-line";
import { openPromisesWithDue } from "../promise-drop-watch";
import { SWITCH_TARGET_MARK } from "../../../scripts/lib/exam-snapshot-need";

const now = "2026-11-27T03:00:00.000Z";
assert.equal(moveInLineOn({}), false, "既定 off");
const reg = moveInFor({ registered: "2027年1月15日", nowIso: now });
assert.deepEqual([reg.kind, reg.startYmd, reg.source], ["date", "2027-01-15", "registered"]);
assert.match(moveInLine(reg, now), /^【入居の時期と期限】1\/15.*あと 49日（登録の条件）・申込の目安は入居の30〜14日前$/, "作業員A の APPLY_LEAD_DAYS と同じ数");
const conv = moveInFor({ registered: "2027年1月15日", customerMsgs: [{ text: "内覧は12月5日でお願いします", created_at: "2026-11-26T01:00:00Z" }, { text: "入居は12月20日頃にしたいです", created_at: "2026-11-25T01:00:00Z" }], nowIso: now });
assert.deepEqual([conv.kind, conv.startYmd, conv.source], ["date", "2026-12-20", "conversation"], "入居の語のある通だけで上書き（内覧の日は取り違えない）");
assert.equal(moveInFor({ registered: "未定", nowIso: now }).kind, "unknown");
assert.equal(moveInLine(moveInFor({ registered: "", nowIso: now }), now), "", "読めない時は空");
// 約束の期日（期限前も含む・作業員A の PromiseDue の形）
const msgs = [
  { sender: "customer", text: "空室ありますか", created_at: "2026-11-26T00:00:00Z", is_aix_generated: false },
  { sender: "staff", text: "管理会社に確認させて頂きます", created_at: "2026-11-26T01:00:00Z", is_aix_generated: false },
];
const ps = openPromisesWithDue({ status: null, msgs: msgs as never, aix: [], sent: [] } as never, Date.parse("2026-11-26T02:00:00Z"));
assert.ok(ps.length >= 1 && ps.every((p) => typeof p.overdue === "boolean" && p.dueAt > p.promisedAt), "期限前の約束も出る");
assert.equal(ps[0].overdue, false);
assert.equal(SWITCH_TARGET_MARK.MOVE_IN_LINE, "move_in_line", "印の決まり（SWITCH_TARGET_MARK）");
const core = readFileSync(join(__dirname, "../brain-core.ts"), "utf8");
assert.ok(/mil\.moveInLineOn\(\) && !isPostApplyStatus\(convStatus\)/.test(core) && core.includes("materialMarks.move_in_line = moveInMarkLen"), "配線・申込以降は出さない・印");
console.log("move-in-line ok 11");
