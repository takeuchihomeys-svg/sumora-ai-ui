import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
(async () => {
  const { data, error } = await sb.from("templates").select("id,category,label,text,structure,second_msg_type,use_count,last_used_at").limit(1000);
  if (error) throw error;
  console.log("rows", data!.length, "cols", Object.keys(data![0]).join(","));
  const bodyKey = Object.keys(data![0]).find(k => /content|body|text/.test(k))!;
  console.log("bodyKey", bodyKey);
  for (const r of data!) {
    const s = JSON.stringify(r);
    if (/お気に召されたお部屋ご都合よろしい|タクヤ|98,500|新着|特にオススメ|複数|百舌/.test(s)) {
      console.log("=====", r.id, JSON.stringify(r.label), "| cat", r.category);
      for (const [k,v] of Object.entries(r)) if (typeof v === "string" && v.length > 40) console.log(`[${k}]\n${v}`);
    }
  }
})();
