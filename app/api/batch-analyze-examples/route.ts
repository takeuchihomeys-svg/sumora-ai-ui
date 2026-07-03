import { NextRequest, NextResponse, after } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { runKnowledgeCleanup } from "@/app/lib/knowledge-cleanup";

export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET;

async function callHaiku(prompt: string, maxTokens = 1024): Promise<string> {
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
        max_tokens: maxTokens,
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

async function analyzeOne(
  exampleId: string,
  conversationState: string,
  customerMessage: string,
  sentReply: string
): Promise<number> {
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
      situation: string;
      pattern: string;
      style_elements: string[];
      key_phrases: string[];
      principle: string;
    };

    const entries = [
      {
        category: "pattern" as const,
        title: analysis.situation,
        content: analysis.pattern,
        importance: 7,
      },
      {
        category: "principle" as const,
        title: `原則：${analysis.situation}`,
        content: analysis.principle,
        importance: 8,
      },
      ...analysis.style_elements.map((el) => ({
        category: "style" as const,
        title: "口調・スタイル",
        content: el,
        importance: 6,
      })),
      ...analysis.key_phrases.map((phrase) => ({
        category: "phrase" as const,
        title: "フレーズ",
        content: phrase,
        importance: 6,
      })),
    ];

    let inserted = 0;
    for (const entry of entries) {
      const { error: insErr } = await supabase.from("ai_reply_knowledge").insert({
        category: entry.category,
        title: entry.title,
        content: entry.content,
        importance: entry.importance,
        conversation_state: conversationState || null,
        source_example_id: exampleId,
      });
      if (insErr) {
        console.error("[batch-analyze] insert error:", insErr.message, "code:", insErr.code);
      } else {
        inserted++;
      }
    }
    return inserted;
  } catch {
    return 0;
  }
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 全starred例を取得
    const { data: examples, error: exErr } = await supabase
      .from("ai_reply_examples")
      .select("id, conversation_state, customer_message, sent_reply")
      .eq("is_starred", true);

    if (exErr || !examples) {
      return NextResponse.json(
        { ok: false, error: exErr?.message || "Failed to fetch examples" },
        { status: 500 }
      );
    }

    // 処理済み source_example_id を全ページ取得（anon keyは1000行上限のためページネーション必須）
    const processedIds = new Set<string>();
    let page = 0;
    while (true) {
      const { data: pageData } = await supabase
        .from("ai_reply_knowledge")
        .select("source_example_id")
        .not("source_example_id", "is", null)
        .range(page * 1000, page * 1000 + 999);
      if (!pageData || pageData.length === 0) break;
      pageData.forEach((r) => { if (r.source_example_id) processedIds.add(r.source_example_id as string); });
      if (pageData.length < 1000) break;
      page++;
    }
    const unprocessed = examples.filter((ex) => !processedIds.has(ex.id as string));

    // 1回のリクエストで処理する上限（超過分は次回呼び出しで処理）
    const BATCH_LIMIT = 15;
    const toProcess = unprocessed.slice(0, BATCH_LIMIT);

    // 3件並列でHaikuを叩く（レート制限内・タイムアウト回避）
    let totalAdded = 0;
    const CONCURRENCY = 3;
    for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
      const chunk = toProcess.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunk.map((ex) =>
          analyzeOne(
            ex.id as string,
            (ex.conversation_state as string) || "first_reply",
            ex.customer_message as string,
            ex.sent_reply as string
          )
        )
      );
      totalAdded += results.reduce((s, n) => s + n, 0);
    }

    // 新規処理があった場合はレスポンス送信後にバックグラウンドでクリーンアップ
    if (toProcess.length > 0) {
      after(async () => {
        try {
          const result = await runKnowledgeCleanup();
          console.log("[batch-analyze] auto-cleanup:", JSON.stringify(result));
        } catch (e) {
          console.error("[batch-analyze] auto-cleanup error:", e);
        }
      });
    }

    return NextResponse.json({
      ok: true,
      total_starred: examples.length,
      already_processed: examples.length - unprocessed.length,
      newly_processed: toProcess.length,
      remaining: unprocessed.length - toProcess.length,
      knowledge_entries_added: totalAdded,
      cleanup: toProcess.length > 0 ? "scheduled" : "skipped",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
