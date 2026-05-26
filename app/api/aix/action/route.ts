import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const MODEL = "claude-sonnet-4-6";

async function getPhrases(category: string, customerName?: string): Promise<string> {
  const { data } = await supabase
    .from("phrase_dictionary")
    .select("phrase")
    .eq("category", category)
    .order("priority", { ascending: false })
    .limit(15);
  const fallback = customerName || "お客様";
  return (data || []).map((r: { phrase: string }) =>
    `- ${r.phrase.replace(/\{\{customer_name\}\}/g, fallback)}`
  ).join("\n");
}

async function callClaude(system: string, user: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude error: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || "";
}

async function callClaudeVision(system: string, content: unknown[]): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`Claude Vision error: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || "";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, customer_name, image_url, condition_image_url, extra_input, parsed_estimate } = body;

    const name = customer_name ? `${customer_name}さん` : "お客様";

    // phrase_dictionary 取得（物件オススメ・内覧・申込のみ）
    const phraseCategoryMap: Record<string, string> = {
      property_recommendation: "property_recommendation",
      viewing_invite: "viewing_invite",
      application_push: "application_push",
    };
    const phraseCategory = phraseCategoryMap[action];
    const phraseText = phraseCategory ? await getPhrases(phraseCategory, customer_name) : "";

    let message_text = "";
    let parsed_estimate_result = null;

    // ── 🏠 物件オススメ ───────────────────────────────────────────
    if (action === "property_recommendation") {
      if (!image_url) throw new Error("物件資料画像が必要です");

      const system = `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
お客様の条件スクショと物件資料の2枚の画像を見て、スモラ風のLINEメッセージを作成してください。

【作成ルール】
・お客様の条件に合っている点を具体的に伝える（築年数・広さ・駅距離など数字で）
・曖昧な表現禁止（「築浅」→「2023年築」など具体的に）
・最後に内覧を自然に促す一言を添える
・感嘆符は「！！」を使う（スモラスタイル）

【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字はこの5つだけ：😊 😌 🙇‍♀️ 🌟 ✨
▼ 上記以外は一切禁止：🙏 ⭐️ 🏠 💰 💪 👍 🔍 ✋ その他すべて禁止
▼ 絵文字は1〜2個まで。文末か文の区切りにのみ置く。
🌟✨ → 物件の冒頭・オススメ強調、😊😌 → 誘導・締めの一言

【スモラの言葉・表現（参考にして自然に組み込んでください）】
${phraseText || "なし"}`;

      const content = [
        { type: "text", text: `${name}へのメッセージを作成してください。${extra_input ? `\nおすすめポイント: ${extra_input}` : ""}` },
        ...(condition_image_url ? [{ type: "image", source: { type: "url", url: condition_image_url } }] : []),
        { type: "image", source: { type: "url", url: image_url } },
      ];

      message_text = await callClaudeVision(system, content);

    // ── 💰 見積書送る ─────────────────────────────────────────────
    } else if (action === "estimate_sheet") {
      let estimate = parsed_estimate;

      if (!estimate) {
        if (!image_url) throw new Error("見積書画像が必要です");

        const ocrSystem = `見積書画像から初期費用の項目と金額をJSON形式で抽出してください。
形式: {"敷金": "XXX円", "礼金": "XXX円", "仲介手数料": "XXX円", ...}
金額が不明な項目は除外する。数字は正確に読み取る。`;

        const raw = await callClaudeVision(ocrSystem, [
          { type: "text", text: "この見積書の内訳を抽出してください。" },
          { type: "image", source: { type: "url", url: image_url } },
        ]);

        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          try { estimate = JSON.parse(match[0]); } catch { estimate = { 内訳: raw }; }
        } else {
          estimate = { 内訳: raw };
        }
      }

      const lines = Object.entries(estimate as Record<string, string>)
        .map(([k, v]) => `・${k}：${v}`)
        .join("\n");

      const system = `不動産営業のアシスタントとして、初期費用の内訳をお客様にLINEで伝えるメッセージを作成してください。フレンドリーで分かりやすく、絵文字も適度に使ってください。`;
      const user = `${name}へ。\n\n初期費用の内訳:\n${lines}${extra_input ? `\n\n補足: ${extra_input}` : ""}`;

      message_text = await callClaude(system, user);
      parsed_estimate_result = estimate;

    // ── 🔍 内覧へ！ ──────────────────────────────────────────────
    } else if (action === "viewing_invite") {
      const system = `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
お客様に内覧のお誘いメッセージを作成してください。

【作成ルール】
・自然な流れで内覧を促す
・日程調整をお客様に投げかける
・感嘆符は「！！」を使う（スモラスタイル）

【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字はこの5つだけ：😊 😌 🙇‍♀️ 🌟 ✨
▼ 上記以外は一切禁止：🙏 ⭐️ 🏠 💰 💪 👍 🔍 ✋ その他すべて禁止
▼ 絵文字は1〜2個まで。😊😌 → 余裕を示してリードする場面

【スモラの言葉・表現（参考にして自然に組み込んでください）】
${phraseText || "なし"}`;

      message_text = await callClaude(system, `${name}への内覧お誘いメッセージ。${extra_input ? `候補日時: ${extra_input}` : ""}`);

    // ── ✋ 申込へ！ ──────────────────────────────────────────────
    } else if (action === "application_push") {
      const system = `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
お客様の申込を後押しするLINEメッセージを作成してください。

【作成ルール】
・責任感を持って前向きに申込を促す
・「お部屋おさえさせて頂きます」など具体的なアクションを伝える
・感嘆符は「！！」を使う（スモラスタイル）

【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字はこの5つだけ：😊 😌 🙇‍♀️ 🌟 ✨
▼ 上記以外は一切禁止：🙏 ⭐️ 🏠 💰 💪 👍 ✋ その他すべて禁止
▼ 絵文字は1〜2個まで。😊😌 → 背中を押す・締めの一言

【スモラの言葉・表現（参考にして自然に組み込んでください）】
${phraseText || "なし"}`;

      message_text = await callClaude(system, `${name}への申込後押しメッセージ。${extra_input ? `補足: ${extra_input}` : ""}`);

    } else {
      return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      message_text,
      ...(parsed_estimate_result ? { parsed_estimate: parsed_estimate_result } : {}),
    });
  } catch (err) {
    console.error("[aix/action]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
