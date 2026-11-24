// scripts/audit-todo-stale-promises.ts — やることリストが期日から14営業日を過ぎて外している約束（promise_stale）の数と分け（台帳 #667・作業員L・2026-11-24・読むだけ）
//   やることリストと同じ材料（loadStaffTodoInput＝毎時の cron と同じ読み）で、promise_stale に落ちる【必ず】の行を出し、
//   閉じ忘れ（約束の後にお客様へ物件を送った記録がある＝sent_properties・グループへの共有と確認の結果の AIX は除く／見積・確認の結果の送付の記録）と
//   本当に未履行に分ける。出すのは数・会話の頭8字・約束の種類・開いている日数だけ（お客様の名前・本文は出さない）
// 実行: npx tsx --env-file=.env.local scripts/audit-todo-stale-promises.ts [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { loadStaffTodoInput } from "../app/lib/staff-todo-list-server";
import { buildStaffTodoList, stalePromisesOf } from "../app/lib/staff-todo-list";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const at = Date.now();
  const input = await loadStaffTodoInput(sb, at);
  const list = buildStaffTodoList(input);
  const stale = stalePromisesOf(input);
  const convs = [...new Set(stale.map((s) => s.conversationId))];
  const sent = new Map<string, string[]>();
  for (let i = 0; i < convs.length; i += 50) {
    const { data } = await sb.from("sent_properties").select("conversation_id, sent_at, source, delivery").in("conversation_id", convs.slice(i, i + 50)).limit(5000);
    for (const r of (data ?? []) as Array<{ conversation_id: string; sent_at: string; source: string | null; delivery: string | null }>) {
      if (r.source === "line_group" || r.delivery === "group" || r.source === "aix:property_check_result") continue;
      sent.set(r.conversation_id, [...(sent.get(r.conversation_id) ?? []), r.sent_at]);
    }
  }
  const rows = stale.map((s) => {
    const after = (sent.get(s.conversationId) ?? []).filter((x) => Date.parse(x) > Date.parse(s.createdAt)).sort();
    const closeForgotten = s.eventType === "property_send" && after.length > 0;
    return { conv: s.conversationId.slice(0, 8), id: s.id, kind: s.kindLabel, openDays: s.openDays, closeForgotten, firstSendAfterDays: after.length ? Math.round((Date.parse(after[0]) - Date.parse(s.createdAt)) / 86_400_000) : null };
  });
  const out = { at: new Date(at).toISOString(), listItems: list.customers.reduce((a, c) => a + c.items.length, 0), skippedStale: list.skipped.promise_stale ?? 0, stale: rows.length, closeForgotten: rows.filter((r) => r.closeForgotten).length, reallyOpen: rows.filter((r) => !r.closeForgotten).length, rows };
  console.log(JSON.stringify({ ...out, rows: rows.slice(0, 40) }, null, 1));
  const o = arg("out"); if (o) writeFileSync(o, JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
