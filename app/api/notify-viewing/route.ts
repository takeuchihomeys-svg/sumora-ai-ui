import { NextRequest, NextResponse, after } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { upsertKnowledge, generateEmbedding } from "@/app/lib/knowledge-utils";
import Anthropic from "@anthropic-ai/sdk";

// after() 内のバックグラウンド実行のため上限を明示（SDKデフォルトはリトライ2回・タイムアウト10分と長い）
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
  maxRetries: 1,
  timeout: 30_000,
});

// 内覧・申込・契約確定後に成功パターンを学習してai_reply_knowledgeへ保存
async function recordSuccessPattern(conversationId: string, eventType: string): Promise<void> {
  try {
    const eventLabel: Record<string, string> = {
      viewing: "内覧予約", contract: "契約", application: "申込", key_handover: "鍵渡し",
    };
    const label = eventLabel[eventType] ?? eventType;

    // ─── 重複実行ガード: 同一会話で10分以内に学習済みならスキップ ───
    // 二重クリック・クライアントリトライで同じ viewing 情報の POST が複数来ても
    // Haiku分析＋knowledge保存が重複実行されないようにする
    const { data: convGuard } = await supabase
      .from("conversations")
      .select("success_pattern_at")
      .eq("id", conversationId)
      .maybeSingle();
    const lastLearnedAt = convGuard?.success_pattern_at
      ? new Date(convGuard.success_pattern_at as string).getTime()
      : 0;
    if (Date.now() - lastLearnedAt < 10 * 60 * 1000) {
      console.log(`[recordSuccessPattern] skipped: learned within 10min (${conversationId})`);
      return;
    }
    // 先にマーカーを立てる（並行二重実行の抑止・カラム未作成でも既存処理は続行）
    await supabase.from("conversations")
      .update({ success_pattern_at: new Date().toISOString() })
      .eq("id", conversationId);

    // 直近の会話を取得（最大40件）
    const { data: msgs } = await supabase
      .from("messages")
      .select("sender, text, created_at")
      .eq("conversation_id", conversationId)
      .neq("text", "[画像]").neq("text", "[動画]")
      .not("text", "is", null)
      .order("created_at", { ascending: false })
      .limit(40);

    if (!msgs || msgs.length === 0) return;

    const history = (msgs as Array<{ sender: string; text: string }>)
      .reverse()
      .map((m) => `${m.sender === "customer" ? "お客さん" : "スタッフ"}: ${(m.text ?? "").slice(0, 150)}`)
      .join("\n");

    // Haikuで成功パターンを分析
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{
        role: "user",
        content: `以下の賃貸仲介LINEの会話で「${label}」が決まりました。
この会話でお客さんが${label}に至った決め手・スタッフの対応パターンを3行以内で要約してください。
「★決まるパターン:」で始め、次回同じ状況のお客さんへの示唆を含めること。
顧客名・物件名・住所は出力に含めないこと（「お客さん」「物件」など一般化した表現に置き換える）。
会話からパターンを抽出できない場合（会話が短い・決め手が読み取れない等）は「null」とだけ出力すること（推測でパターンを作らない）。

【会話履歴】
${history}

出力: ★決まるパターン: から始まる3行以内の文章のみ（抽出不能時は null のみ）`,
      }],
    });

    const pattern = resp.content[0].type === "text" ? resp.content[0].text.trim() : null;
    // 出口: 抽出不能（null / 空文字 / ★決まるパターンで始まらない出力）は knowledge保存・ai_summary反映をスキップ
    if (!pattern || pattern.toLowerCase() === "null" || !pattern.startsWith("★決まるパターン")) return;

    // ai_reply_knowledgeに保存（#32: upsertKnowledge経由でdedup・importanceインフレ防止・embedding付与）
    const now = new Date().toISOString().slice(0, 10);
    const embedding = await generateEmbedding(pattern);
    const upsertResult = await upsertKnowledge(supabase, {
      title: `成約パターン_${label}_${now}`,
      content: pattern,
      category: "pattern",
      importance: 8,
      ...(embedding ? { embedding } : {}),
    });
    console.log(`[recordSuccessPattern] upsertKnowledge: ${upsertResult} (${label})`);

    // 紐付き顧客のai_summaryにも★決まるパターンを上書き反映
    const { data: conv } = await supabase
      .from("conversations")
      .select("property_customer_id")
      .eq("id", conversationId)
      .maybeSingle();
    if (conv?.property_customer_id) {
      const { data: pc } = await supabase
        .from("property_customers")
        .select("ai_summary")
        .eq("id", conv.property_customer_id as string)
        .maybeSingle();
      if (pc) {
        const oldSummary: string = (pc.ai_summary as string) ?? "";
        // 既存の★決まるパターン行を置換、なければ末尾に追加
        const updated = oldSummary.match(/★決まるパターン/)
          ? oldSummary.replace(/★決まるパターン[：:][\s\S]*/, pattern)
          : `${oldSummary}\n${pattern}`.trim();
        await supabase.from("property_customers")
          .update({ ai_summary: updated, ai_summary_at: new Date().toISOString() })
          .eq("id", conv.property_customer_id as string);
      }
    }
  } catch (e) {
    console.error("[recordSuccessPattern] error:", e);
  }
}

