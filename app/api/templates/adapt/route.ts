import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "") });

export async function POST(req: NextRequest) {
  const {
    templateText,
    customerName,
    conversationState,
    recentMessages,
    customerConditions,
  } = await req.json() as {
    templateText: string;
    customerName?: string;
    conversationState?: string;
    recentMessages?: Array<{ sender: string; text: string; imageUrl?: string }>;
    customerConditions?: string;
  };

  if (!templateText) {
    return NextResponse.json({ ok: false, error: "templateText required" }, { status: 400 });
  }

  const history = (recentMessages || [])
    .slice(-10)
    .map((m) => {
      const who = m.sender === "customer" ? "お客様" : "スモラ";
      if (m.text === "[画像]" || m.text === "[動画]") return `${who}: 【画像・資料を送付】`;
      if (!m.text) return null;
      return `${who}: ${m.text}`;
    })
    .filter(Boolean)
    .join("\n");

  const STATE_LABEL: Record<string, string> = {
    first_reply: "初回応対", condition_hearing: "条件ヒアリング",
    property_search: "物件探し中", property_recommendation: "物件提案中",
    viewing: "内覧調整", estimate_request: "見積依頼",
    availability_check: "空室確認", application: "申込中",
    screening: "審査中", contract: "契約中", closed_won: "成約済み",
  };
  const stateLabel = STATE_LABEL[conversationState || ""] || conversationState || "不明";

  const conditionsSection = customerConditions
    ? `\n【お客様の希望条件】\n${customerConditions}\n`
    : "";

  const prompt = `あなたはスモラ（賃貸仲介サービス）のLINE営業担当です。
以下のテンプレートをこのお客様・この状況に合わせて自然に書き換えてください。

【ルール】
・文体・トーンはスモラのLINEスタイルを維持
・感嘆符は「！！」（「!」「！」1つは禁止）
・使える絵文字: 😊 😌 🙇‍♀️ 🌟 ✨（1〜2個まで）
・お客様名が分かれば「〇〇さん」と呼ぶ
・テンプレートの構成・意図は変えず、お客様の状況に合った言葉に変換する
・希望条件がある場合: テンプレート内の駅名・エリア名・間取り・家賃などのプレースホルダーや一般的な表現を、お客様の実際の希望条件に置き換える（例: 「○○駅」→ お客様の希望駅、「2LDK」→ お客様の希望間取り）
・返答は書き換えたテンプレートのテキストのみ（説明・補足は禁止）

【お客様情報】
・名前: ${customerName || "不明"}
・現在のフェーズ: ${stateLabel}
${conditionsSection}
【直近の会話】
${history || "なし"}

【書き換えるテンプレート】
${templateText}`;

  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const adapted = msg.content[0].type === "text" ? msg.content[0].text.trim() : templateText;
    return NextResponse.json({ ok: true, adapted });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI最適化エラー";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
