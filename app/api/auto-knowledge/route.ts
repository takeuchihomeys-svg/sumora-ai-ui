import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge } from "@/app/lib/knowledge-utils";

// ─── OpenAI 埋め込み生成 ─────────────────────────────────────────────────────
async function getEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 2000) }),
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding ?? null;
  } catch {
    clearTimeout(tid);
    return null;
  }
}

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
        model: "claude-sonnet-4-6",
        max_tokens: 200,
        system: `賃貸仲介LINEのAI文案とスタッフが実際に送った文を比較し、次回以降のAIが学べる改善ルールを1文で抽出してください。

出力形式: 「AIは〜としたが、正しくは〜」（60字以内・具体的に）

以下の場合は「SKIP」とだけ返すこと:
・誤字修正・句読点・絵文字だけの変更
・本質的に同じ内容の言い換えのみ
・「もっと丁寧に」など抽象的すぎてAIが再現できないもの
・個別案件にしか当てはまらない内容

良いルール例: 「AIは物件の間取りを先に説明したが、正しくはお客様の希望条件への合致を先に述べてから詳細を補足する」`,
        messages: [{
          role: "user",
          content: `【営業フェーズ】${state}
【お客様メッセージ】${customerMessage.slice(0, 150)}

【AIが生成した文】
${aiDraft.slice(0, 500)}

【スタッフが実際に送った文】
${sentReply.slice(0, 500)}`,
        }],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ text: string }> };
    const text = data.content?.[0]?.text?.trim() || "";
    if (!text || text.startsWith("SKIP") || text.length < 15) return null;
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

    // 差分が小さすぎる場合はスキップ（20文字未満の差分）
    if (Math.abs(aiDraft.length - sentReply.length) < 20) {
      return NextResponse.json({ ok: false, reason: "diff too small" });
    }

    const normalized = STATE_NORMALIZE[conversationState] ?? conversationState ?? "hearing";

    const rule = await extractCorrectionRule(aiDraft, sentReply, normalized, customerMessage);

    if (!rule) {
      return NextResponse.json({ ok: false, reason: "extraction skipped or failed" });
    }

    // contentフィールド強化: customerMessageがある場合、先頭に例文を付加
    const enrichedContent = customerMessage
      ? `例: 顧客が「${customerMessage.slice(0, 100)}」と言った場合。${rule}`
      : rule;

    // embedding生成（失敗した場合はnullのままinsert）
    let embedding: number[] | null = null;
    try {
      const embeddingInput = customerMessage
        ? `${normalized}: ${customerMessage} ${enrichedContent}`.slice(0, 2000)
        : enrichedContent.slice(0, 2000);
      embedding = await getEmbedding(embeddingInput);
    } catch {
      // embedding生成失敗時はnullのままにして既存ロジックを維持
    }

    const upsertResult = await upsertKnowledge(supabase, {
      title: "差分学習 [自動]",
      category: "principle",
      importance: 9,
      conversation_state: normalized,
      content: enrichedContent,
      ...(embedding !== null ? { embedding } : {}),
    });

    if (upsertResult === "merged") {
      console.log(`[auto-knowledge] 既存ルール強化: "${rule.slice(0, 50)}"`);
    } else if (upsertResult === "skipped") {
      console.log(`[auto-knowledge] スキップ（重複）: "${rule.slice(0, 50)}"`);
    }

    return NextResponse.json({ ok: true, rule, upsertResult });
  } catch (e) {
    console.error("auto-knowledge error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
