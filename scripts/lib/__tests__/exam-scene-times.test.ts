// 試験の場面の通の時刻（scripts/lib/exam-scene-times.ts）
// 実行: npx tsx scripts/lib/__tests__/exam-scene-times.test.ts（自己完結。全 PASS で exit 0）
import { gapSceneTimes, examRealGapsOn } from "../exam-scene-times";
let fail = 0, pass = 0;
function eq(name: string, a: unknown, b: unknown) { const ok = JSON.stringify(a) === JSON.stringify(b); if (ok) pass++; else { fail++; console.error(`✗ ${name}\n   得: ${JSON.stringify(a)}\n   期: ${JSON.stringify(b)}`); } }
const end = Date.parse("2026-11-05T02:00:00Z");
const gaps = (ago: number[]) => { const t = gapSceneTimes(ago, end).map((x) => Date.parse(x)); return t.slice(1).map((x, i) => (x - t[i]) / 1000); };
// q212（8959）: AIX 20分前・お客様 19分前・約束 2分前・スタンプ 0分
eq("長い間は5分で頭打ち・短い間は90秒", gaps([20, 19, 2, 0]), [90, 300, 120]);
eq("同じ分の連投は90秒（今まで通り）", gaps([0, 0, 0]), [90, 90]);
eq("最後の通は end", gapSceneTimes([5, 0], end)[1], "2026-11-05T02:00:00.000Z");
eq("空", gapSceneTimes([], end), []);
eq("既定 on", examRealGapsOn({}), true);
eq("off で旧", examRealGapsOn({ EXAM_REAL_GAPS: "off" }), false);
console.log(`${pass} pass / ${fail} fail`); process.exit(fail ? 1 : 0);
