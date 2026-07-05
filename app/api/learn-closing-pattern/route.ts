import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// Sonnet呼び出し（80件履歴）+ embedding生成で15〜30秒かかるため延長
export const maxDuration = 60;

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 2000) }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding ?? null;
  } catch { return null; }
}

export async function POST(req: NextRequest) {
  try {
    const { conversation_id, customer_name, event_type } = await req.json() as {
      conversation_id: string;
      customer_name?: string;
      event_type?: string;
    };
    const eventLabel = event_type === "application" ? "申込" : "成約";
    if (!conversation_id) return NextResponse.json({ ok: false, error: "conversation_id required" }, { status: 400 });

    // 会話履歴を取得（直近80件）
    const { data: msgs } = await supabase
      .from("messages")
      .select("sender, text, created_at")
      .eq("conversation_id", conversation_id)
      .neq("text", "[画像]")
      .neq("text", "[動画]")
      .not("text", "is", null)
      .order("created_at", { ascending: true })
      .limit(80);

    if (!msgs || msgs.length < 3) {
      return NextResponse.json({ ok: false, error: "会話履歴が少なすぎます" });
    }

    const history = (msgs as Array<{ sender: string; text: string }>)
      .map((m) => `${m.sender === "customer" ? "お客さん" : "スタッフ"}: ${(m.text || "").slice(0, 150)}`)
      .join("\n");

    const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
    if (!apiKey) return NextResponse.json({ ok: false, error: "API key missing" }, { status: 500 });

    const isApplication = event_type === "application";
    const successMoment = isApplication
      ? "お客さんが申込フォーマット（氏名・フリガナ・生年月日・現住所・緊急連絡先・勤務先などの個人情報）をLINEで送ってきた瞬間"
      : "最終的に成約・契約に至った瞬間";
    const keyActionHint = isApplication
      ? "申込フォーマットを送るに至ったスタッフの一手（例: 申込みでお部屋を先に抑えるよう背中を押した / 初期費用の見積を送って安心させた / 内覧後すぐ申込みを促した等）"
      : "成約に直結した具体的なスタッフのアクション（例: 「よろしければ〇件内覧できます」と具体日程提示 / 申込みでお部屋を先に抑えるよう促した等）";

    const prompt = `以下は賃貸仲介の会話履歴です（お客様名: ${customer_name ?? "不明"}）。
成功の定義: 「${successMoment}」
この会話でなぜお客さんがそのアクションを取ったかを分析し、学習パターンとして抽出してください。

【会話履歴】
${history}

以下のJSONのみ返してください：
{
  "closing_pattern": "どのパターンで申込フォームを送るに至ったか（例: 内覧後即申込み / 見積書で初期費用の安さを確認して申込み / 1件ドンピシャ提案で即決 / 追客で再アプローチ後申込み等）",
  "customer_type": "このお客さんのタイプ（例: 条件明確・即決タイプ / 迷いやすいが後押しで動くタイプ / コスト重視タイプ等）",
  "key_action": "${keyActionHint}",
  "lesson": "次の似たお客さんへの教訓・使えるパターン（1〜2文）",
  "pattern_label": "★決まるパターン: 〜〜（customer-summaryで使う1行表現）"
}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) return NextResponse.json({ ok: false, error: "AI error" }, { status: 500 });

    const data = await res.json() as { content?: Array<{ text: string }> };
    const raw = data.content?.[0]?.text ?? "";
    const match = raw.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim().match(/\{[\s\S]*\}/);
    if (!match) return NextResponse.json({ ok: false, error: "parse error" });

    const learned = JSON.parse(match[0]) as {
      closing_pattern: string;
      customer_type: string;
      key_action: string;
      lesson: string;
      pattern_label: string;
    };

    // ai_reply_knowledge に保存（importance=9・proposingフェーズ・RAG用embeddingも即付与）
    const content = `【${eventLabel}パターン学習: ${customer_name ?? "不明"}さん】
パターン: ${learned.closing_pattern}
お客さんタイプ: ${learned.customer_type}
決め手のアクション: ${learned.key_action}
教訓: ${learned.lesson}
${learned.pattern_label}`;

    // 重複INSERT防止: 同一タイトルが既に存在する場合はスキップ
    const titleKey = `${eventLabel}パターン_${customer_name ?? "不明"}_${new Date().toISOString().slice(0, 10)}`;
    const { data: existingPattern } = await supabase
      .from("ai_reply_knowledge")
      .select("id")
      .eq("title", titleKey)
      .limit(1);
    if (existingPattern?.length) {
      return NextResponse.json({ ok: true, learned, skipped: true });
    }

    const embedding = await getEmbedding(`pattern: ${content}`);
    await supabase.from("ai_reply_knowledge").insert({
      category: "pattern",
      title: `${eventLabel}パターン_${customer_name ?? "不明"}_${new Date().toISOString().slice(0, 10)}`,
      content,
      importance: 9,
      conversation_state: "proposing",
      ...(embedding ? { embedding: JSON.stringify(embedding) } : {}),
    });

    return NextResponse.json({ ok: true, learned });
  } catch (e) {
    console.error("learn-closing-pattern error:", e);
    return NextResponse.json({ ok: false, error: "Failed" }, { status: 500 });
  }
}
