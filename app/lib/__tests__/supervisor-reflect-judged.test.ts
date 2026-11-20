// 2026-11-20 竹内さん「反映の流れ」: 統括が判断する読まれ数は「判断する束」の値（前の束の値ではない）。
// 実行: npx tsx app/lib/__tests__/supervisor-reflect-judged.test.ts
import { judgedReadCount } from "../learn-supervisor";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); } }

console.log("■ 判断する束の読まれ数");
{
  // 束を作った時: 前の束は読まれて3回・新しい束は作ったばかり（0）
  const atBuild = { read_count: 3, prev_read_count: 3, judged_read_count: 0, auto_after: false, screen_solid: 33 } as const;
  ok("作った時は新しい束の 0 を使う（前の束の 3 ではない）", judgedReadCount(atBuild) === 0, String(judgedReadCount(atBuild)));
  // 統括Pro で最新行を読んだ時: 判断する束の今の値
  const live = { read_count: 5, judged_read_count: 5, prev_read_count: 3 };
  ok("最新行の今の値（judged）を使う", judgedReadCount(live) === 5);
  // 古い形（judged が無い）: 従来の read_count
  ok("judged が無い古い形は read_count を使う", judgedReadCount({ read_count: 2 }) === 2);
  ok("何も無い時は 0", judgedReadCount(null) === 0 && judgedReadCount(undefined) === 0);
  ok("負の値・非数は 0", judgedReadCount({ judged_read_count: -4 }) === 0 && judgedReadCount({ read_count: Number.NaN }) === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
