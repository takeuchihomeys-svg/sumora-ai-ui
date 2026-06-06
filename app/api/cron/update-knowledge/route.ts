import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { runKnowledgeCleanup } from "@/app/lib/knowledge-cleanup";

export const maxDuration = 60;

// Vercel cronは Authorization: Bearer <CRON_SECRET> を自動付与
async function callHaiku(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { content?: Array<{ text: string }> };
    return data.content?.[0]?.text?.trim() || "";
  } catch {
    return "";
  }
}

async function analyzeOne(exampleId: string, conversationState: string, customerMessage: string, sentReply: string): Promise<number> {
  const text = await callHaiku(`以下のLINE賃貸営業のやりとりを深く分析してください。

【お客様のメッセージ】
${customerMessage}

【スモラスタッフの返信】
${sentReply}

以下の4点を抽出してください。JSONのみで返答（説明不要）：
{
  "situation": "この状況を一言で表す（例：初めての条件共有、物件への反応など）",
  "pattern": "この状況でのベストな返し方の原則（具体的に・1〜2文）",
  "style_elements": ["口調・文体の特徴を3〜5点（例：お客様名を呼ぶ、絵文字を使う、etc.）"],
  "key_phrases": ["この返信で使われている再利用可能なフレーズ（1〜3個）"],
  "principle": "この返信が優れている核心的な理由（1文）"
}`);

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return 0;
    const analysis = JSON.parse(match[0]) as {
      situation: string; pattern: string;
      style_elements: string[]; key_phrases: string[]; principle: string;
    };
    const entries = [
      { category: "pattern" as const,    title: analysis.situation,          content: analysis.pattern,    importance: 7 },
      { category: "principle" as const,  title: `原則：${analysis.situation}`, content: analysis.principle,  importance: 8 },
      ...analysis.style_elements.map((el) => ({ category: "style" as const, title: "口調・スタイル", content: el, importance: 6 })),
      ...analysis.key_phrases.map((p)  => ({ category: "phrase" as const,   title: "フレーズ",      content: p,  importance: 6 })),
    ];
    let inserted = 0;
    for (const entry of entries) {
      const { error } = await supabase.from("ai_reply_knowledge").insert({
        ...entry, conversation_state: conversationState || null, source_example_id: exampleId,
      });
      if (!error) inserted++;
    }
    return inserted;
  } catch { return 0; }
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 未処理の☆つき例文を取得
    const { data: examples } = await supabase
      .from("ai_reply_examples")
      .select("id, conversation_state, customer_message, sent_reply")
      .eq("is_starred", true);

    if (!examples || examples.length === 0) {
      return NextResponse.json({ ok: true, message: "no starred examples" });
    }

    // 処理済みIDをページネーションで全取得
    const processedIds = new Set<string>();
    let page = 0;
    while (true) {
      const { data } = await supabase
        .from("ai_reply_knowledge")
        .select("source_example_id")
        .not("source_example_id", "is", null)
        .range(page * 1000, page * 1000 + 999);
      if (!data || data.length === 0) break;
      data.forEach((r) => { if (r.source_example_id) processedIds.add(r.source_example_id as string); });
      if (data.length < 1000) break;
      page++;
    }

    const unprocessed = examples.filter((ex) => !processedIds.has(ex.id as string));
    const toProcess = unprocessed.slice(0, 15);

    let totalAdded = 0;
    for (let i = 0; i < toProcess.length; i += 3) {
      const chunk = toProcess.slice(i, i + 3);
      const results = await Promise.all(
        chunk.map((ex) => analyzeOne(
          ex.id as string,
          (ex.conversation_state as string) || "first_reply",
          ex.customer_message as string,
          ex.sent_reply as string,
        ))
      );
      totalAdded += results.reduce((s, n) => s + n, 0);
    }

    // 処理後に自動クリーンアップ
    const cleanup = toProcess.length > 0 ? await runKnowledgeCleanup() : null;

    return NextResponse.json({
      ok: true,
      newly_processed: toProcess.length,
      remaining: unprocessed.length - toProcess.length,
      knowledge_entries_added: totalAdded,
      cleanup,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron/update-knowledge] error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
