// ブレインの行動台帳に line_tasks の結果を渡した時（2026-11-15 作業員H・TASK_RESULT_TO_LEDGER）
//   過去の試験の写しには結果の付いたタスクが無い（30日で 0/247）＝試験では差が出ない。台帳の形で確かめる:
//   AIX【物件確認した】の行と、その時刻に済んだタスクの結果が同時にある時に「確認結果の報告」が二重にならない（台帳の ±3分の重複除去）
// 実行: npx tsx app/lib/__tests__/task-result-to-ledger.test.ts
import { buildActionLedger } from "../action-ledger";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const at = "2026-11-09T10:48:08.000Z";
const aixRow = { aix_type: "property_check_result", check_pattern: "unavailable", created_at: at, sent_at: at, line_message_id: "m1", property_names: ["〇〇"], prop_statuses: ["unavailable"] };
const task = { task_type: "property_check", status: "completed", created_at: "2026-11-09T03:40:00.000Z", completed_at: at };
const reported = (l: ReturnType<typeof buildActionLedger>) => l.entries.filter((e) => e.kind === "confirmation_reported");
const noResult = buildActionLedger({ recentAixRows: [aixRow] as never, messages: [], lineTasks: [task] });
const withResult = buildActionLedger({ recentAixRows: [aixRow] as never, messages: [], lineTasks: [{ ...task, result: "taken" }] });
t("結果なし: AIX の行から1つ", reported(noResult).length === 1, reported(noResult));
t("結果あり: 同じ時刻の AIX の行と重ねても1つ（二重にしない）", reported(withResult).length === 1, reported(withResult));
const taskOnly = buildActionLedger({ recentAixRows: [], messages: [], lineTasks: [{ ...task, result: "available" }] });
t("AIX の行が読めない時（取得範囲の外）も結果のタスクから1つ立つ", reported(taskOnly).length === 1, taskOnly.entries);
const pendingOnly = buildActionLedger({ recentAixRows: [], messages: [], lineTasks: [{ ...task, status: "pending", completed_at: null }] });
t("未完了は確認の約束（今まで通り）", pendingOnly.entries.some((e) => e.kind === "confirmation_promised") && reported(pendingOnly).length === 0);
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