// 日付文字列 (YYYY-MM-DD) を JST 基準で「今日」「明日」「○月○日」に変換
function getDateLabel(dateStr: string): string {
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstNow = new Date(now.getTime() + jstOffset);
  const jstToday = jstNow.toISOString().slice(0, 10);
  const jstTomorrow = new Date(jstNow.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  if (dateStr === jstToday) return "今日";
  if (dateStr === jstTomorrow) return "明日";
  const m = parseInt(dateStr.slice(5, 7));
  const d = parseInt(dateStr.slice(8, 10));
  return `${m}月${d}日`;
}

// HH:MM を「○時〜」に変換
function getTimeLabel(time: string): string {
  if (!time) return "";
  const [h, m] = time.split(":");
  const min = m === "00" ? "" : `${m}分`;
  return `${parseInt(h)}時${min}〜`;
}

const EVENT_LABEL: Record<string, string> = {
  viewing: "内覧",
  contract: "契約",
  key_handover: "鍵渡し",
  application: "申込",
  other: "対応",
};

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;

  try {
    const { customer_name, event_type, date, time, notes, conversation_id } = await req.json() as {
      customer_name: string;
      event_type: string;
      date: string;
      time?: string;
      notes?: string;
      conversation_id?: string;
    };

    if (!customer_name || !event_type || !date) {
      return NextResponse.json({ ok: false, error: "required fields missing" }, { status: 400 });
    }

    const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
    if (!token) {
      return NextResponse.json({ ok: false, error: "LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN not set" }, { status: 500 });
    }

    // グループID取得（env優先 → DBフォールバック）
    let groupId = process.env.LINE_STAFF_GROUP_ID ?? null;
    if (!groupId) {
      const { data } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").single();
      groupId = (data?.value as string) ?? null;
    }
    if (!groupId) {
      return NextResponse.json({ ok: false, error: "group_id not configured" }, { status: 500 });
    }

    const dateLabel = getDateLabel(date);
    const timeLabel = time ? getTimeLabel(time) : "";
    const eventLabel = EVENT_LABEL[event_type] ?? "対応";
    const notesText = notes ? `\n${notes}` : "";

    // 「今日Kさん16時〜内覧お願い！\n連帯保証人で契約の場合の流れ説明…」
    const text = `${dateLabel}${customer_name}さん${timeLabel}${eventLabel}お願い！${notesText}`;

    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: groupId, messages: [{ type: "text", text }] }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[notify-viewing] LINE push error:", errText);
      return NextResponse.json({ ok: false, error: errText }, { status: 500 });
    }

    // 内覧・申込・契約確定 → 成功パターンをレスポンス送信後に学習（after=Vercelのレスポンス後も実行保証）
    if (conversation_id && ["viewing", "application", "contract"].includes(event_type)) {
      after(recordSuccessPattern(conversation_id, event_type));
    }

    return NextResponse.json({ ok: true, text });
  } catch (e) {
    console.error("[notify-viewing] error:", e);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
