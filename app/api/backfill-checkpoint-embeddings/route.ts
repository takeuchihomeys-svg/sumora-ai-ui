import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 300;

const BATCH_SIZE = 20;

async function getEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Authorization": "Bearer " + apiKey.replace(/\s/g, ""),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 2000) }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data?: Array<{ embedding?: number[] }> };
    return data.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  const { count, error } = await supabase
    .from("conversation_checkpoints")
    .select("id", { count: "exact", head: true })
    .is("embedding", null)
    .not("summary", "is", null);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ needs_embedding: count ?? 0 });
}

export async function POST(req: NextRequest) {
  try {
    // offset パラメータで続きから処理できる
    const body = await req.json().catch(() => ({})) as { offset?: number };
    const offset = typeof body.offset === "number" ? body.offset : 0;

    // embedding IS NULL のCPをBATCH_SIZE件取得
    const { data: cps, error } = await supabase
      .from("conversation_checkpoints")
      .select("id, conversation_id, checkpoint_index, summary")
      .is("embedding", null)
      .not("summary", "is", null)
      .order("checkpoint_index", { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!cps || cps.length === 0) {
      return NextResponse.json({ done: true, processed: 0, message: "全CP処理完了" });
    }

    let succeeded = 0;
    let failed = 0;

    for (const cp of cps) {
      if (!cp.summary) { failed++; continue; }
      const embedding = await getEmbedding(cp.summary as string);
      if (!embedding) { failed++; continue; }
      const { error: updateErr } = await supabase
        .from("conversation_checkpoints")
        .update({ embedding })
        .eq("id", cp.id);
      if (updateErr) { failed++; } else { succeeded++; }
      // レートリミット対策: 50ms待機
      await new Promise(r => setTimeout(r, 50));
    }

    // まだ残りがあるか確認
    const { count: remaining } = await supabase
      .from("conversation_checkpoints")
      .select("id", { count: "exact", head: true })
      .is("embedding", null)
      .not("summary", "is", null);

    return NextResponse.json({
      done: (remaining ?? 0) === 0,
      processed: cps.length,
      succeeded,
      failed,
      remaining: remaining ?? 0,
      next_offset: offset + cps.length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 }
    );
  }
}
