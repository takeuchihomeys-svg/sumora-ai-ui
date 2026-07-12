import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

// 🤝 ナレッジ打ち合わせ
// TemplateModal のナレッジ承認パネル「🤝 打ち合わせ」ボタンから呼ばれる。
// hypothesis ナレッジ1件を Sonnet に分析させ、承認/却下の判断材料を返す。

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", timeout: 50_000, maxRetries: 1 });

export async function POST(req: NextRequest) {
  try {
    const { title, content, category } = await req.json();

    if (!title || !content) {
      return NextResponse.json({ ok: false, error: "title と content は必須です" }, { status: 400 });
    }

    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: "あなたはLINE不動産接客AIのナレッジ品質レビュアーです。hypothesis 状態のナレッジ（自動抽出された業務ルール仮説）を承認すべきか却下すべきかを分析します。承認されたナレッジはAIX・LINE返信生成時にプロンプトへ注入されます。",
      messages: [{
        role: "user",
        content: `以下のナレッジ（hypothesis）を分析してください。

【タイトル】
${title}

【内容】
${content}

【カテゴリ】
${category ?? "なし"}

以下の観点で簡潔に分析してください（全体で300文字以内・箇条書き可）:
1. このナレッジは valid か？（事実として妥当か・不動産接客の文脈で正しいか）
2. 承認すべきか却下すべきか？（結論を明確に）
3. その理由（プロンプト注入した場合の効果・リスク）

分析結果のテキストのみ返してください（前置き・コードフェンス不要）。`,
      }],
    });

    const analysis = res.content[0]?.type === "text" ? res.content[0].text.trim() : "";
    if (!analysis) {
      return NextResponse.json({ ok: false, error: "分析結果が空でした" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, analysis });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ ok: false, error: message, analysis: "分析に失敗しました" }, { status: 500 });
  }
}
