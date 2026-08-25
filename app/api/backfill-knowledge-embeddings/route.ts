import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { generateEmbedding } from "@/app/lib/knowledge-utils";

export const maxDuration = 300;

// POST: embeddingがない既存ナレッジルールに一括生成・保存（200件ずつ）
export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ ok: false, error: "OPENAI_API_KEY not set" }, { status: 500 });
  }

  const { data: rows, error } = await supabase
    .from("ai_reply_knowledge")
    .select("id, conversation_state, content")
    .is("embedding", null)
    .limit(200);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!rows || rows.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, message: "全件処理済みです" });
  }

  let success = 0;
  let failed = 0;

  const batchSize = 10;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (row) => {
        const input = `${row.conversation_state ?? "general"}: ${row.content}`;
        const embedding = await generateEmbedding(input);
        if (!embedding) { failed++; return; }
        const { error: updateError } = await supabase
          .from("ai_reply_knowledge")
          .update({ embedding: JSON.stringify(embedding) })
          .eq("id", row.id);
        if (updateError) { failed++; } else { success++; }
      })
    );
    if (i + batchSize < rows.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const { count } = await supabase
    .from("ai_reply_knowledge")
    .select("id", { count: "exact", head: true })
    .is("embedding", null);

  return NextResponse.json({
    ok: true,
    processed: success,
    failed,
    remaining: count ?? 0,
    message: (count ?? 0) > 0 ? `残り${count}件あります。もう一度叩いてください` : "全件完了！",
  });
}

// GET: 未処理件数を確認
export async function GET() {
  const { count: remaining } = await supabase
    .from("ai_reply_knowledge")
    .select("id", { count: "exact", head: true })
    .is("embedding", null);
  const { count: total } = await supabase
    .from("ai_reply_knowledge")
    .select("id", { count: "exact", head: true });
  return NextResponse.json({ remaining: remaining ?? 0, total: total ?? 0 });
}
