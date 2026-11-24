// scripts/list-done-at-backfill.ts — #668: done_at の無い済みの【必ず】の行に入れる時刻の一覧（読むだけ・書かない・LLM なし）
// 2026-11-23 作業員L（統括役の決まり「DB の一回きりの書き込みは、全部の行の id を一覧にしてから書く」）。
//   時刻は staff-todo-list.promiseDoneAt（行を作った後の履行の送信のうち、カレンダーを閉じる判定が閉じる最初の送信の時刻）。
//   読めない行（閉じた送信が見つからない＝スタッフの手・自動の置き換え 等）は null のまま入れない。DB を読むので 22時〜8時に流す。
// 実行: npx tsx --env-file=.env.local scripts/list-done-at-backfill.ts [--days=60] --out=<json>
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { promiseDoneAt, type TodoPromiseRow, type TodoFactRow } from "../app/lib/staff-todo-list";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const days = Number(arg("days", "60")) || 60;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows: TodoPromiseRow[] = [];
  for (let a = 0; ; a += 1000) {
    const { data, error } = await sb.from("calendar_events").select("id, conversation_id, customer_name, event_type, start_at, created_at, notes, is_done")
      .eq("is_done", true).is("done_at", null).like("notes", "【必ず】%").gte("created_at", since).order("id").range(a, a + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as TodoPromiseRow[]));
    if (!data || data.length < 1000) break;
  }
  const convs = [...new Set(rows.map((r) => r.conversation_id).filter((c): c is string => !!c))];
  const facts: TodoFactRow[] = [];
  for (let i = 0; i < convs.length; i += 50) {
    const { data, error } = await sb.from("sent_facts").select("conversation_id, kind, sent_at, detail").in("conversation_id", convs.slice(i, i + 50)).eq("status", "done").gte("sent_at", since).order("sent_at").limit(5000);
    if (error) throw new Error(error.message);
    facts.push(...((data ?? []) as TodoFactRow[]));
  }
  const list = rows.map((r) => ({ id: r.id, conv: String(r.conversation_id ?? "").slice(0, 8), created_at: r.created_at, done_at: promiseDoneAt(r, facts) }));
  const found = list.filter((x) => x.done_at);
  const summary = { days, rows: list.length, withTime: found.length, noTime: list.length - found.length, beforeCreated: found.filter((x) => Date.parse(x.done_at!) < Date.parse(x.created_at)).length };
  console.log(JSON.stringify(summary));
  const o = arg("out");
  if (o) writeFileSync(o, JSON.stringify({ ...summary, list }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
