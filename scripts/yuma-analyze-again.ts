// YUMA のピックアップを「🔍 画像で分析」だけ読み直す（本番と同じ関数・DeepSeek）
import { createClient } from "@supabase/supabase-js";
// 2026-09-24 画像で分析を作り直した（型の前置き・間取り図の切り出し・物件ごとの保存）→ 本番と同じ analyzePickupRow を使う
import { pickBest } from "../app/lib/pickup-image-analysis";
import { analyzePickupRow } from "../app/lib/pickup-analyze-server";
import { extractImageWants } from "../app/lib/image-wants";
import type { SheetSourceRow } from "../app/lib/sheet-read-server";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
async function main() {
  const { data } = await sb.from("property_pickups").select("id, rank, site, property_name, conversation_id, summary_text, pdf_url, pdf_blob_url, pdf_text, pdf_has_text, trim_image_url, page_image_url, image_analysis").eq("conversation_id", YUMA).like("batch_id", "YUMA_%").order("rank");
  const wants = extractImageWants({ staffNote: "水回りはバス・トイレ別と独立洗面台が良い／キッチンは対面が良い／リビングと寝室（洋室）は離れている方が良い／ウォークインクローゼットが欲しい" });
  const rows = await Promise.all(((data ?? []) as Array<SheetSourceRow & { rank: number; property_name: string; conversation_id: string | null }>).map(async (r) => {
    const out = await analyzePickupRow(r, wants);
    if (out.analysis) await sb.from("property_pickups").update({ image_analysis: { ...out.analysis, wants, analyzed_at: new Date().toISOString() } }).eq("id", r.id);
    const a = out.analysis;
    console.log(`【${r.rank}】${r.property_name} ${a ? `${a.match}点\n    🍳 ${a.kitchen}\n    🧥 ${a.storage}\n    △ ${a.concern.join("／")}` : "読めなかった"}`);
    return { id: r.id, rank: r.rank, property_name: r.property_name, analysis: a };
  }));
  const best = pickBest(rows);
  console.log(`👑 ${best ? `【${best.rank}】${best.property_name}` : "-"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
