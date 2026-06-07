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

      const system = `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
物件資料の画像を読み取り、以下の【出力フォーマット】に従ってLINEメッセージを生成してください。

【出力フォーマット — 必ずこの構造を守ること】

🌟 {物件名}　{号室}

{お客様名}に特にオススメ出来るお部屋となります！！

（オススメポイント）
・{家賃（管理費込の場合は「家賃管理費込○○円」、別の場合は「家賃○○円／管理費○○円」）}
・{築年月（例：2018年1月築）}
・{最寄り駅}徒歩{○}分
・{広さ}と{広め/コンパクト等}の{間取り}
・敷金礼金{0/あり等}
・{特筆設備1（Wi-Fi無料など）}
※オススメポイントは物件資料から読み取れる重要事項を5〜7項目

{間取り・広さの魅力を1文}！！
{セキュリティ・設備の充実を1文}！！
{設備詳細（洗濯機置場・コンロ等）を1文}！！
{敷金礼金0など初期費用メリットを1文（該当する場合）}！！

{お客様名}にかなりオススメ出来る条件のお部屋となります😊！！
{空室状況・退去予定・競争率など緊急性を1文（情報があれば）}！！
{お客様名}お気に召されましたらお申込しお部屋抑えさせて頂きます！！

お手隙の際にご査収ください😌！！

【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字：😊 😌 🙇‍♀️ 🌟 ✨ のみ
▼ 上記以外は一切禁止（🏠 💰 🔑 ⭐ 等すべて禁止）
▼ 冒頭の🌟と末尾の😊😌の計2〜3個のみ

【数字の読み取りルール】
・家賃・管理費は必ず円単位の数字で（「7万円」→「70,000円」）
・築年月は「○○年○月築」の形式で
・駅徒歩は「徒歩○分」の形式で
・広さは「○○帖」または「○○㎡」で

【スモラの言葉・表現（自然に組み込む）】
${phraseText || "なし"}`;

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
