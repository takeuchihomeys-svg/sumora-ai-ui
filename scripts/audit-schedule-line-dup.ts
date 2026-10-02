// scripts/audit-schedule-line-dup.ts
// 2026-10-02 ⑫: 同じ日時の行の2回目を落とす出口（app/lib/schedule-line-dedupe.ts）を本番のスタッフの送信（手打ち・AIX）に当て、変わる通を目で読む。読むだけ・LLM なし。
// 実行: npx tsx --env-file=.env.local scripts/audit-schedule-line-dup.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
import { dedupeScheduleLines } from "../app/lib/schedule-line-dedupe";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=180").slice(7));
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  let n = 0, hit = 0;
  for (let f = 0; f < 600_000; f += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, text, is_aix_generated").eq("sender", "staff").gte("created_at", since).range(f, f + 999);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ conversation_id: string; text: string | null; is_aix_generated: boolean | null }>) {
      const t = r.text ?? ""; if (!t.trim()) continue; n++;
      const d = dedupeScheduleLines(t);
      if (d.removed.length) { hit++; console.log(`${r.conversation_id.slice(0, 8)} ${r.is_aix_generated ? "AIX" : "手"} 落とす行: ${d.removed.join(" | ").slice(0, 80)}｜全文: ${t.replace(/\n/g, " / ").slice(0, 120)}`); }
    }
    if ((data ?? []).length < 1000) break;
  }
  console.log(`\nスタッフの送信 ${n}・変わる通 ${hit}`);
})();
