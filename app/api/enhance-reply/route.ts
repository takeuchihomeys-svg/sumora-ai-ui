import { NextRequest, NextResponse } from "next/server";

const ENHANCE_SYSTEM = `
あなたは賃貸仲介サービス「スモラ」のLINE文章改善AIです。
スタッフが入力した下書き・単語・メモをもとに、スモラらしい完成されたLINEメッセージに仕上げてください。

【スモラのLINEスタイル】
・丁寧・親しみやすい・信頼感
・こちらが動く姿勢を示す（「確認します」「ピックアップします」等）
・お客様の名前が分かれば「〇〇さん」と呼ぶ
・感嘆符は「！！」（スモラスタイル）
・営業感が強すぎない・押しつけがましくない

【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字はこの5つだけ：😊 😌 🙇‍♀️ 🌟 ✨
▼ 上記以外は一切禁止：🙏 ⭐️ 🏠 💰 💪 👍 🔍 ✋ 👏 🎉 その他すべて禁止
▼ 絵文字は1〜2個まで。文末か文の区切りにのみ置く。

各絵文字の使い分け：
・😊 😌 → 余裕を示しながらリードする場面
・🙇‍♀️ → 連絡が遅れた時・男性客で冒頭に使う
・🌟 ✨ → 物件紹介の冒頭・オススメ強調のみ

【出力ルール】
・LINEでそのまま送れる完成文のみを出力する
・解説・補足・括弧書きは禁止
・候補は1つだけ
`.trim();

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });

  const { currentDraft, conversationState, customerName, recentMessages } = await req.json() as {
    currentDraft: string;
    conversationState?: string;
    customerName?: string;
    recentMessages?: Array<{ sender: string; text: string }>;
  };

  if (!currentDraft?.trim()) {
    return NextResponse.json({ ok: false, error: "currentDraft required" }, { status: 400 });
  }

  const history = (recentMessages || [])
    .slice(-15)
    .filter((m) => m.text && m.text !== "[画像]" && m.text !== "[動画]")
    .map((m) => `${m.sender === "customer" ? "お客様" : "スモラ"}: ${m.text}`)
    .join("\n");

  const nameNote = customerName ? `お客様名：${customerName}さん` : "";
  const stateNote = conversationState ? `現在の営業フェーズ：${conversationState}` : "";

  const userPrompt = `
${nameNote}
${stateNote}

【直近の会話】
${history || "なし"}

【スタッフが入力した下書き・単語・メモ】
${currentDraft.trim()}

上記の下書きをスモラスタイルの完成LINEメッセージに仕上げてください。
`.trim();

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: ENHANCE_SYSTEM,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ ok: false, error: err }, { status: 500 });
    }

    const data = await res.json() as { content?: Array<{ text: string }> };
    const enhanced = data.content?.[0]?.text?.trim() || "";

    return NextResponse.json({ ok: true, enhanced });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
