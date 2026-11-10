// scripts/exam-reflection-weekly.ts — 試験の振り返りの週の集計（読むだけ・LLM も DB も使わない）
//
// 2026-11-10 作業員8c（KB 7b5ef932 ⑦振り返る）: exam-queue/results/*.json の reflection（無い古い結果は残っている欄から作り直す）を読み、
//   何も見つけなかった問題の割合・費用（何も見つけなかった問題の分は回の数で割り振った見込み）・作業員ごと・守り（EXAM_AUTO_GUARDS）が見つけた数を出す。
//   月曜の朝の拾い上げで読む: exam-queue/results/reflection-weekly-<日付>.md（と .json）。
// 使い方: npx tsx scripts/exam-reflection-weekly.ts [--days=7] [--to=2026-11-10] [--no-write]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { readWeeklyRows } from "./lib/exam-reflection-io";
import { summarizeWeek, weeklyMarkdown } from "./lib/exam-reflection";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ROOT = join(examCacheRoot(), "exam-queue");
const RES = join(ROOT, "results"), DONE = join(ROOT, "done");

const days = Math.max(1, Number(arg("days", "7")) || 7);
const toMs = arg("to") ? Date.parse(`${arg("to")}T00:00:00+09:00`) + 86_400_000 : Date.now();
const fromMs = toMs - days * 86_400_000;
const rows = readWeeklyRows(RES, DONE, fromMs, toMs);
const s = summarizeWeek(rows, { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() });
const md = weeklyMarkdown(s);
console.log(md);
if (!args.includes("--no-write")) {
  mkdirSync(RES, { recursive: true });
  const day = new Date(toMs + 9 * 3_600_000 - 1).toISOString().slice(0, 10);
  writeFileSync(join(RES, `reflection-weekly-${day}.md`), md);
  writeFileSync(join(RES, `reflection-weekly-${day}.json`), JSON.stringify({ ...s, runner: "reflection-weekly" }, null, 1));
  console.log(`書いた: ${join(RES, `reflection-weekly-${day}.md`)}`);
}
