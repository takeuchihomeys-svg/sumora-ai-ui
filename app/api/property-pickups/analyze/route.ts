// POST /api/property-pickups/analyze  { item_ids: number[], note?: string }
// 「🔍 画像で分析」: 選んだ物件の資料画像（お客様に送る1ページ目）を DeepSeek が読み、お客様の希望に照らして
//   水回り・キッチン・リビングと洋室の位置関係・収納を判断 → property_pickups.image_analysis に残し、一番合う物件を返す。
// 2026-09-24 竹内「画像で分析ボタンを付ける。トリミングした画像の中で一番条件に合った物件がわかる」
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { analyzePickupImage, pickBest, ANALYSIS_MAX_TOKENS } from "@/app/lib/pickup-image-analysis";
import { loadImageWants } from "@/app/lib/image-wants-server";

export const maxDuration = 120;
const MAX_ITEMS = 10;

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const body = await req.json().catch(() => ({})) as { item_ids?: number[]; note?: string };
  const ids = Array.isArray(body.item_ids) ? body.item_ids.filter((n) => Number.isFinite(n)).slice(0, MAX_ITEMS) : [];
  if (ids.length === 0) return NextResponse.json({ ok: false, error: "item_ids が要ります" }, { status: 400 });

  const { data, error } = await supabase.from("property_pickups")
    .select("id, rank, property_name, property_customer_id, conversation_id, trim_image_url, page_image_url").in("id", ids);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const rows = (data ?? []) as Array<{ id: number; rank: number; property_name: string; property_customer_id: string | null; conversation_id: string | null; trim_image_url: string | null; page_image_url: string | null }>;

  // お客様の希望: 条件欄・会話（120日）・物件オススメの訴求点から「画像で確かめられる物」だけ（名前・電話は伏せる）
  const wants = await loadImageWants({
    conversationId: rows.find((r) => r.conversation_id)?.conversation_id ?? null,
    propertyCustomerId: rows.find((r) => r.property_customer_id)?.property_customer_id ?? null,
    staffNote: body.note ?? null,
  });

  const startedAt = Date.now();
  const results = await Promise.all(rows.map(async (r) => {
    const url = r.trim_image_url ?? r.page_image_url;   // お客様に送る1ページ目だけ（元付の資料は読まない）
    if (!url) return { id: r.id, rank: r.rank, property_name: r.property_name, analysis: null, error: "画像が無い（先に ✂️ 画像トリミング）" };
    const t = Date.now();
    const out = await analyzePickupImage(url, wants);
    void import("@/app/lib/llm-usage-recorder").then(({ recordAltUsage }) => recordAltUsage({
      model: out.model ?? "deepseek-flash", action: "pickup_image_analysis", conversationId: null,
      usage: { input_tokens: Math.max(0, (out.usage?.input ?? 0) - (out.usage?.cacheHit ?? 0)), output_tokens: out.usage?.output ?? 0, cache_read_input_tokens: out.usage?.cacheHit ?? 0 },
      status: out.usage ? 200 : 0, errorType: out.analysis ? null : (out.usage ? "empty_or_unparsable" : "no_response"),
      durationMs: Date.now() - t, sysHead: "【🔍 画像で分析】", sysKeyFull: null, maxTokens: ANALYSIS_MAX_TOKENS,
    })).catch(() => {});
    if (out.analysis) {
      const { error: uErr } = await supabase.from("property_pickups").update({ image_analysis: { ...out.analysis, wants, analyzed_at: new Date().toISOString() } }).eq("id", r.id);
      if (uErr) console.warn("[pickups/analyze] 保存できない:", uErr.message);
    }
    return { id: r.id, rank: r.rank, property_name: r.property_name, analysis: out.analysis, error: out.analysis ? undefined : "読めなかった" };
  }));
  const best = pickBest(results);
  console.log(JSON.stringify({ tag: "property-pickups:analyze", items: rows.length, ok: results.filter((x) => x.analysis).length, ms: Date.now() - startedAt, best: best?.id ?? null, wants: wants.length, fromChat: wants.filter((w) => w.source === "会話").length, fromAppeal: wants.filter((w) => w.source === "訴求").length }));
  return NextResponse.json({ ok: results.some((x) => x.analysis), items: results, best_id: best?.id ?? null, wants });
}
