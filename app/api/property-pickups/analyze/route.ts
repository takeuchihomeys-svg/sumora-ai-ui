// POST /api/property-pickups/analyze  { item_ids: number[], note?: string }
// 「🔍 画像で分析」: 選んだ物件の資料から事実（文字層＋切り出した間取り図）を用意し、お客様の希望に照らして
//   水回り・キッチン・リビングと洋室の位置関係・収納を判断 → property_pickups.image_analysis に残し、一番合う物件を返す。
// 2026-09-24 竹内「画像で分析ボタンを付ける。トリミングした画像の中で一番条件に合った物件がわかる」
// 2026-09-24 作り直し（竹内「2つの型でプロンプトキャッシュ」「必要な所だけ切り出す・表の文字は文字層」「物件と一致しているか・食い違いは要確認」
//   「物件ごとに保存し、2回目以降は画像を読み直さない」）:
//   1件分は pickup-analyze-server.analyzePickupRow（事実: 保存 → 同じ部屋 → 同じ図 → 読む の順／照合と点: 純関数）
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { pickBest } from "@/app/lib/pickup-image-analysis";
import { loadImageWants } from "@/app/lib/image-wants-server";
import { analyzePickupRow } from "@/app/lib/pickup-analyze-server";
import type { SheetSourceRow } from "@/app/lib/sheet-read-server";

// 2026-09-24 反証: 1件で PDF 取得 15秒＋描画＋読み 40秒＋読み直し 90秒＋文字の照合 30秒 = 最大 約180秒 → 120 では途中で切られ何も保存されない
export const maxDuration = 300;
const MAX_ITEMS = 10;

type Row = SheetSourceRow & { rank: number; property_name: string; property_customer_id: string | null; conversation_id: string | null };

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const body = await req.json().catch(() => ({})) as { item_ids?: number[]; note?: string };
  const ids = Array.isArray(body.item_ids) ? body.item_ids.filter((n) => Number.isFinite(n)).slice(0, MAX_ITEMS) : [];
  if (ids.length === 0) return NextResponse.json({ ok: false, error: "item_ids が要ります" }, { status: 400 });

  const { data, error } = await supabase.from("property_pickups")
    .select("id, rank, site, property_name, property_customer_id, conversation_id, summary_text, pdf_url, pdf_blob_url, pdf_text, pdf_has_text, trim_image_url, page_image_url, image_analysis").in("id", ids);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const rows = (data ?? []) as Row[];

  // お客様の希望: 条件欄・会話（120日）・物件オススメの訴求点から「画像で確かめられる物」だけ（名前・電話は伏せる）
  const conversationId = rows.find((r) => r.conversation_id)?.conversation_id ?? null;
  const wants = await loadImageWants({
    conversationId,
    propertyCustomerId: rows.find((r) => r.property_customer_id)?.property_customer_id ?? null,
    staffNote: body.note ?? null,
  });

  const startedAt = Date.now();
  const results = await Promise.all(rows.map(async (r) => {
    const out = await analyzePickupRow(r, wants, { conversationId });
    if (out.analysis) {
      const { error: uErr } = await supabase.from("property_pickups").update({ image_analysis: { ...out.analysis, wants, analyzed_at: new Date().toISOString() } }).eq("id", r.id);
      if (uErr) console.warn("[pickups/analyze] 保存できない:", uErr.message);
    }
    return { id: r.id, rank: r.rank, property_name: r.property_name, analysis: out.analysis, error: out.error ?? undefined, source: out.facts.source, usage: out.usage };
  }));
  const best = pickBest(results);
  const usage = results.flatMap((x) => x.usage);
  console.log(JSON.stringify({
    tag: "property-pickups:analyze", items: rows.length, ok: results.filter((x) => x.analysis).length, ms: Date.now() - startedAt, best: best?.id ?? null,
    wants: wants.length, fromChat: wants.filter((w) => w.source === "会話").length, fromAppeal: wants.filter((w) => w.source === "訴求").length,
    sources: results.map((x) => x.source), review: results.map((x) => x.analysis?.review?.status ?? null),
    calls: usage.length, input: usage.reduce((a, u) => a + u.input, 0), cacheHit: usage.reduce((a, u) => a + u.cacheHit, 0), output: usage.reduce((a, u) => a + u.output, 0),
  }));
  return NextResponse.json({
    ok: results.some((x) => x.analysis),
    items: results.map((x) => ({ id: x.id, rank: x.rank, property_name: x.property_name, analysis: x.analysis, error: x.error, source: x.source })),
    best_id: best?.id ?? null, wants,
  });
}
