import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const RE = /お気に召されたお部屋ご都合よろしい|お気に召さましたら/;
(async () => {
  for (const [t, cols] of [["templates", "id,label,text"], ["ai_template_candidates", "*"], ["aix_brain_templates", "*"]] as const) {
    const all: any[] = [];
    for (let f = 0; ; f += 1000) { const { data, error } = await sb.from(t).select(cols).range(f, f + 999); if (error) { console.log(t, "ERR", error.message); break; } all.push(...data!); if (data!.length < 1000) break; }
    const hits = all.filter(r => RE.test(JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => k !== "embedding")))));
    console.log(t, "rows", all.length, "broken", hits.length);
    for (const h of hits.slice(0, 8)) console.log("  ", h.id, h.label ?? h.status ?? "", JSON.stringify(Object.fromEntries(Object.entries(h).filter(([k]) => !/embedding/.test(k)))).slice(0, 300));
  }
})();
(async () => {
  const all: any[] = [];
  for (let f = 0; ; f += 1000) { const { data } = await sb.from("ai_template_candidates").select("template_text,is_adopted,is_dismissed,source").range(f, f + 999); all.push(...data!); if (data!.length < 1000) break; }
  const h = all.filter(r => RE.test(r.template_text ?? ""));
  console.log("PENDING broken", h.filter(r => !r.is_adopted && !r.is_dismissed).length, "adopted", h.filter(r => r.is_adopted).length);
})();
