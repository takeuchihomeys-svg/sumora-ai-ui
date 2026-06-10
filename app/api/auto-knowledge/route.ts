import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const STATE_NORMALIZE: Record<string, string> = {
  condition_hearing: "hearing", property_search: "hearing",
  property_recommendation: "proposing", viewing: "proposing",
  estimate_request: "proposing", availability_check: "proposing",
  application: "applying", screening: "applying", contract: "applying",
};

async function extractCorrectionRule(
  aiDraft: string,
  sentReply: string,
  state: string,
  customerMessage: string,
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return null;

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
        max_tokens: 150,
        system: `賃貸仲介LINEのAI文案とスタッフが実際に送った文を比較し、AIが間違えたポイントを1文で説明してください。
出力形式: 「AIは〜としたが、正しくは〜」（60字以内・具体的に）
変更が軽微（誤字修正・句読点・絵文字のみ）なら「SKIP」とだけ返してください。`,
        messages: [{
          role: "user",
          content: `【営業フェーズ】${state}
【お客様メッセージ】${customerMessage.slice(0, 100)}

【AIが生成した文】
${aiDraft.slice(0, 400)}

【スタッフが実際に送った文】
${sentReply.slice(0, 400)}`,
        }],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ text: string }> };
    const text = data.content?.[0]?.text?.trim() || "";
    if (!text || text.startsWith("SKIP") || text.length < 10) return null;
    return text;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      example_id?: string;
      aiDraft?: string;
      sentReply?: string;
      conversationState?: string;
      customerMessage?: string;
    };

    let aiDraft: string;
    let sentReply: string;
    let conversationState: string;
    let customerMessage: string;

    // example_id 指定: DBから実例データを取得（☆トリガー用）
    if (body.example_id) {
      const { data: ex } = await supabase
        .from("ai_reply_examples")
        .select("ai_draft, sent_reply, conversation_state, customer_message, was_ai_modified")
        .eq("id", body.example_id)
        .single() as { data: { ai_draft?: string | null; sent_reply: string; conversation_state: string; customer_message: string; was_ai_modified: boolean } | null };

      if (!ex || !ex.was_ai_modified || !ex.ai_draft) {
        return NextResponse.json({ ok: false, reason: "no ai modification found" });
      }
      aiDraft = ex.ai_draft;
      sentReply = ex.sent_reply;
      conversationState = ex.conversation_state;
      customerMessage = ex.customer_message;
    } else {
      // 直接フィールド指定（互換性維持）
      if (!body.aiDraft?.trim() || !body.sentReply?.trim()) {
        return NextResponse.json({ ok: false, reason: "missing fields" });
      }
      aiDraft = body.aiDraft;
      sentReply = body.sentReply;
      conversationState = body.conversationState ?? "hearing";
      customerMessage = body.customerMessage ?? "";
    }

    // AIと送信文が同じなら学習不要
    if (aiDraft.trim() === sentReply.trim()) {
      return NextResponse.json({ ok: false, reason: "no diff" });
    }

    // 差分が小さすぎる場合はスキップ（8文字未満の差分）
    if (Math.abs(aiDraft.length - sentReply.length) < 8) {
      return NextResponse.json({ ok: false, reason: "diff too small" });
    }

    const normalized = STATE_NORMALIZE[conversationState] ?? conversationState ?? "hearing";

    const rule = await extractCorrectionRule(aiDraft, sentReply, normalized, customerMessage);

    if (!rule) {
      return NextResponse.json({ ok: false, reason: "extraction skipped or failed" });
    }

    const { error } = await supabase.from("ai_reply_knowledge").insert({
      title: "差分学習 [自動]",
      category: "principle",
      importance: 9,
      conversation_state: normalized,
      content: rule,
    });

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, rule });
  } catch (e) {
    console.error("auto-knowledge error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
