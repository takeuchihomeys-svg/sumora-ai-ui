import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

async function getEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 2000) }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

// POST: 埋め込みがない既存レコードに一括生成・保存
export async function POST() {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ ok: false, error: "OPENAI_API_KEY not set" }, { status: 500 });
  }

  // embedding が NULL のレコードを最大200件取得
  const { data: rows, error } = await supabase
    .from("ai_reply_examples")
    .select("id, conversation_state, customer_message")
    .is("embedding", null)
    .limit(200);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!rows || rows.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, message: "全件処理済みです" });
  }

  let success = 0;
  let failed = 0;

  // 10件ずつ並列処理（レート制限対策）
  const batchSize = 10;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (row) => {
        const input = `${row.conversation_state}: ${row.customer_message}`;
        const embedding = await getEmbedding(input);
        if (!embedding) { failed++; return; }
        const { error: updateError } = await supabase
          .from("ai_reply_examples")
          .update({ embedding: JSON.stringify(embedding) })
          .eq("id", row.id);
        if (updateError) { failed++; } else { success++; }
      })
    );
    // バッチ間に少し待機（レート制限対策）
    if (i + batchSize < rows.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // まだ残りがあるか確認
  const { count } = await supabase
    .from("ai_reply_examples")
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
  const { count } = await supabase
    .from("ai_reply_examples")
    .select("id", { count: "exact", head: true })
    .is("embedding", null);
  const { count: total } = await supabase
    .from("ai_reply_examples")
    .select("id", { count: "exact", head: true });
  return NextResponse.json({ remaining: count ?? 0, total: total ?? 0 });
}
