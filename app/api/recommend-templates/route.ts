// POST /api/recommend-templates
// AIX送信後の「続きテンプレ」おすすめAPI
// 入力: conversation_id, action_type, sent_message, category, templates[{ id, label, text }]
// 出力: { ok: boolean, recommendations: [{ id, reason, score }] }（スコア降順・上位3件）
//
// Claude Haiku で以下を判断:
// - AIX生成文（sent_message）の内容
// - 直近の会話メッセージ（messages テーブル: customer / staff）
// - カテゴリ内の全テンプレ候補
// → 最もおすすめな順にスコアをつけて返す
//
// エラー時は { ok: false, recommendations: [] } を返す（UI側はおすすめなし表示にフォールバック）

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 30;

type TemplateCandidate = { id: string; label: string; text: string };
type RankedItem = { index: number; score: number; reason: string };

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      conversation_id,
      action_type,
      sent_message,
      category,
      templates,
    } = body as {
      conversation_id?: string | null;
      action_type?: string | null;
      sent_message?: string | null;
      category?: string | null;
      templates?: TemplateCandidate[];
    };

    if (!Array.isArray(templates) || templates.length === 0) {
      return NextResponse.json({ ok: true, recommendations: [] });
    }

    // 1. 直近の会話メッセージを取得（最大10件・新しい順で取得→古い順に並べ直す）
    let conversationHistory = "（会話履歴なし）";
    if (conversation_id) {
      const { data: msgs } = await supabase
        .from("messages")
        .select("sender, text, created_at")
        .eq("conversation_id", conversation_id)
        .neq("text", "[画像]")
        .neq("text", "[動画]")
        .not("text", "is", null)
        .order("created_at", { ascending: false })
        .limit(10);
      if (msgs && msgs.length > 0) {
        conversationHistory = (msgs as Array<{ sender: string; text: string }>)
          .reverse()
          .map((m) => `${m.sender === "customer" ? "顧客" : "スタッフ"}: ${(m.text || "").slice(0, 120)}`)
          .join("\n");
      }
    }

    // 2. Haiku でおすすめを判断
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
    });

    const prompt = `あなたは不動産スタッフのLINE返信AIアシスタントです。

## AIXで送った1通目のメッセージ${action_type ? `（アクション: ${action_type}）` : ""}
${(sent_message || "（なし）").slice(0, 800)}

## 直近の会話（古い順）
${conversationHistory}

## 続けて送る候補テンプレート一覧${category ? `（カテゴリ: ${category}）` : ""}
${templates.map((t, i) => `[${i}] ${t.label}\n${(t.text || "").slice(0, 150)}`).join("\n\n")}

## 指示
1通目のメッセージと会話の流れを踏まえて、続けて送るのに最も適切なテンプレートを
上位3件まで選び、理由を簡潔に答えてください。

出力形式（JSON配列のみ・他のテキスト禁止）:
[{"index": 0, "score": 95, "reason": "内覧を自然に提案できる流れ"}]`;

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    const firstBlock = response.content[0];
    const text = firstBlock?.type === "text" ? firstBlock.text : "[]";

    // JSON抽出（前後に余計なテキストがあっても配列部分だけ取り出す）
    const match = text.match(/\[[\s\S]*\]/);
    let ranked: RankedItem[] = [];
    try {
      ranked = match ? (JSON.parse(match[0]) as RankedItem[]) : [];
    } catch {
      ranked = [];
    }

    const recommendations = ranked
      .filter(
        (r) =>
          typeof r.index === "number" &&
          r.index >= 0 &&
          r.index < templates.length,
      )
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 3)
      .map((r) => ({
        id: templates[r.index].id,
        score: r.score ?? 0,
        reason: r.reason ?? "",
      }));

    return NextResponse.json({ ok: true, recommendations });
  } catch (e) {
    console.error("[recommend-templates] error:", e);
    return NextResponse.json({ ok: false, recommendations: [] });
  }
}
