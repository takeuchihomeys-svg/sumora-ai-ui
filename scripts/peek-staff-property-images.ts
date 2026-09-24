// スタッフがお客様に送った画像（物件資料のトリミング形を確かめる用）の URL を出す（読み取りのみ・本文・名前は出さない）
// 実行: npx tsx --env-file=.env.local scripts/peek-staff-property-images.ts [--days=14] [--limit=12]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const days = Number(arg("days") ?? "14");
const limit = Number(arg("limit") ?? "12");
async function main() {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data, error } = await sb.from("messages").select("id, conversation_id, created_at, sender, image_url, image_type, is_aix_generated, text")
    .eq("sender", "staff").not("image_url", "is", null).gte("created_at", since).order("created_at", { ascending: false }).limit(200);
  if (error) { console.log(error.message); return; }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const types = new Map<string, number>();
  for (const r of rows) types.set(String(r.image_type ?? "-"), (types.get(String(r.image_type ?? "-")) ?? 0) + 1);
  console.log(`${days}日でスタッフの画像 ${rows.length}件・種類: ${[...types.entries()].map(([k, v]) => `${k}×${v}`).join(" ")}`);
  const picked = rows.filter((r) => !/estimate|見積|map|地図|id|本人/i.test(String(r.image_type ?? ""))).slice(0, limit);
  for (const r of picked) console.log(`${String(r.created_at).slice(0, 16)} type=${r.image_type ?? "-"} aix=${r.is_aix_generated ?? "-"} conv=${String(r.conversation_id).slice(0, 8)} text=${String(r.text ?? "").replace(/\n/g, " ").slice(0, 40)}\n  ${r.image_url}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
