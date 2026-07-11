import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 30;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });

const ACTION_LABELS: Record<string, string> = {
  property_send: "物件ピックアップ送り",
  property_check_result: "物件確認結果",
  viewing_invite: "内覧誘導",
  application_push: "申込み促進",
  greeting: "挨拶",
  acknowledge_check: "確認への返答",
  docs_request: "書類案内",
  meeting_place: "待ち合わせ",
  estimate_sheet: "見積書",
};

// 修正版テンプレを抽出するヘルパー
function extractRevised(text: string): string | null {
  const m = text.match(/【修正版】\s*([\s\S]*?)\s*【\/修正版】/);
  return m ? m[1].trim() : null;
}

export async function POST(request: NextRequest) {
  const { proposed, original, actionType, reason, evidenceCount, messages } = await request.json() as {
    proposed: string;
    original?: string;
    actionType?: string;
    reason?: string;
    evidenceCount?: number;
    messages?: Array<{ role: "user" | "assistant"; content: string }>;
  };

  const actionLabel = ACTION_LABELS[actionType ?? ""] ?? actionType ?? "不明";
  const hasOriginal = original && original.trim();

  const systemPrompt = `あなたはスモラ賃貸仲介のLINE返信テンプレート品質改善アドバイザーです。
担当者（竹内悠馬）と一緒に、AIXが提案したテンプレートをブラッシュアップします。

【対象アクション】${actionLabel}
${evidenceCount ? `【観測回数】${evidenceCount}回のスタッフ修正パターンから抽出` : ""}
${reason ? `【提案理由】${reason}` : ""}

${hasOriginal ? `【現在のテンプレート】\n${original}\n\n【提案テンプレート】\n${proposed}` : `【提案テンプレート】\n${proposed}`}

## あなたの役割
- テンプレートの品質・問題点をフィードバックする
- 担当者の要望（「短くして」「もっと丁寧に」など）に応えてテンプレートを修正する
- 修正版を提示する場合は必ず以下の形式で囲む：
  【修正版】
  （修正したテンプレート本文）
  【/修正版】
- 担当者が納得したら「承認して採用」ボタンを押すよう案内する

## 返答スタイル
- 簡潔・箇条書き歓迎
- 修正版は必ず【修正版】タグで囲む
- 長文説明より具体的な修正案を優先`;

  // 初回（messagesなし or 空）はフィードバックを自動生成
  const isFirstTurn = !messages || messages.length === 0;
  const conversationMessages: Array<{ role: "user" | "assistant"; content: string }> = isFirstTurn
    ? [{ role: "user", content: "このテンプレートについてフィードバックをください。問題点や改善点があれば教えてください。" }]
    : messages;

  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 800,
    system: systemPrompt,
    messages: conversationMessages,
  });

  const reply = res.content[0].type === "text" ? res.content[0].text.trim() : "";
  const revisedTemplate = extractRevised(reply);

  return NextResponse.json({ ok: true, reply, revisedTemplate });
}
