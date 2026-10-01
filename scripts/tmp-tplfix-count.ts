import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
(async () => {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id,created_at,text").eq("sender", "staff").gte("created_at", "2026-06-01").ilike("text", "%お気に召さ%").range(from, from + 999);
    if (error) throw error;
    rows.push(...data!); if (data!.length < 1000) break;
  }
  const r = rows.filter(m => m.conversation_id !== YUMA);
  console.log("total staff msgs with お気に召さ since 6/1:", r.length);
  const tally = new Map<string, number>();
  for (const m of r) {
    const mm = (m.text as string).match(/お気に召さ[^、。！!\n]{0,40}/g) ?? [];
    for (const s of mm) { const k = s.slice(0, 30); tally.set(k, (tally.get(k) ?? 0) + 1); }
  }
  [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, v]) => console.log(v, k));
  const since = r.filter(m => m.created_at >= "2026-09-01");
  const c = (re: RegExp) => since.filter(m => re.test(m.text)).length;
  console.log("since 9/1: broken", c(/お気に召されたお部屋ご都合よろしい/), "ましたらご都合", c(/お気に召されましたらご都合よろしい/), "さましたら", c(/お気に召さましたら/));
  // continuation after ましたらご都合よろしいお日にちに
  const t2 = new Map<string, number>();
  for (const m of r) for (const s of (m.text as string).match(/お気に召されましたらご都合よろしいお日にちに[^\n]{0,25}/g) ?? []) t2.set(s.slice(22), (t2.get(s.slice(22)) ?? 0) + 1);
  [...t2.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => console.log("  cont", v, k));
})();
