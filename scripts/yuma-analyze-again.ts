// YUMA のピックアップを「🔍 画像で分析」だけ読み直す（本番と同じ関数・DeepSeek）
import { createClient } from "@supabase/supabase-js";
import { analyzePickupImage, buildWantsText, pickBest } from "../app/lib/pickup-image-analysis";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
async function main() {
  const { data } = await sb.from("property_pickups").select("id, rank, property_name, trim_image_url").eq("conversation_id", YUMA).like("batch_id", "YUMA_%").order("rank");
  const wants = buildWantsText(null, "水回りはバス・トイレ別と独立洗面台が良い／キッチンは対面が良い／リビングと寝室（洋室）は離れている方が良い／ウォークインクローゼットが欲しい");
  const rows = await Promise.all(((data ?? []) as Array<{ id: number; rank: number; property_name: string; trim_image_url: string }>).map(async (r) => {
    const out = await analyzePickupImage(r.trim_image_url, wants);
    if (out.analysis) await sb.from("property_pickups").update({ image_analysis: { ...out.analysis, wants, analyzed_at: new Date().toISOString() } }).eq("id", r.id);
    const a = out.analysis;
    console.log(`【${r.rank}】${r.property_name} ${a ? `${a.match}点\n    🍳 ${a.kitchen}\n    🧥 ${a.storage}\n    △ ${a.concern.join("／")}` : "読めなかった"}`);
    return { id: r.id, rank: r.rank, property_name: r.property_name, analysis: a };
  }));
  const best = pickBest(rows);
  console.log(`👑 ${best ? `【${best.rank}】${best.property_name}` : "-"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
