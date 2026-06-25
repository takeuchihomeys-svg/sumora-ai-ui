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
    .slice(-15)
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
    ? `\n【お客様の希望条件（DB登録済み）】\n${customerConditions}\n`
    : "";

  // 直近のお客様メッセージを抽出（最新3件）
  const recentCustomerRequests = (recentMessages || [])
    .filter(m => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
    .slice(-3)
    .map(m => m.text)
    .join(" / ");

  const prompt = `あなたはスモラ（賃貸仲介サービス）のLINE営業担当です。
以下のテンプレートの「プレースホルダー（○○・アカウント名・〇月〇日・特にオススメの理由など）」を、お客様情報・会話履歴を使って具体的な値に置き換えてください。

━━━━━━━━━━━━━━━━━━━━
【絶対ルール — 構造を壊さない】
━━━━━━━━━━━━━━━━━━━━
・テンプレートの段落数・行数・文章の流れを一切変えない
・新しい文章・説明・段落を追加しない（テンプレートにない内容は書かない）
・テンプレート内の文は省略も削除もしない（全行を残す）
・やることは「○○・〇月・アカウント名 などのプレースホルダーを具体的な値に置き換える」だけ
・具体的な値が不明なプレースホルダーは「〇〇」のままにしておく（でたらめな値を入れない）

━━━━━━━━━━━━━━━━━━━━
【スモラ品質ルール】
━━━━━━━━━━━━━━━━━━━━
・感嘆符は「！！」（全角2つ）のみ使用。「!」「！」1つは絶対禁止
${noEmoji ? "・絵文字は一切使用しない（テンプレートに絵文字があっても全て削除）" : "・使える絵文字: 😊 😌 🙇‍♀️ 🌟 ✨（1〜2個まで。テンプレートに絵文字がなければ追加不要）"}
・お客様名は「${customerName || "〇〇"}さん」と完全な名前で呼ぶ（アカウント名→${customerName || "〇〇"}さん に置換）

━━━━━━━━━━━━━━━━━━━━
【絶対禁止事項】
━━━━━━━━━━━━━━━━━━━━
・Wi-Fi無料・インターネット無料・エアコン付きなどの設備を「月額○円お得」「月額費用を抑えられます」のような金額換算表現で書かない（根拠のない数字になるため絶対禁止）
・「申し訳ございません」「失礼いたしました」などの謝罪表現
・テンプレートにない追加アピール・説明・感想を自分で加えない

━━━━━━━━━━━━━━━━━━━━
【プレースホルダーの置き換え方】
━━━━━━━━━━━━━━━━━━━━
以下の優先順で、具体的な値を会話履歴から探して置き換える。

① 会話履歴に出てきた具体的な情報（物件名・家賃・間取り・退去予定日など）を最優先で使う
② お客様の希望条件（DB）に記載の駅名・間取り・家賃・こだわりを使う
③ 見つからない場合は「〇〇」のままにする（推測で数字を作らない）

━━━━━━━━━━━━━━━━━━━━
【お客様情報】
━━━━━━━━━━━━━━━━━━━━
・名前: ${customerName || "不明"}
・現在のフェーズ: ${stateLabel}
${conditionsSection}
【お客様の直近の発言】
${recentCustomerRequests || "なし"}

【直近の会話履歴（物件情報・退去予定日などはここから読み取る）】
${history || "なし"}

━━━━━━━━━━━━━━━━━━━━
【置き換えるテンプレート】
━━━━━━━━━━━━━━━━━━━━
${templateText}

━━━━━━━━━━━━━━━━━━━━
出力は置き換え後のテキストのみ。説明・前置き・補足コメントは一切書かない。`;

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
