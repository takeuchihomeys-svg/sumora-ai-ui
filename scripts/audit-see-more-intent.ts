import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const RE = /(?:もう少し|もっと|他(?:に|の)?も|ほか(?:に|の)?も|色々|いろいろ|たくさん)[^\n。]{0,8}見(?:てみ)?たい/;
(async () => {
  const since = new Date(Date.now() - 365 * 86400_000).toISOString();
  const rows: any[] = [];
  for (const kw of ["%見てみたい%", "%見たい%"]) {
    for (let p = 0; p < 10; p++) {
      const { data } = await sb.from("messages").select("id, conversation_id, text, created_at").eq("sender", "customer").ilike("text", kw).gte("created_at", since).range(p * 1000, p * 1000 + 999);
      rows.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
    }
  }
  const hits = [...new Map(rows.filter((r) => RE.test(r.text ?? "")).map((r) => [r.id, r])).values()];
  console.log("該当", hits.length);
  for (const h of hits) {
    const { data: nx } = await sb.from("messages").select("text").eq("conversation_id", h.conversation_id).eq("sender", "staff").gt("created_at", h.created_at).order("created_at").limit(2);
    console.log("客:", (h.text as string).replace(/\s+/g, " ").slice(0, 90), "\n  → 実送信:", (nx ?? []).map((x: any) => (x.text ?? "").replace(/\s+/g, " ").slice(0, 80)).join(" ／ "));
  }
})();