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
以下のテンプレートを、お客様情報・会話履歴をもとにこの物件・このお客様専用の文章に仕上げてください。

━━━━━━━━━━━━━━━━━━━━
【絶対ルール — 構造を壊さない】
━━━━━━━━━━━━━━━━━━━━
・テンプレートの段落数・行数・文章の大きな流れを変えない
・新しい段落・まったく新しい話題を追加しない
・テンプレート内の文は省略・削除しない

━━━━━━━━━━━━━━━━━━━━
【やること — 2種類の具体化】
━━━━━━━━━━━━━━━━━━━━

① 明示的プレースホルダーを具体的な値に置き換える
   例: ○月○ → 「7月末」、アカウント名 → 「${customerName || "〇〇"}さん」、〇〇円 → 「74,000円」

② 曖昧な表現を、この物件・このお客様に合った具体的な内容に書き換える
   以下のような表現が対象（テンプレートに登場した場合のみ変更する）：
   ・「条件が良いお部屋」→ 会話から読み取った物件の強みを入れる（例:「エアコン付き・敷金礼金0でかなり条件の良いお部屋」）
   ・「オススメポイント」「特にオススメの理由」「ご希望に合った点」→ 物件の具体的な強み（家賃・間取り・駅徒歩・設備など）に書き換える
   ・「ご上限に近い家賃」「ご予算内」→ 実際の家賃金額を入れる
   ※ 具体的な情報が会話履歴にない場合は元の曖昧表現のままにする（でたらめな値を入れない）

━━━━━━━━━━━━━━━━━━━━
【スモラ品質ルール】
━━━━━━━━━━━━━━━━━━━━
・感嘆符は「！！」（全角2つ）のみ使用。「!」「！」1つは絶対禁止
${noEmoji ? "・絵文字は一切使用しない（テンプレートに絵文字があっても全て削除）" : "・使える絵文字: 😊 😌 🙇‍♀️ 🌟 ✨（1〜2個まで。テンプレートに絵文字がなければ追加不要）"}
・お客様名は「${customerName || "〇〇"}さん」と完全な名前で呼ぶ

━━━━━━━━━━━━━━━━━━━━
【絶対禁止事項】
━━━━━━━━━━━━━━━━━━━━
・Wi-Fi無料・インターネット無料・エアコン付きなどの設備を「月額○円お得」「月額費用を抑えられます」のような金額換算表現で書かない
・「申し訳ございません」「失礼いたしました」などの謝罪表現
・テンプレートにない全く新しい段落・話題を追加しない

━━━━━━━━━━━━━━━━━━━━
【情報の優先順位】
━━━━━━━━━━━━━━━━━━━━
① 会話履歴に出てきた物件の具体情報（物件名・家賃・間取り・駅徒歩・設備・退去予定日など）を最優先
② お客様の希望条件（DB）に記載のこだわり・条件を反映
③ 見つからない場合はそのまま or 「〇〇」のまま残す

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
      model: "claude-opus-4-8",
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
