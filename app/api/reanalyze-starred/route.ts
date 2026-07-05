import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

const STATE_NORMALIZE: Record<string, string> = {
  condition_hearing:       "hearing",
  property_search:         "hearing",
  property_recommendation: "proposing",
  viewing:                 "proposing",
  estimate_request:        "proposing",
  availability_check:      "proposing",
  application:             "applying",
  screening:               "applying",
  contract:                "applying",
};

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
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return "";
    const data = await res.json() as { content?: Array<{ text: string }> };
    return data.content?.[0]?.text?.trim() || "";
  } catch {
    return "";
  }
}

// ⭐実例を深層分析してナレッジを保存（改良版プロンプト）
async function analyzeExample(
  exampleId: string,
  state: string,
  customerMessage: string,
  sentReply: string
): Promise<number> {
  const text = await callHaiku(`あなたはスモラ（賃貸仲介）のLINE営業の品質分析AIです。
以下の実際のやりとりから、AI文案生成に役立つパターンとルールを抽出してください。

【営業フェーズ】${state}
【お客様のメッセージ】
${customerMessage}

【スモラスタッフの実際の返信（⭐良質な返信）】
${sentReply}

以下をJSONで抽出してください：
{
  "situation": "この状況を10文字以内で（例：初回問い合わせ受け取り）",
  "pattern": "この状況でのベストな返し方のパターン（具体的に・どんな冒頭で始め・何を伝え・どう締めるか）",
  "style_points": [
    "文体の特徴1（例：「！！」を文末に使う）",
    "文体の特徴2（例：お客様名を冒頭で呼ぶ）",
    "文体の特徴3（例：短くして余計なことを言わない）"
  ],
  "reusable_phrases": [
    "再利用できるフレーズ1（固有情報なし・20〜50文字）",
    "再利用できるフレーズ2"
  ],
  "core_principle": "この返信が良い理由・次のAI生成に活かすべきルール（1文・具体的に）"
}`);

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return 0;
    const a = JSON.parse(match[0]) as {
      situation: string;
      pattern: string;
      style_points: string[];
      reusable_phrases: string[];
      core_principle: string;
    };

    const entries = [
      {
        category: "pattern" as const,
        title: a.situation || "状況不明",
        content: a.pattern || "",
        importance: 8,
      },
      {
        category: "principle" as const,
        title: `核心: ${(a.situation || "").slice(0, 20)}`,
        content: a.core_principle || "",
        importance: 9,
      },
      ...(a.style_points || []).map((p) => ({
        category: "style" as const,
        title: "スモラスタイル",
        content: p,
        importance: 7,
      })),
      ...(a.reusable_phrases || []).map((p) => ({
        category: "phrase" as const,
        title: "スモラフレーズ",
        content: p,
        importance: 7,
      })),
    ].filter((e) => e.content.trim().length > 3);

    for (const entry of entries) {
      await supabase.from("ai_reply_knowledge").insert({
        category: entry.category,
        title: entry.title,
        content: entry.content,
        importance: entry.importance,
        conversation_state: state,
        source_example_id: exampleId,
      });
    }
    return entries.length;
  } catch {
    return 0;
  }
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const secret = req.headers.get("x-cron-secret");
  if (secret !== cronSecret && secret !== process.env.SYNC_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { limit: limitParam = 30, mode = "starred" } = await req.json().catch(() => ({})) as {
    limit?: number;
    mode?: "starred" | "all" | "normalize_only";
  };

  // ── STEP 1: ステート名を新5段階に正規化 ──────────────────────────────────
  let normalizedCount = 0;
  for (const [oldState, newState] of Object.entries(STATE_NORMALIZE)) {
    const { data: updated } = await supabase
      .from("ai_reply_examples")
      .update({ conversation_state: newState })
      .eq("conversation_state", oldState)
      .select("id");
    normalizedCount += updated?.length ?? 0;
  }
  // knowledgeも同様に正規化
  for (const [oldState, newState] of Object.entries(STATE_NORMALIZE)) {
    await supabase
      .from("ai_reply_knowledge")
      .update({ conversation_state: newState })
      .eq("conversation_state", oldState);
  }

  if (mode === "normalize_only") {
    return NextResponse.json({ ok: true, normalized: normalizedCount });
  }

  // ── STEP 2: ⭐例文を改良プロンプトで再分析 ───────────────────────────────
  const query = supabase
    .from("ai_reply_examples")
    .select("id, conversation_state, customer_message, sent_reply")
    .order("created_at", { ascending: false })
    .limit(Math.min(limitParam, 20));

  if (mode === "starred") {
    query.eq("is_starred", true);
  }

  const { data: examples, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!examples?.length) return NextResponse.json({ ok: true, analyzed: 0, normalized: normalizedCount });

  let totalAdded = 0;
  for (const ex of examples) {
    const state = ex.conversation_state as string;
    const added = await analyzeExample(
      ex.id as string,
      state,
      ex.customer_message as string,
      ex.sent_reply as string
    );
    totalAdded += added;
  }

  return NextResponse.json({
    ok: true,
    normalized: normalizedCount,
    analyzed: examples.length,
    knowledge_added: totalAdded,
    message: `${examples.length}件を再分析・${totalAdded}件のナレッジを追加しました`,
  });
}
