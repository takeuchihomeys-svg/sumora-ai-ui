// scripts/__tests__/exam-conductor.test.ts — 試験の統括の関所（安い時間・本数の上限）
//   実行: npx tsx scripts/__tests__/exam-conductor.test.ts
import { cheapNow, maxExamsNow } from "../exam-conductor";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const jst = (iso: string) => new Date(Date.parse(iso) - 9 * 3600_000); // JST の時刻 → Date
t("平日 11:00 は混雑", !cheapNow(jst("2026-11-04T11:00:00Z")));
t("平日 13:30 は安い", cheapNow(jst("2026-11-04T13:30:00Z")));
t("平日 16:00 は混雑", !cheapNow(jst("2026-11-04T16:00:00Z")));
t("平日 20:00 は安い", cheapNow(jst("2026-11-04T20:00:00Z")));
t("土曜 11:00 は安い", cheapNow(jst("2026-11-07T11:00:00Z")));
t("営業時間は1本", maxExamsNow(jst("2026-11-04T20:00:00Z")) === 1);
t("夜は2本", maxExamsNow(jst("2026-11-04T23:00:00Z")) === 2 && maxExamsNow(jst("2026-11-05T03:00:00Z")) === 2);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
