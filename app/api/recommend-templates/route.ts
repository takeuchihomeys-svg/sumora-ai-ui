// POST /api/recommend-templates
// AIX送信後の「続きテンプレ」おすすめAPI
// 入力: conversation_id, action_type, sent_message, category, templates[{ id, label, text }]
//       customer_conditions (任意): お客様の希望条件テキスト
// 出力: { ok: boolean, recommendations: [{ id, reason, score }] }（スコア降順・上位3件）
//
// Claude Sonnet で以下を判断:
// - お客様の希望条件（customer_conditions）
// - AIX生成文（sent_message）: 希望条件のどこがマッチしたか・どこが足りなかったか
// - 直近の会話メッセージ（messages テーブル: customer / staff）
// - カテゴリ内の全テンプレ候補（サブカテゴリタグ込み）
// → ギャップ分析を踏まえて最もおすすめな順にスコアをつけて返す
//
// エラー時は { ok: false, recommendations: [] } を返す（UI側はおすすめなし表示にフォールバック）

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 30;

type TemplateCandidate = { id: string; label: string; text: string; use_count?: number | null; win_rate?: number | null };
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
      customer_conditions,
      sub_category,
    } = body as {
      conversation_id?: string | null;
      action_type?: string | null;
      sent_message?: string | null;
      category?: string | null;
      templates?: TemplateCandidate[];
      customer_conditions?: string | null;
      sub_category?: string | null;
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

    // 2. Sonnet でおすすめを判断（ギャップ分析が複雑なため）
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
    });

    // サブカテゴリ情報をテンプレラベルから読み取り可能にする説明を生成
    const subCategoryNote = sub_category
      ? `\n## 検出済みサブカテゴリ: 【${sub_category}】\n優先的にこのサブカテゴリのテンプレを推薦してください。`
      : "";

    const prompt = `あなたは不動産スタッフのLINE返信AIアシスタントです。
AIXで1通目を送信済みです。次に送る続きのテンプレートを推薦してください。

## お客様の希望条件
${customer_conditions ? customer_conditions.slice(0, 400) : "（紐付けなし）"}

## AIXで送った1通目のメッセージ${action_type ? `（アクション: ${action_type}）` : ""}
${(sent_message || "（なし）").slice(0, 800)}

## ギャップ分析（内部判断）
1通目と希望条件を照合し、以下を判断してください：
- 希望条件のうち1通目でカバーできた点（何があったか）
- 希望条件のうち1通目で言及できなかった点（何が足りていなかったか）
- お客様が次に感じるであろう疑問・不安
→ この分析を踏まえて、最も適切な続きのテンプレを選んでください。
${subCategoryNote}

## 直近の会話（古い順）
${conversationHistory}

## 候補テンプレート一覧${category ? `（カテゴリ: ${category}）` : ""}
※ 【】内のタグはサブカテゴリを示します（例:【初回まとめ】【通常内覧】など）
${templates.map((t, i) => {
      const stats = [
        (t.use_count ?? 0) > 0 ? `使用${t.use_count}回` : null,
        t.win_rate != null ? `成約率${Math.round((t.win_rate as number) * 100)}%` : null,
      ].filter(Boolean).join("・");
      return `[${i}] ${t.label}${stats ? ` (${stats})` : ""}\n${(t.text || "").slice(0, 300)}`;
    }).join("\n\n")}

## 指示
希望条件・1通目の内容・ギャップ分析を踏まえて、続けて送るのに最も適切なテンプレートを
上位3件まで選び、理由を簡潔に答えてください。
理由には「○○の希望に応えるため」「△△が伝えられていないため補足として」のように
ギャップ分析の内容を含めてください。

出力形式（JSON配列のみ・他のテキスト禁止）:
[{"index": 0, "score": 95, "reason": "家賃条件はカバー済み・エリアの補足が必要なため"}]`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      system: "あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。指定されたJSON形式のみで回答し、説明文は一切付けないでください。",
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
