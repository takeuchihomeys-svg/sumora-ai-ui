// YUMA の直近のピックアップ送信: sent_properties（pickup_id・image_url）と messages の画像の並び（読むだけ）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const CONV = process.argv[2] ?? "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
async function main() {
  const { data: sp } = await sb.from("sent_properties").select("*").eq("conversation_id", CONV).order("sent_at", { ascending: false }).limit(8);
  console.log(Object.keys(sp?.[0] ?? {}));
  for (const r of sp ?? []) console.log(r.sent_at, r.channel, r.pickup_id, r.property_name, String(r.image_url ?? "").slice(-50));
  const { data: m } = await sb.from("messages").select("*").eq("conversation_id", CONV).order("created_at", { ascending: false }).limit(12);
  console.log(Object.keys(m?.[0] ?? {}));
  for (const r of m ?? []) console.log(r.created_at, r.sender, String(r.text ?? "").slice(0, 30).replace(/\n/g, " "), String(r.image_url ?? r.media_url ?? "").slice(-50));
}
main();
