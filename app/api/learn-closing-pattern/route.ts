import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const { conversation_id, customer_name } = await req.json() as {
      conversation_id: string;
      customer_name?: string;
    };
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

    const prompt = `以下は賃貸仲介の成約済み会話履歴です（お客様名: ${customer_name ?? "不明"}）。
この会話を分析して、「何が決め手になって成約したか」を学習パターンとして抽出してください。

【会話履歴】
${history}

以下のJSONのみ返してください：
{
  "closing_pattern": "どのパターンで決まったか（例: 1件ドンピシャ提案で申込み / 内覧後即申込み / 交渉失敗後別物件内覧 / 追客で再アプローチ等）",
  "customer_type": "このお客さんのタイプ（例: 条件明確・即決タイプ / 迷いやすいが後押しで動くタイプ / コスト重視タイプ等）",
  "key_action": "成約に直結した具体的なスタッフのアクション（例: 「よろしければ〇件内覧できます」と具体日程提示 / 申込みでお部屋を先に抑えるよう促した等）",
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

    // ai_reply_knowledge に保存（importance=9・proposingフェーズ）
    const content = `【成約パターン学習: ${customer_name ?? "不明"}さん】
パターン: ${learned.closing_pattern}
お客さんタイプ: ${learned.customer_type}
決め手のアクション: ${learned.key_action}
教訓: ${learned.lesson}
${learned.pattern_label}`;

    await supabase.from("ai_reply_knowledge").insert({
      category: "pattern",
      title: `成約パターン_${customer_name ?? "不明"}_${new Date().toISOString().slice(0, 10)}`,
      content,
      importance: 9,
      conversation_state: "proposing",
    });

    return NextResponse.json({ ok: true, learned });
  } catch (e) {
    console.error("learn-closing-pattern error:", e);
    return NextResponse.json({ ok: false, error: "Failed" }, { status: 500 });
  }
}
