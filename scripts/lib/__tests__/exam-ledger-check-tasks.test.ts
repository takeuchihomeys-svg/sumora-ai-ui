// 空室確認のタスクの写し（scripts/lib/exam-ledger-check-tasks.ts）
// 実行: npx tsx scripts/lib/__tests__/exam-ledger-check-tasks.test.ts（全 PASS で exit 0）
import { checkTaskInsertRows, examLedgerCheckTasksOn, pickCheckTaskRows } from "../exam-ledger-check-tasks";
import { checkResultState } from "../../../app/lib/check-result-state";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };

const AT = "2026-10-20T07:48:00Z";
const base = { conversation_id: "c-1", customer_name: "本名", result_note: "〇〇様 電話で確認", };
const rows = [
  { ...base, id: "a", task_type: "property_check", status: "completed", created_at: "2026-10-20T05:00:00Z", resolved_at: "2026-10-20T09:00:00Z", completed_at: null, result: "available" }, // 番の後に閉じた
  { ...base, id: "b", task_type: "property_check", status: "completed", created_at: "2026-10-19T05:00:00Z", resolved_at: "2026-10-19T06:00:00Z", completed_at: null, result: "taken" },
  { ...base, id: "c", task_type: "property_search", status: "pending", created_at: "2026-10-20T06:00:00Z", resolved_at: null, completed_at: null, result: null }, // 別の種類
  { ...base, id: "d", task_type: "property_check", status: "pending", created_at: "2026-10-20T08:00:00Z", resolved_at: null, completed_at: null, result: null }, // 番の後に作られた
];

ok("既定 off・on で入る", !examLedgerCheckTasksOn({}) && examLedgerCheckTasksOn({ EXAM_LEDGER_CHECK_TASKS: " ON " }) && !examLedgerCheckTasksOn({ EXAM_LEDGER_CHECK_TASKS: "off" }));
const p = pickCheckTaskRows(rows, AT);
ok("property_check だけ・番より前に作られた行だけ・古い順", p.map((x) => x.row.id).join(",") === "b,a", p.map((x) => x.row.id));
const a = p.find((x) => x.row.id === "a")!;
ok("番の後に閉じた行は開いていた形に巻き戻す", a.row.status === "pending" && a.row.result === null && a.row.resolved_at === null, a.row);
const b = p.find((x) => x.row.id === "b")!;
ok("番の前に閉じた行は結果を残す", b.row.status === "completed" && b.row.result === "taken" && b.row.resolved_at === "2026-10-19T06:00:00Z");
ok("自由文・本名を写さない", p.every((x) => !("result_note" in x.row) && x.row.customer_name === "YUMA" && !JSON.stringify(x.row).includes("本名") && !JSON.stringify(x.row).includes("様")));
ok("ago は番の何分前か", a.ago === 168 && b.ago === 1608, [a.ago, b.ago]);
ok("決まった値でない result は落とす", pickCheckTaskRows([{ ...rows[1], result: "空いていました 〇〇様" }], AT)[0].row.result === null);
ok("申込の書類の網に当たる行は落とす", pickCheckTaskRows(rows, AT, (s) => s.includes("\"id\":\"b\"")).map((x) => x.row.id).join(",") === "a");
ok("時刻が読めない番は空", pickCheckTaskRows(rows, "x").length === 0);
ok("上限 10行（新しい方から）", pickCheckTaskRows(Array.from({ length: 14 }, (_, i) => ({ ...rows[1], id: `k${i}`, created_at: new Date(Date.parse("2026-10-01T00:00:00Z") + i * 3600_000).toISOString(), resolved_at: null, status: "cancelled" })), AT).map((x) => x.row.id)[0] === "k4");

// 写した行で CHECK_RESULT_STATE が本番の番と同じ状態になる（試験で none にならない）
const atMs = Date.parse(AT);
const ins = checkTaskInsertRows(p, "yuma2", (ago) => new Date(atMs - ago * 60_000).toISOString(), atMs);
ok("入れる行: id なし・会話はテスト用・本名なし", ins.every((o) => !("id" in o) && o.conversation_id === "yuma2" && o.customer_name === "YUMA" && !("result_note" in o)));
const st = checkResultState(ins.map((o) => ({ task_type: String(o.task_type), status: String(o.status), created_at: String(o.created_at), result: (o.result as string | null) ?? null, resolved_at: (o.resolved_at as string | null) ?? null })), atMs);
ok("番の時点の状態は pending（開いていて結果なし）", st.state === "pending", st);
const prodSt = checkResultState(rows.filter((r) => r.id === "b").map((r) => ({ task_type: r.task_type, status: r.status, created_at: r.created_at, result: r.result, resolved_at: r.resolved_at })), atMs);
ok("結果が手元の行だけなら on_hand のまま", checkResultState(checkTaskInsertRows(pickCheckTaskRows([rows[1]], AT), "yuma2", (ago) => new Date(atMs - ago * 60_000).toISOString(), atMs).map((o) => ({ task_type: String(o.task_type), status: String(o.status), created_at: String(o.created_at), result: (o.result as string | null) ?? null })), atMs).state === prodSt.state && prodSt.state === "on_hand");

console.log(`exam-ledger-check-tasks: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
