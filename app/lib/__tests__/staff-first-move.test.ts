// app/lib/__tests__/staff-first-move.test.ts — こちらの「最初の一手」（番 10415 の型: 約束の返信の後に AIX）
//   実行: npx tsx app/lib/__tests__/staff-first-move.test.ts
import { staffFirstMove, aixLogsFromWatch } from "../staff-first-move";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const T = Date.parse("2026-11-03T10:37:31Z");
const aix = aixLogsFromWatch([{ at: "2026-11-03T11:05:00Z", aix_type: "property_check_result", check_pattern: "unavailable" }, { at: "2026-11-03T11:06:00Z", aix_type: "property_send", check_pattern: null }]);
const msgs = [{ at: Date.parse("2026-11-03T10:40:00Z"), isAix: false, writer: "takeuchi" }, { at: Date.parse("2026-11-03T11:05:10Z"), isAix: true, writer: "takeuchi" }];
const m = staffFirstMove(T, msgs, aix);
t("10415 の型: 最初の送信が約束の返信なら、一手は返信（後の AIX は数えない）", m?.kind === "reply" && m.aix === null && m.writer === "takeuchi");
const m2 = staffFirstMove(T, msgs.slice(1), aix);
t("最初の送信が AIX なら、その近くに押した AIX の種類とピッカー", m2?.kind === "aix" && m2.aix === "property_check_result" && m2.picker === "unavailable");
t("AIX の記録が近くに無ければ aix_unknown", staffFirstMove(T, [{ at: T + 60_000, isAix: true, writer: null }], [])?.aix === "aix_unknown");
t("番の前の送信・24時間より後は数えない・無ければ null", staffFirstMove(T, [{ at: T - 1000, isAix: false, writer: "x" }, { at: T + 86_400_001, isAix: false, writer: "x" }], []) === null);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
