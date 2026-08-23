import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

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

  const rawApiKey = process.env.OPENAI_API_KEY ?? "";
  const apiKey = rawApiKey.charCodeAt(0) === 0xFEFF ? rawApiKey.slice(1) : rawApiKey;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "OPENAI_API_KEY not set" }, { status: 500 });
  }

  let processed = 0;
  let failed = 0;
  let lastError: string | null = null;

  for (const row of typedRows) {
    const embedText = [row.situation, row.pattern].filter(Boolean).join(" / ");
    let embedding: number[] | null = null;

    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "text-embedding-3-small", input: embedText }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const errText = await res.text();
        lastError = `OpenAI ${res.status}: ${errText.slice(0, 200)}`;
        failed++;
        continue;
      }
      const data = await res.json() as { data: Array<{ embedding: number[] }> };
      embedding = data.data[0]?.embedding ?? null;
    } catch (e) {
      lastError = `fetch error: ${e instanceof Error ? e.message : String(e)}`;
      failed++;
      continue;
    }

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
