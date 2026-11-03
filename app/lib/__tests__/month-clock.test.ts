// app/lib/__tests__/month-clock.test.ts — 月の言い方を読む時計（試験の時だけずらす前の時刻）
//   実行: npx tsx app/lib/__tests__/month-clock.test.ts
import { monthClockNowIso, monthClockShiftMs } from "../business-clock";
import { farMoveInTurn } from "../contact-promise";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const now = Date.parse("2026-11-03T03:00:00Z");
t("本番（LLM_TEST_MODE 無し）は今そのもの", monthClockNowIso({ EXAM_MONTH_SHIFT_DAYS: "30" }, now) === new Date(now).toISOString());
t("試験はずらした日数だけ戻す", monthClockNowIso({ LLM_TEST_MODE: "deepseek-all", EXAM_MONTH_SHIFT_DAYS: "30" }, now) === "2026-10-04T03:00:00.000Z");
t("読めない値・0 はずらさない", monthClockShiftMs({ LLM_TEST_MODE: "x", EXAM_MONTH_SHIFT_DAYS: "abc" }) === 0 && monthClockShiftMs({ LLM_TEST_MODE: "x", EXAM_MONTH_SHIFT_DAYS: "0" }) === 0);
// 9月に「10月入居」と言った問題を 11/03 の試験で読む: 今日で読むと来年の10月＝先の入居、ずらす前（9/20）で読むと今年の10月＝先ではない
const turn = [{ text: "お部屋探して頂けますか？", at: "2026-11-03T02:59:00Z" }];
const today = farMoveInTurn({ customerTurn: turn, conditionMoveIn: "10月", staffHistory: [], nowIso: new Date(now).toISOString() });
const atProblem = farMoveInTurn({ customerTurn: turn, conditionMoveIn: "10月", staffHistory: [], nowIso: monthClockNowIso({ LLM_TEST_MODE: "x", EXAM_MONTH_SHIFT_DAYS: "44" }, now) });
t("今日で読むと「10月」が先の入居になる（弱さの再現）", !!today);
t("ずらす前の時刻で読むと先の入居にならない", !atProblem);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
