// scripts/audit-progress-push-watch.ts — 見張りの番で下書きが「遅くなり申し訳」で始めた番を、PROGRESS_PUSH_NARROW の前後とスタッフの文で並べる（読むだけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-progress-push-watch.ts [--days=45]
import { createClient } from "@supabase/supabase-js";
import { isProgressPushMessage } from "../app/lib/greeting";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "45");
(async () => {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, customer_last_at, draft_first, draft_last, staff_texts")
    .gte("customer_turn_at", since).or("draft_first.ilike.%遅くなり申し訳%,draft_last.ilike.%遅くなり申し訳%").order("id").limit(1000);
  if (error) throw new Error(error.message);
  let off = 0, on = 0, staffApol = 0, removedApol = 0;
  for (const t of (data ?? []) as Array<{ id: number; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; draft_first: string | null; draft_last: string | null; staff_texts: unknown }>) {
    const { data: ms } = await sb.from("messages").select("text").eq("conversation_id", t.conversation_id).eq("sender", "customer").gte("created_at", t.customer_turn_at).lte("created_at", t.customer_last_at ?? t.customer_turn_at).order("created_at");
    const cust = ((ms ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").join("\n");
    const a = isProgressPushMessage(cust); process.env.PROGRESS_PUSH_NARROW = "on"; const b = isProgressPushMessage(cust); delete process.env.PROGRESS_PUSH_NARROW;
    const staff = (Array.isArray(t.staff_texts) ? (t.staff_texts as unknown[]).map((x) => (x && typeof x === "object" ? String((x as { text?: unknown }).text ?? "") : String(x))).join(" ") : String(t.staff_texts ?? "")).slice(0, 80);
    const ap = /遅くなり|遅れ|お待たせ/.test(staff.slice(0, 60));
    if (a) off++; if (b) on++; if (ap) staffApol++; if (a && !b && ap) removedApol++;
    console.log(`${t.id} 判定 ${a ? "催促" : "－"}→${b ? "催促" : "－"} ${ap ? "★スタッフ謝り" : "　"} 客「${cust.replace(/\s+/g, " ").slice(0, 60)}」 スタッフ「${staff.replace(/\s+/g, " ").slice(0, 40)}」`);
  }
  console.log(`\n番 ${(data ?? []).length}・催促の判定 off ${off} → on ${on}・スタッフが謝った ${staffApol}・on で外れたのにスタッフが謝った ${removedApol}`);
  process.exit(0);
})();
