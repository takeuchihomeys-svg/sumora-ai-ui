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

export async function POST(request: NextRequest) {
  const { proposed, original, actionType, reason, evidenceCount } = await request.json() as {
    proposed: string;
    original?: string;
    actionType?: string;
    reason?: string;
    evidenceCount?: number;
  };

  const actionLabel = ACTION_LABELS[actionType ?? ""] ?? actionType ?? "不明";
  const hasOriginal = original && original.trim();

  const prompt = `あなたはスモラ賃貸仲介のLINE返信テンプレートの品質レビュアーです。
AIXが提案した新しいテンプレートについてフィードバックを出してください。

【対象アクション】${actionLabel}
${evidenceCount ? `【観測回数】${evidenceCount}回のスタッフ修正パターンから抽出` : ""}
${reason ? `【提案理由】${reason}` : ""}

${hasOriginal ? `【現在のテンプレート】\n${original}\n\n【提案テンプレート】\n${proposed}` : `【提案テンプレート】\n${proposed}`}

以下の観点でフィードバックを出してください：
1. ${hasOriginal ? "変更点の妥当性（何が改善されているか）" : "テンプレートとしての品質"}
2. 懸念点・リスク（あれば）
3. 採用するなら修正すべき点（あれば）
4. 総合判断（採用推奨 / 要修正 / 見送り）

簡潔に・箇条書きで答えてください。`;

  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 600,
    messages: [{ role: "user", content: prompt }],
  });

  const feedback = res.content[0].type === "text" ? res.content[0].text.trim() : "";
  return NextResponse.json({ ok: true, feedback });
}
