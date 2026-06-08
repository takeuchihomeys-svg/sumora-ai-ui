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

// 物件オススメの実例（☆つき）を取得してAIの参考文として返す
async function getPropertyExamples(): Promise<string> {
  const { data } = await supabase
    .from("ai_reply_examples")
    .select("sent_reply")
    .in("conversation_state", ["property_recommendation", "proposing"])
    .eq("is_starred", true)
    .order("created_at", { ascending: false })
    .limit(12);
  if (!data || data.length === 0) return "";
  return (data as { sent_reply: string }[])
    .map((r, i) => `【実例${i + 1}】\n${r.sent_reply}`)
    .join("\n\n---\n\n");
}

// aix_settings からシステムプロンプトを取得（なければデフォルト）
async function getAixSystemPrompt(key: string, defaultValue: string): Promise<string> {
  const { data } = await supabase
    .from("aix_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return data?.value ?? defaultValue;
}

// 物件オススメ関連のknowledgeを取得
async function getPropertyKnowledge(): Promise<string> {
  const { data } = await supabase
    .from("ai_reply_knowledge")
    .select("category, title, content, importance")
    .in("conversation_state", ["property_recommendation", "proposing"])
    .gte("importance", 7)
    .order("importance", { ascending: false })
    .limit(15);
  if (!data || data.length === 0) return "";
  return (data as { category: string; title: string; content: string }[])
    .map((r) => `[${r.category}] ${r.title}: ${r.content}`)
    .join("\n");
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
      max_tokens: 4096,
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
      max_tokens: 4096,
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
    const { action, account, customer_name, image_url, condition_image_url, customer_conditions, extra_input, parsed_estimate } = body;

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

      // 実例・knowledge・DBプロンプトを並列取得
      const DEFAULT_PROP_SYSTEM = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件資料の画像を読み取り、スモラスタイルのオススメ物件メッセージを作成してください。

━━━━━━━━━━━━━━━━━━━━━━━━
【最重要 — 黄金実例】この文体・テンポ・言い回しを完全に再現すること

🌟淡路第3ダイヤモンドハイム

ゆうあさんご希望の条件に近い2DKのお部屋となっております！！

（オススメポイント）
・管理費込63,000円
・間取り：2DK（洋室6帖・洋室4.5帖・DK7帖）
・JR淡路駅 徒歩7分 ・阪急淡路駅 徒歩10分
・敷地内駐車場月額22,000円
・エレベーター付き・最上階

家賃管理費込63,000円
駐車場費用込で月々85,000円と
かなり条件が良くゆうあさんにオススメ出来るお部屋となります！！

ゆうあさんお気に召されましたら、ゆうあさんご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！

━━━━━━━━━━━━━━━━━━━━━━━━

{{examples}}

【出力構成 — 黄金実例と同じ構成で出力すること】

🌟[物件名]

[お客様名]さんご希望の条件に近い[間取り]のお部屋となっております！！

（オススメポイント）
・[管理費込み家賃（例：管理費込63,000円）]
・間取り：[間取り詳細（例：2DK（洋室6帖・洋室4.5帖・DK7帖））]
・[最寄り駅名] 徒歩[X]分 ・[2番目の駅名] 徒歩[X]分
・[特徴1（駐車場・バルコニー・設備など）]
・[特徴2（エレベーター・最上階・築年など）]

[家賃の行]
[駐車場込の月額合計の行（駐車場がない場合は省略）]と
かなり条件が良く[お客様名]さんにオススメ出来るお部屋となります！！

[お客様名]さんお気に召されましたら、[お客様名]さんご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！

【絶対ルール】
・以下の3フレーズは一字一句そのまま使うこと（変えない）：
  ①「〜のお部屋となっております！！」
  ②「かなり条件が良く〜さんにオススメ出来るお部屋となります！！」
  ③「〜さんお気に召されましたら、〜さんご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！」
・物件名は先頭に必ず🌟
・絵文字は 😊 のみ・1個・締め文のみ（他の絵文字は全禁止）
・「！！」（全角感嘆符2つ）を使う
・数字は必ず具体的に（「63,000円」「徒歩7分」「6帖」「22,000円」）
・（オススメポイント）は3〜5項目
・アピール文は「家賃管理費込○○円\n駐車場費用込で月々○○円と」の形式（駐車場なければ省略）
・「ぜひ」「よろしければ」「いかがでしょうか」「ご確認ください」「ご査収」などのAI的表現は一切使わない
・実例にない新しい言い回しは作らない

{{knowledge}}

{{phrases}}`;

      const [examples, knowledge, systemTemplate] = await Promise.all([
        getPropertyExamples(),
        getPropertyKnowledge(),
        getAixSystemPrompt("property_recommendation", DEFAULT_PROP_SYSTEM),
      ]);

      // {{examples}} {{knowledge}} {{phrases}} を実データに置換
      const system = systemTemplate
        .replace("{{examples}}", examples ? `【スモラの実際の物件オススメ文（実例）】\n${examples}` : "")
        .replace("{{knowledge}}", knowledge ? `【物件オススメ時のノウハウ】\n${knowledge}` : "")
        .replace("{{phrases}}", phraseText ? `【よく使うフレーズ】\n${phraseText}` : "");

      const conditionsText = customer_conditions as string | undefined;
      const userText = `${name}へのオススメ物件メッセージを作成してください。${conditionsText ? `\n\nお客様の希望条件:\n${conditionsText}` : ""}${extra_input ? `\n追加情報: ${extra_input}` : ""}`;

      const content = [
        { type: "text", text: userText },
        ...(condition_image_url ? [{ type: "image", source: { type: "url", url: condition_image_url } }] : []),
        { type: "image", source: { type: "url", url: image_url } },
      ];

      message_text = await callClaudeVision(system, content);

    // ── 💰 見積書送る ─────────────────────────────────────────────
    } else if (action === "estimate_sheet") {
      let estimate = parsed_estimate;

      if (!estimate) {
        if (!image_url) throw new Error("見積書画像が必要です");

        const ocrSystem = `見積書画像から以下の項目をJSONで抽出してください。
数値は整数のみ（円・¥・カンマは除く）。不明な項目は0または空文字。
{
  "property_name": "物件名（マンション名のみ、号室は含めない）",
  "room_number": "号室番号のみ（例: 502）",
  "rent": 月額家賃（整数）,
  "total": 初期費用合計（割引後・整数）,
  "discount": 割引額（なければ0）,
  "commission": 仲介手数料税抜（なければ0）,
  "commission_tax": 仲介手数料消費税（なければ0）
}`;

        const raw = await callClaudeVision(ocrSystem, [
          { type: "text", text: "この見積書から指定の項目を抽出してください。" },
          { type: "image", source: { type: "url", url: image_url } },
        ]);

        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          try { estimate = JSON.parse(match[0]); } catch { estimate = {}; }
        } else {
          estimate = {};
        }
      }

      // アカウント名マッピング
      const ACCOUNT_NAMES: Record<string, string> = {
        sumora: "スモラ",
        ieyasu: "イエヤス",
        giga:   "ギガ賃貸",
      };
      const accountName = ACCOUNT_NAMES[String(account || "sumora")] ?? "スモラ";

      // 固定フォーマットでテキスト生成（estimate/page.tsx の generateLineText と同じロジック）
      const est = estimate as Record<string, unknown>;
      const propertyName = String(est.property_name || "");
      const roomNumber   = String(est.room_number   || "");
      const total        = Number(est.total          || 0);
      const discount     = Number(est.discount       || 0);
      const rent         = Number(est.rent           || 0);
      const commission   = Number(est.commission     || 0);
      const commTax      = Number(est.commission_tax || 0);

      const standardCommission = Math.round(rent * 1.1);
      const actualCommission   = commission + commTax;
      const savings = Math.max(0, standardCommission - actualCommission + discount);

      const parts: string[] = [];

      if (propertyName || roomNumber) {
        const roomSuffix = roomNumber ? ` ${roomNumber}号室` : "";
        parts.push(`【${propertyName}${roomSuffix}】`);
        parts.push("");
      }

      if (discount > 0) {
        parts.push("初期費用さらに");
        parts.push(`🌟${discount.toLocaleString()}円割引させて頂き`);
        parts.push(`初期費用：${total.toLocaleString()}円`);
      } else if (total > 0) {
        parts.push(`初期費用：${total.toLocaleString()}円`);
      }

      parts.push("");

      if (savings > 0) {
        parts.push(`${accountName}なら一般的な不動産業者より${savings.toLocaleString()}円節約出来ます！！`);
        parts.push("");
      }

      parts.push("※ご入居日によって日割家賃が発生致します。");

      message_text = parts.join("\n");
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
      // ☆つき申込実例を取得
      const { data: applyExamples } = await supabase
        .from("ai_reply_examples")
        .select("customer_message, sent_reply")
        .in("conversation_state", ["applying", "application", "screening", "contract"])
        .eq("is_starred", true)
        .order("created_at", { ascending: false })
        .limit(8);

      const examplesText = (applyExamples || []).length > 0
        ? "\n\n【⭐ スモラの実際の申込後押し例（文体・テンポ・感嘆符・絵文字をこれに合わせる）】\n" +
          (applyExamples as { customer_message: string; sent_reply: string }[])
            .map((r, i) => `[例${i + 1}]\nお客様:「${r.customer_message}」\nスモラ:「${r.sent_reply}」`)
            .join("\n\n")
        : "";

      const system = `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
お客様の申込を後押しするLINEメッセージを作成してください。

【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字：😊 😌 🙇‍♀️ 🌟 ✨ のみ（他は全禁止）
▼ 絵文字は1〜2個まで。😊😌 → 背中を押す・締めの一言
▼ 感嘆符は「！！」（スモラスタイル）

【スモラの言葉・表現】
${phraseText || "なし"}${examplesText}`;

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
