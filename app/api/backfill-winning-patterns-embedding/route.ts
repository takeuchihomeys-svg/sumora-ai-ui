import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { generateEmbedding } from "@/app/lib/knowledge-utils";

export const maxDuration = 300;

// POST /api/backfill-winning-patterns-embedding
// winning_patterns の embedding なし行に embedding を生成して保存。
// embed テキスト: situation + " / " + pattern（analyze-closed-conversation と同じ形式）
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const auth = req.headers.get("authorization");
  const validCron = cronSecret && auth === `Bearer ${cronSecret}`;
  const validInternal = internalSecret && auth === `Bearer ${internalSecret}`;
  if (!validCron && !validInternal) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "300"), 300);
  const offset = parseInt(searchParams.get("offset") ?? "0");

  const { data: rows, error } = await supabase
    .from("winning_patterns")
    .select("id, situation, pattern")
    .is("embedding", null)
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!rows || rows.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, done: true });
  }

  type WpRow = { id: string; situation: string | null; pattern: string };
  const typedRows = rows as WpRow[];

  let processed = 0;
  let failed = 0;
  let lastError: string | null = null;

  for (const row of typedRows) {
    const embedText = [row.situation, row.pattern].filter(Boolean).join(" / ");
    const embedding = await generateEmbedding(embedText);

    if (!embedding) {
      lastError = `no embedding for id=${row.id}`;
      failed++;
      continue;
    }

    const { error: updateErr } = await supabase
      .from("winning_patterns")
      .update({ embedding: JSON.stringify(embedding) })
      .eq("id", row.id);

    if (updateErr) {
      lastError = `update error: ${updateErr.message}`;
      failed++;
    } else {
      processed++;
    }
  }

  const done = rows.length < limit;
  return NextResponse.json({ ok: true, processed, failed, offset, limit, done, lastError });
}
