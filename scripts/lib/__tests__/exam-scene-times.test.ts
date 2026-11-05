// 試験の場面の通の時刻（scripts/lib/exam-scene-times.ts）
// 実行: npx tsx scripts/lib/__tests__/exam-scene-times.test.ts（自己完結。全 PASS で exit 0）
import { gapSceneTimes, gapSceneTimesByDay, jstDayOf, examRealGapsOn } from "../exam-scene-times";
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
// 2026-11-06 弱い所 353: 日の区切りを元の番に合わせる
{
  const day = (iso: string) => jstDayOf(Date.parse(iso));
  const at = Date.parse("2026-10-28T05:00:00Z"); // 元の番 JST 14:00
  const mid = Date.parse("2026-11-05T15:03:00Z"); // 試験を流した今 JST 0:03（0時の直後）
  // 元は全部同じ日（14:00 の 20分前・10分前・今）→ 0時直後に流しても1日に収める（間は縮める）
  const t1 = gapSceneTimesByDay([20, 10, 0], at, mid);
  eq("0時直後でも元が同じ日なら1日に収める", new Set(t1.map(day)).size, 1);
  eq("最後の通は end", t1[2], new Date(mid).toISOString());
  // 元は前の日に2通・番の日に1通（前の日の 22:00 と 22:10・番の日 14:00）→ 前の日と番の日の2日に分かれる
  const t2 = gapSceneTimesByDay([16 * 60 + 10, 16 * 60, 0], at, Date.parse("2026-11-05T05:00:00Z"));
  eq("前の日の通は前の日に置く", [day(t2[0]) - day(t2[2]), day(t2[1]) - day(t2[2])], [-1, -1]);
  eq("前の日の中の間は元の間（10分→5分の頭打ち）", (Date.parse(t2[1]) - Date.parse(t2[0])) / 1000, 300);
  // 昼に流した時は今まで通りの間（90秒〜5分）
  const t3 = gapSceneTimesByDay([20, 19, 2, 0], at, Date.parse("2026-11-05T05:00:00Z"));
  eq("昼は今まで通りの間", t3.slice(1).map((x, k) => (Date.parse(x) - Date.parse(t3[k])) / 1000), [90, 300, 120]);
}
console.log(`${pass} pass / ${fail} fail`); process.exit(fail ? 1 : 0);
