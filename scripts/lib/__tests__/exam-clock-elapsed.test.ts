// scripts/lib/__tests__/exam-clock-elapsed.test.ts（npx tsx scripts/lib/__tests__/exam-clock-elapsed.test.ts）
import { installExamClock, setExamClockSigned, setExamClockOffset, realNow } from "../exam-clock";
import { problemHash } from "../brain-exam-baseline";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean) => { if (ok) pass++; else { fail++; console.log("FAIL", n); } };
installExamClock();
const r0 = realNow();
setExamClockSigned(-62 * 60_000); // 62分先へ（8931 の元の経過）
const d = Date.now() - r0;
t("時計を62分先に進められる", d >= 62 * 60_000 - 1000 && d <= 62 * 60_000 + 5000);
setExamClockOffset(0);
t("0 で元に戻る", Math.abs(Date.now() - realNow()) < 1000);
const p = { id: "q1", builtAt: "a", context: [], staffText: "x" };
t("問題の hash は元の経過の欄で変わらない", problemHash(p) === problemHash({ ...p, staffDelayMin: 62 }) && problemHash(p) !== problemHash({ ...p, staffText: "y" }));
console.log(`exam-clock-elapsed: ${pass} pass / ${fail} fail`); if (fail) process.exit(1);
