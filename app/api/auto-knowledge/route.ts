import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { learnFromModifiedExample } from "@/app/lib/auto-knowledge";

export const maxDuration = 60;

// 401修正: ☆付与時の学習は save-reply-example の PATCH（サーバー側 after()）から
// learnFromModifiedExample を直接呼ぶ構成に変更済み。
// このルートは CRON_SECRET 認証付きの手動/バッチ実行用として残す。
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
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

    const result = await learnFromModifiedExample({
      exampleId: body.example_id,
      aiDraft,
      sentReply,
      conversationState,
      customerMessage,
    });

    return NextResponse.json(result);
  } catch (e) {
    console.error("auto-knowledge error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
