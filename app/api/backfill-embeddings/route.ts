import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 300;

async function getEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 2000) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn("[backfill] OpenAI error", res.status, await res.text());
      return null;
    }
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

async function backfillTable<T extends { id: string }>(
  tableName: string,
  rows: T[],
  toText: (row: T) => string,
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;
  const batchSize = 10;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (row) => {
        const embedding = await getEmbedding(toText(row));
        if (!embedding) { failed++; return; }
        const { error } = await supabase
          .from(tableName)
          .update({ embedding: JSON.stringify(embedding) })
          .eq("id", row.id);
        if (error) { failed++; } else { success++; }
      })
    );
    if (i + batchSize < rows.length) await new Promise((r) => setTimeout(r, 100));
  }
  return { success, failed };
}

// POST: 埋め込みがない既存レコードに一括生成・保存
export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const authHeader = req.headers.get("authorization");
  const validAuth =
    (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
    (internalSecret && authHeader === `Bearer ${internalSecret}`);
  if (!validAuth) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ ok: false, error: "OPENAI_API_KEY not set" }, { status: 500 });
  }

  // ── ai_reply_examples ──────────────────────────────────────────────────────
  const { data: exampleRows, error: exErr } = await supabase
    .from("ai_reply_examples")
    .select("id, conversation_state, customer_message")
    .is("embedding", null)
    .limit(200);
  if (exErr) return NextResponse.json({ ok: false, error: exErr.message }, { status: 500 });

  const exResult = await backfillTable(
    "ai_reply_examples",
    (exampleRows ?? []) as Array<{ id: string; conversation_state: string; customer_message: string }>,
    (r) => `${r.conversation_state}: ${r.customer_message}`,
  );

  // ── winning_patterns ───────────────────────────────────────────────────────
  const { data: wpRows, error: wpErr } = await supabase
    .from("winning_patterns")
    .select("id, situation, pattern, customer_intent")
    .is("embedding", null)
    .limit(100);
  if (wpErr) return NextResponse.json({ ok: false, error: wpErr.message }, { status: 500 });

  const wpResult = await backfillTable(
    "winning_patterns",
    (wpRows ?? []) as Array<{ id: string; situation: string | null; pattern: string; customer_intent: string | null }>,
    (r) => `${r.customer_intent ?? r.situation ?? ""}: ${r.pattern}`,
  );

  // ── 残件数確認 ─────────────────────────────────────────────────────────────
  const { count: exRemaining } = await supabase
    .from("ai_reply_examples")
    .select("id", { count: "exact", head: true })
    .is("embedding", null);
  const { count: wpRemaining } = await supabase
    .from("winning_patterns")
    .select("id", { count: "exact", head: true })
    .is("embedding", null);

  const totalRemaining = (exRemaining ?? 0) + (wpRemaining ?? 0);
  return NextResponse.json({
    ok: true,
    ai_reply_examples: exResult,
    winning_patterns: wpResult,
    remaining: { ai_reply_examples: exRemaining ?? 0, winning_patterns: wpRemaining ?? 0 },
    message: totalRemaining > 0 ? `残り${totalRemaining}件あります。もう一度叩いてください` : "全件完了！",
  });
}

// GET: Vercel Cron 向け（認証付きバックフィル実行 / MED-04）
// 毎日未処理の embedding を自動補完する。未処理0件なら即返却。
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    // 認証なしなら件数確認のみ（従来の GET 動作）
    const { count: exCount } = await supabase
      .from("ai_reply_examples")
      .select("id", { count: "exact", head: true })
      .is("embedding", null);
    const { count: exTotal } = await supabase
      .from("ai_reply_examples")
      .select("id", { count: "exact", head: true });
    const { count: wpCount } = await supabase
      .from("winning_patterns")
      .select("id", { count: "exact", head: true })
      .is("embedding", null);
    const { count: wpTotal } = await supabase
      .from("winning_patterns")
      .select("id", { count: "exact", head: true });
    return NextResponse.json({
      ai_reply_examples: { remaining: exCount ?? 0, total: exTotal ?? 0 },
      winning_patterns: { remaining: wpCount ?? 0, total: wpTotal ?? 0 },
    });
  }
  // 認証あり（Vercel Cron）: POST と同じバックフィル処理を実行
  return POST(req as unknown as Request);
}
