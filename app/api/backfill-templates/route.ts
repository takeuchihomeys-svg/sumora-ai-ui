import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { generateEmbedding } from "@/app/lib/knowledge-utils";

export const maxDuration = 300;

// POST /api/backfill-templates
// templates テーブルの全レコードに embedding を生成して保存する。
// embedding テキスト: category + " " + label（どのシーンのテンプレかをベクトル化）
// 151件程度のため1回で全件処理可能。offset/limit で分割も可。
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
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "200"), 200);
  const offset = parseInt(searchParams.get("offset") ?? "0");
  const overwrite = searchParams.get("overwrite") === "true";

  // embedding が未設定のレコードのみ対象（overwrite=true の場合は全件）
  let query = supabase
    .from("templates")
    .select("id, category, label")
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);

  if (!overwrite) {
    query = query.is("embedding", null);
  }

  const { data: rows, error } = await query;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!rows || rows.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, done: true });
  }

  type TemplateRow = { id: string; category: string; label: string };
  const typedRows = rows as TemplateRow[];

  let processed = 0;
  let failed = 0;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "OPENAI_API_KEY not set", processed: 0, failed: 0 }, { status: 500 });
  }

  let lastError: string | null = null;

  for (const row of typedRows) {
    // category + label をベクトル化: 「物件確認した【AIX】 空きの確認ができました！」形式
    const embedText = `${row.category} ${row.label}`.trim();
    let embedding: number[] | null = null;
    try {
      // generateEmbedding を使わず直接呼び出し（エラー詳細を取得するため）
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "text-embedding-3-small", input: embedText }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const errText = await res.text();
        lastError = `OpenAI ${res.status}: ${errText.slice(0, 200)}`;
        console.error("[backfill-templates] OpenAI error:", res.status, errText.slice(0, 200));
        failed++;
        continue;
      }
      const data = await res.json() as { data: Array<{ embedding: number[] }> };
      embedding = data.data[0]?.embedding ?? null;
    } catch (e) {
      lastError = `fetch error: ${e instanceof Error ? e.message : String(e)}`;
      console.error("[backfill-templates] fetch threw:", lastError);
      failed++;
      continue;
    }
    if (!embedding) {
      lastError = `no embedding in response for: ${embedText.slice(0, 50)}`;
      console.error("[backfill-templates] no embedding in response for:", embedText.slice(0, 50));
      failed++;
      continue;
    }

    const { error: updateErr } = await supabase
      .from("templates")
      .update({ embedding: JSON.stringify(embedding) })
      .eq("id", row.id);

    if (updateErr) {
      lastError = `update error: ${updateErr.message}`;
      console.error("[backfill-templates] update error:", updateErr.message);
      failed++;
    } else {
      processed++;
    }
  }

  const done = rows.length < limit;
  return NextResponse.json({ ok: true, processed, failed, offset, limit, done, lastError });
}
