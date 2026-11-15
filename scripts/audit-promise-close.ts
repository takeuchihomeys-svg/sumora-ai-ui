// scripts/audit-promise-close.ts — 約束の完了の側を本番の記録で数える（読むだけ・LLM なし・費用0）
//
// 2026-11-15 作業員L。sent_facts（行動台帳）の約束と果たした通・aix_action_items の閉じ方・line_tasks の結果を数える。
//   重い読みではない（30日の sent_facts の約束と済みの行だけ・数千行）が、営業時間は --days を短く。
// 実行: npx tsx --env-file=.env.local scripts/audit-promise-close.ts [--days=30] [--write]（--write で cron_run_logs に cron_name=promise-close の1行）
import { createClient } from "@supabase/supabase-js";
import { promiseCloseTally, promiseCloseLine, PROMISE_TO_DONE, type FactLite } from "./lib/promise-close";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "30")) || 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const kinds = [...Object.keys(PROMISE_TO_DONE), ...Object.values(PROMISE_TO_DONE)];
  const facts: FactLite[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("sent_facts").select("conversation_id, kind, status, sent_at").in("kind", kinds).gte("sent_at", since).order("sent_at").range(from, from + 999);
    if (error) throw new Error(error.message);
    facts.push(...((data ?? []) as FactLite[]));
    if (!data || data.length < 1000) break;
  }
  const rows = promiseCloseTally(facts, Date.now());
  console.log(promiseCloseLine(rows));
  for (const r of rows) console.log(`  ${r.kind}: 約束 ${r.n}・果たした ${r.done}（中央 ${r.medianH ?? "-"}時間・24時間以内 ${r.within24h}）・開いたまま ${r.open}（2日超 ${r.openOver2d}）・重ねた ${r.redo2d}`);
  const ai = await sb.from("aix_action_items").select("status, done_matched").gte("created_at", since).limit(5000);
  const items = (ai.data ?? []) as Array<{ status: string; done_matched: boolean | null }>;
  const lt = await sb.from("line_tasks").select("status, result").gte("created_at", since).limit(5000);
  const tasks = (lt.data ?? []) as Array<{ status: string; result: unknown }>;
  const closeLine = `AIX要対応の閉じ方: 済み ${items.filter((x) => x.status === "done").length}（押した AIX が勧めと同じ ${items.filter((x) => x.status === "done" && x.done_matched === true).length}・違う ${items.filter((x) => x.status === "done" && x.done_matched === false).length}・返信などで閉じた ${items.filter((x) => x.status === "done" && x.done_matched == null).length}）・外した ${items.filter((x) => x.status === "dismissed").length}・待ち ${items.filter((x) => x.status === "pending").length}｜タスク: 済み ${tasks.filter((x) => x.status === "completed").length}（結果あり ${tasks.filter((x) => x.status === "completed" && x.result != null).length}）・取消 ${tasks.filter((x) => x.status === "cancelled").length}・待ち ${tasks.filter((x) => x.status === "pending").length}`;
  console.log(closeLine);
  if (process.argv.includes("--write")) {
    const { error } = await sb.from("cron_run_logs").insert({ cron_name: "promise-close", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), ok: true, result_json: { summary: promiseCloseLine(rows), close: closeLine, rows } });
    console.log(error ? `書けなかった: ${error.message}` : "cron_run_logs に1行");
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
