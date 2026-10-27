// scripts/audit-staff-todo-flags.ts — 【やることリスト】の切替（STAFF_TODO_FAST_LOAD・TODO_FAR_MOVE_IN・TODO_TWO_LINE 等）の前後を本番の DB で比べる（読むだけ・送らない・書かない・LLM なし）
//   今の読み方（fast=off）と速い読み方（fast=on・締め切り 300秒）で同じ時点の一覧を作り、段ごとの時間と文の違いを出す。
//   実行: npx tsx --env-file=.env.local scripts/audit-staff-todo-flags.ts [--flags=TODO_FAR_MOVE_IN,TODO_TWO_LINE] [--at=<ISO>] [--show]
//   --flags を渡すと on の回だけその切替も on（読み込みは常に STAFF_TODO_FAST_LOAD の off／on を比べる）
import { supabase } from "../app/lib/supabase-server";
import { loadStaffTodoList } from "../app/lib/staff-todo-list-server";
import { composeStaffTodoPost } from "../app/lib/staff-todo-list";
import { createStageTimer, todoDeadlineAtMs } from "../app/lib/staff-todo-load-timing";
import { loadTodoSnapshots } from "../app/lib/staff-todo-reply-server";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const atMs = arg("at") ? Date.parse(arg("at")!) : Date.now();
const show = process.argv.includes("--show");
const flags = (arg("flags") ?? "").split(",").map((x) => x.trim()).filter(Boolean);

(async () => {
  const snaps = await loadTodoSnapshots(supabase);
  const run = async (fast: boolean) => {
    for (const f of flags) { if (fast) process.env[f] = "on"; else delete process.env[f]; }
    const timer = createStageTimer();
    const started = Date.now();
    const list = await loadStaffTodoList(supabase, atMs, { fastLoad: fast, timer, deadlineAtMs: fast ? todoDeadlineAtMs(started, 300) : null });
    const post = composeStaffTodoPost(list, { snapshots: snaps });
    return { ms: Date.now() - started, stages: timer.stages(), text: post.text ?? "", open: list.openCount, done: list.doneCount };
  };
  const off = await run(false);
  const on = await run(true);
  console.log(JSON.stringify({ at: new Date(atMs).toISOString(), off: { ms: off.ms, stages: off.stages, open: off.open, done: off.done, len: off.text.length }, on: { ms: on.ms, stages: on.stages, open: on.open, done: on.done, len: on.text.length } }, null, 1));
  // 文の違い（行の集合で比べる・並びの違いは別に数える）
  const a = off.text.split("\n"), b = on.text.split("\n");
  const onlyOff = a.filter((l) => !b.includes(l)), onlyOn = b.filter((l) => !a.includes(l));
  console.log(`same text: ${off.text === on.text} / 行の違い off だけ ${onlyOff.length}・on だけ ${onlyOn.length}`);
  for (const l of onlyOff.slice(0, 20)) console.log(`  - ${l}`);
  for (const l of onlyOn.slice(0, 20)) console.log(`  + ${l}`);
  if (show) console.log("\n===== off =====\n" + off.text + "\n===== on =====\n" + on.text);
  process.exit(0);
})();
