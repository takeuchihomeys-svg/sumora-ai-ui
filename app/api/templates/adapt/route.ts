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
    noEmoji,
  } = await req.json() as {
    templateText: string;
    customerName?: string;
    conversationState?: string;
    recentMessages?: Array<{ sender: string; text: string; imageUrl?: string }>;
    customerConditions?: string;
    noEmoji?: boolean;
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

  // 直近のお客様メッセージを抽出（最新3件）
  const recentCustomerRequests = (recentMessages || [])
    .filter(m => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
    .slice(-3)
    .map(m => m.text)
    .join(" / ");

  const prompt = `あなたはスモラ（賃貸仲介サービス）のLINE営業担当です。
以下のテンプレートをこのお客様・この状況に合わせて自然に書き換えてください。

【絶対ルール】
・文体・トーンはスモラのLINEスタイルを維持（親しみやすく、熱意あり）
・感嘆符は「！！」（「!」「！」1つは禁止）
${noEmoji ? "・絵文字は一切使用しない（テンプレートに絵文字があっても全て削除）" : "・使える絵文字: 😊 😌 🙇‍♀️ 🌟 ✨（1〜2個まで）"}
・お客様名が分かれば「〇〇さん」と呼ぶ
・テンプレートの構成・流れは変えない
・返答は書き換えたテキストのみ（説明・補足・前置きは一切禁止）

【最重要: 〇〇・プレースホルダーの置き換え方】
テンプレート内の「〇〇」「アカウント名」「特にオススメの理由」などの曖昧な表現は、
以下の優先順で具体的な内容に置き換えること：

① お客様の直近の発言・要望を最優先で反映する
   例: お客様が「収納がもっとほしい」と言った → 「収納スペースが充実している点」を具体的にアピール
   例: お客様が「駅近がいい」と言った → 「駅徒歩○分の立地」を前面に出す

② 希望条件（DB）に記載の駅名・間取り・家賃・こだわりを使う

③ 会話の流れから読み取れるお客様の温度感・懸念点を反映する

【お客様情報】
・名前: ${customerName || "不明"}
・現在のフェーズ: ${stateLabel}
${conditionsSection}
【お客様の直近の発言（最重要・必ず反映）】
${recentCustomerRequests || "なし"}

【直近の会話（前後の文脈）】
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
