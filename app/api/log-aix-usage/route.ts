import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

// POST /api/log-aix-usage
// AIX送信時にどのAIX+テンプレートを使ったか記録する（analyze-aix-flowで分析に使用）

const AIX_TYPE_LABELS: Record<string, string> = {
  property_send:            "物件紹介を送った",
  viewing_invite:           "内覧に誘った",
  property_recommendation:  "物件おすすめ文を送った",
  hearing:                  "ヒアリングした",
  follow_up:                "フォローアップした",
  application:              "申込み案内をした",
  document_request:         "書類案内をした",
  contract:                 "契約手続きを案内した",
  greeting:                 "初回挨拶を送った",
};

// next_action 予測 vs 実際の行動 のギャップを Haiku で分析し ai_reply_knowledge に保存
async function runGapAnalysis(opts: {
  predId: string;
  predictedAction: string;
  predictedAt: string;
  actualAixType: string;
  conversationId: string;
  customerId: string;
}): Promise<void> {
  const { predId, predictedAction, predictedAt, actualAixType, conversationId, customerId } = opts;

  // 予測後〜AIX送信までの間のメッセージ（文脈変化の把握）
  const { data: msgs } = await supabase
    .from("messages")
    .select("sender, text, created_at")
    .eq("conversation_id", conversationId)
    .gt("created_at", predictedAt)
    .neq("text", "[画像]")
    .not("text", "is", null)
    .order("created_at", { ascending: true })
    .limit(15);

  const actualLabel = AIX_TYPE_LABELS[actualAixType] ?? actualAixType;
  const msgContext = (msgs ?? []).length > 0
    ? (msgs as Array<{ sender: string; text: string }>)
        .map(m => `${m.sender === "customer" ? "お客さん" : "スタッフ"}: ${(m.text || "").slice(0, 100)}`)
        .join("\n")
    : "（やりとりなし）";

  // 一致判定（簡易ベースライン）
  const matchKeywords: Record<string, string[]> = {
    viewing_invite:          ["内覧", "見学", "日程", "お部屋"],
    property_send:           ["物件", "ご紹介", "新着", "おすすめ"],
    property_recommendation: ["物件", "おすすめ", "おすすめ物件"],
    follow_up:               ["いかがでし", "確認", "どうでし", "感想"],
    application:             ["申込", "お申し込み", "申し込み"],
    document_request:        ["書類", "身分証", "連帯保証"],
  };
  const kw = matchKeywords[actualAixType] ?? [];
  const wasAccurate = kw.length > 0 && kw.some(k => predictedAction.includes(k));

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
  });

  const prompt = `賃貸仲介AIの「次のアクション予測」の精度改善分析をしてください。

【AIが予測した次のアクション】
${predictedAction}

【スタッフが実際に取ったアクション】
${actualLabel}（AIXボタン: ${actualAixType}）

【予測後〜実際のAIX送信までの会話】
${msgContext}

以下の形式で分析してください（JSONのみ・説明不要）：
{
  "was_accurate": ${wasAccurate ? "true" : "false"},
  "gap_summary": "予測と実際の差を1文で",
  "reason": "なぜスタッフが予測と違う行動を取ったかの原因（会話から読み取れる文脈変化など）",
  "learning_rule": "【状況】〜の場合 【正しいアクション】〜 【誤りやすい予測】〜 【理由】〜"
}`;

  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: "あなたは不動産営業AIの学習システムです。JSONのみで回答してください。",
    messages: [{ role: "user", content: prompt }],
  });

  const firstBlock = res.content[0];
  const rawText = firstBlock?.type === "text" ? firstBlock.text : "{}";

  let parsed: { was_accurate?: boolean; gap_summary?: string; reason?: string; learning_rule?: string } = {};
  try {
    const m = rawText.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch { /* ignore */ }

  const gapAnalysis = [
    parsed.gap_summary && `差分: ${parsed.gap_summary}`,
    parsed.reason && `原因: ${parsed.reason}`,
  ].filter(Boolean).join(" / ");

  // next_action_logs を更新
  await supabase.from("next_action_logs").update({
    validated: true,
    actual_aix_type: actualAixType,
    was_accurate: parsed.was_accurate ?? wasAccurate,
    gap_analysis: gapAnalysis || null,
    validated_at: new Date().toISOString(),
  }).eq("id", predId);

  // 学習ルールを ai_reply_knowledge に保存（ずれがある場合のみ）
  if (parsed.learning_rule && !(parsed.was_accurate ?? wasAccurate)) {
    const title = `next_action_rule_${customerId.slice(0, 8)}_${Date.now()}`;
    await supabase.from("ai_reply_knowledge").insert({
      title,
      category: "next_action_pattern",
      content: parsed.learning_rule,
      state: null,
      importance: 7, // HIGH-06修正: importance=3 は min_importance=7 フィルタで除外されるため 7 に引き上げ
      hypothesis_status: "hypothesis",
      apply_count: 0,
      correct_count: 0,
      wrong_count: 0,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      conversation_id: string;
      aix_type: string;
      template_id?: string | null;
      template_name?: string | null;
      template_category?: string | null;
      conversation_status?: string | null;
      suggested_action?: string | null;
      line_message_id?: string | null;
      sent_at?: string | null;
      previous_action_type?: string | null;
      check_pattern?: string | null;
      app_sub_mode?: string | null;
      send_mode?: string | null;
      generated_text?: string | null;
    };

    const { conversation_id, aix_type, template_id, template_name, template_category, conversation_status, suggested_action, line_message_id, sent_at, previous_action_type, check_pattern, app_sub_mode, send_mode, generated_text } = body;
    if (!conversation_id || !aix_type) {
      return NextResponse.json({ ok: false, error: "conversation_id and aix_type required" }, { status: 400 });
    }

    // PA-1: 前回AIXの確実な記録
    let previousAction: string | null = previous_action_type ?? null;
    if (!previousAction) {
      const { data: prevRow } = await supabase
        .from("aix_usage_logs")
        .select("aix_type")
        .eq("conversation_id", conversation_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      previousAction = (prevRow?.aix_type as string) ?? null;
    }

    const { error } = await supabase.from("aix_usage_logs").insert({
      conversation_id,
      aix_type,
      template_id: template_id ?? null,
      template_name: template_name ?? null,
      template_category: template_category ?? null,
      conversation_status: conversation_status ?? null,
      suggested_action: suggested_action ?? null,
      line_message_id: line_message_id ?? null,
      sent_at: sent_at ?? null,
      previous_action_type: previousAction,
      check_pattern: check_pattern ?? null,
      app_sub_mode: app_sub_mode ?? null,
      send_mode: send_mode ?? null,
      generated_text: generated_text ? generated_text.slice(0, 2000) : null,
    });

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    // ③ AIX送信後: property_customer_id を取得（要約再生成 + ギャップ分析に使う）
    const { data: convRow } = await supabase
      .from("conversations")
      .select("property_customer_id")
      .eq("id", conversation_id)
      .maybeSingle();
    const pcId = convRow?.property_customer_id as string | null;

    if (pcId) {
      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
        ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

      // AIX送信後に要約を再生成（状況最新化 / fire-and-forget）
      fetch(`${baseUrl}/api/customer-summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: pcId, conversation_id, fetch_from_db: true }),
      }).catch(() => {});

      // next_action ギャップ分析（直近の未検証予測を取得して比較 / fire-and-forget）
      const { data: predRow } = await supabase
        .from("next_action_logs")
        .select("id, predicted_action, predicted_at, conversation_id")
        .eq("customer_id", pcId)
        .eq("validated", false)
        .order("predicted_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (predRow) {
        // 二重処理防止のため先に validated=true にしてから非同期で分析
        await supabase.from("next_action_logs")
          .update({ validated: true, actual_aix_type: aix_type, validated_at: new Date().toISOString() })
          .eq("id", predRow.id as string);

        runGapAnalysis({
          predId:          predRow.id as string,
          predictedAction: predRow.predicted_action as string,
          predictedAt:     predRow.predicted_at as string,
          actualAixType:   aix_type,
          conversationId:  (predRow.conversation_id as string) ?? conversation_id,
          customerId:      pcId,
        }).catch(() => {});
      }
    }

    return NextResponse.json({ ok: true, previous_action_type: previousAction });
  } catch (e) {
    console.error("[log-aix-usage]", e);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
