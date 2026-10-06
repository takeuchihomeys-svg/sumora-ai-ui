// scripts/audit-greeting-continuation.ts
// 2026-10-06 ⑫ 竹内さん（朱莉 10/03）「お世話になっておりますと出てしまっている（挨拶入れるのは1日最初のLINE 続けての会話のところに急に挨拶等入れない）」:
//   お客様の発言がこちらの発言と同じ日（JST）に続けて来た（会話の続き）のに、こちらの返事が翌日以降になった番で、スタッフの返事に「お世話になっております」を入れたか。
//   比べ: お客様の発言がこちらの前の発言と別の日（会話が途切れた後）の番。読むだけ・LLM なし
// 実行: npx tsx --env-file=.env.local scripts/audit-greeting-continuation.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=180").slice(7));
const jstDay = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);
const GREET = /お世話になっております/;
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const cells: Record<string, { n: number; greet: number }> = {};
  for (let f = 0; f < 80_000; f += 1000) {
    const { data } = await sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("conversation_id").order("created_at").range(f, f + 999);
    const rows = data ?? [];
    for (let i = 1; i < rows.length - 1; i++) {
      const c = rows[i], r = rows[i + 1];
      if (c.sender !== "customer" || r.sender === "customer" || r.is_aix_generated || c.conversation_id !== r.conversation_id) continue;
      // お客様の連投の頭の前のこちらの発言
      let k = i; while (k > 0 && rows[k - 1].sender === "customer" && rows[k - 1].conversation_id === c.conversation_id) k--;
      const prevStaff = rows[k - 1];
      if (!prevStaff || prevStaff.conversation_id !== c.conversation_id || prevStaff.sender === "customer") continue;
      const contSameDay = jstDay(prevStaff.created_at) === jstDay(rows[k].created_at);
      const replyNextDay = jstDay(r.created_at) !== jstDay(c.created_at);
      const key = `${contSameDay ? "お客様の発言はこちらの発言と同じ日（続き）" : "お客様の発言は別の日"}×${replyNextDay ? "返事は翌日以降" : "返事は同じ日"}`;
      const cell = (cells[key] ??= { n: 0, greet: 0 }); cell.n++; if (GREET.test(String(r.text ?? "").slice(0, 40))) cell.greet++;
    }
    if (rows.length < 1000) break;
  }
  for (const [k, c] of Object.entries(cells).sort()) console.log(`${k}: ${c.n}番 → お世話になっております ${c.greet}（${Math.round((c.greet / c.n) * 100)}%）`);
})();
