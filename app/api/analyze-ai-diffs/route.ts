import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET;

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
    const data = await res.json() as { content?: Array<{ text: string }> };
    return data.content?.[0]?.text?.trim() || "";
  } catch { return ""; }
}

async function analyzeDiff(
  exampleId: string,
  conversationState: string,
  customerMessage: string,
  aiDraft: string,
  sentReply: string
): Promise<boolean> {
  const text = await callHaiku(`あなたはスモラ（賃貸仲介）のLINE営業AIのトレーナーです。
スタッフが修正した内容から、次回のAI生成を改善するルールを抽出してください。

【スモラのLINEスタイル（前提として必ず守ること）】
・絵文字（😊 😌 🌟 ✨ ✅）は積極的に使う
・「させて頂きます」「頂きます」の多用は正しい丁寧語スタイル
・「本日中に〜します！！」などの積極的な行動宣言はスモラの強み
・顧客名（〇〇さん）は文頭で積極的に呼びかける
・感嘆符「！！」を積極的に使う

【注意：以下は絶対に生成しないルール】
× 「絵文字を避けること」「絵文字を減らすこと」
× 「営業的な表現を控えること」
× 「過度な約束を避けること」

【お客様のメッセージ】
${customerMessage}

【AIが生成した文案（修正前）】
${aiDraft}

【スタッフが実際に送った文（修正後）】
${sentReply}

以下を分析してJSONのみで返答（説明不要）：
{
  "ai_mistake": "AIが間違えた点（スモラスタイルの観点で・1〜2文）",
  "correction_pattern": "スタッフがどう直したか・何を重視したか（1〜2文）",
  "rule": "次回から守るべきルール（スモラスタイルに沿った具体的な1文）"
}`);

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return false;
    const analysis = JSON.parse(match[0]) as {
      ai_mistake: string;
      correction_pattern: string;
      rule: string;
    };

    await supabase.from("ai_reply_knowledge").insert([
      {
        category: "principle",
        title: `[差分学習] ${(analysis.ai_mistake || "").slice(0, 30)}`,
        content: analysis.rule,
        importance: 9,
        conversation_state: conversationState || null,
        source_example_id: exampleId,
      },
      {
        category: "pattern",
        title: `[修正対比] ${conversationState}`,
        content: analysis.correction_pattern,
        importance: 8,
        conversation_state: conversationState || null,
        source_example_id: exampleId,
      },
    ]);
    return true;
  } catch { return false; }
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    // was_ai_modified=true かつ ai_draft がある全件をページネーション取得
    const rows: Array<{ id: string; conversation_state: string; customer_message: string; ai_draft: string; sent_reply: string }> = [];
    let page = 0;
    while (true) {
      const { data } = await supabase
        .from("ai_reply_examples")
        .select("id, conversation_state, customer_message, ai_draft, sent_reply")
        .eq("was_ai_modified", true)
        .not("ai_draft", "is", null)
        .range(page * 1000, page * 1000 + 999);
      if (!data || data.length === 0) break;
      rows.push(...(data as typeof rows));
      if (data.length < 1000) break;
      page++;
    }

    // 既に差分学習済みの source_example_id を取得
    const processedIds = new Set<string>();
    let kpage = 0;
    while (true) {
      const { data } = await supabase
        .from("ai_reply_knowledge")
        .select("source_example_id")
        .like("title", "[差分学習]%")
        .not("source_example_id", "is", null)
        .range(kpage * 1000, kpage * 1000 + 999);
      if (!data || data.length === 0) break;
      data.forEach(r => { if (r.source_example_id) processedIds.add(r.source_example_id as string); });
      if (data.length < 1000) break;
      kpage++;
    }

    const unprocessed = rows.filter(r => !processedIds.has(r.id));
    const BATCH = 12; // 1回15件上限（3並列×4）
    const toProcess = unprocessed.slice(0, BATCH);

    let succeeded = 0;
    const CONCURRENCY = 3;
    for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
      const chunk = toProcess.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunk.map(ex => analyzeDiff(
          ex.id, ex.conversation_state,
          ex.customer_message, ex.ai_draft, ex.sent_reply
        ))
      );
      succeeded += results.filter(Boolean).length;
    }

    return NextResponse.json({
      ok: true,
      total_ai_modified: rows.length,
      already_done: processedIds.size,
      newly_analyzed: toProcess.length,
      succeeded,
      remaining: unprocessed.length - toProcess.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
