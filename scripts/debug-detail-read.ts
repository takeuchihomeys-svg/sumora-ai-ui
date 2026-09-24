// 元付資料の読み取り（readPropertyImageDetail）が空になる理由を見る（読み取りのみ）
import { createClient } from "@supabase/supabase-js";
import { readPropertyImageDetail } from "../app/lib/property-image-read";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const { data } = await sb.from("property_pickups").select("id, property_name, agent_image_url").eq("conversation_id", "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7").order("rank");
  for (const r of (data ?? []) as Array<{ id: number; property_name: string; agent_image_url: string | null }>) {
    if (!r.agent_image_url) continue;
    const head = await fetch(r.agent_image_url, { method: "HEAD" });
    const t = Date.now();
    const d = await readPropertyImageDetail(r.agent_image_url, { timeoutMs: 90_000 });
    console.log(`${r.property_name} size=${head.headers.get("content-length")} ${Date.now() - t}ms kind=${d.kind} lines=${d.lines.length} usage=${JSON.stringify(d.usage)} raw=${d.raw.slice(0, 300)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
