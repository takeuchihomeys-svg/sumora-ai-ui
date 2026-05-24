import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export async function POST(req: NextRequest) {
  const { conversationState, customerMessage, sentReply, aiDraft, isStarred } = await req.json() as {
    conversationState: string;
    customerMessage: string;
    sentReply: string;
    aiDraft?: string;
    isStarred?: boolean;
  };

  if (!customerMessage || !sentReply) {
    return NextResponse.json({ ok: false, error: "customerMessage and sentReply required" }, { status: 400 });
  }

  const wasAiUsed = !!aiDraft && aiDraft.trim() === sentReply.trim();
  const wasAiModified = !!aiDraft && !wasAiUsed && aiDraft.trim().length > 0;

  const { error } = await supabase
    .from("ai_reply_examples")
    .insert({
      conversation_state: conversationState || "first_reply",
      customer_message: customerMessage,
      sent_reply: sentReply,
      ai_draft: aiDraft || null,
      was_ai_used: wasAiUsed,
      was_ai_modified: wasAiModified,
      is_starred: isStarred ?? false,
    });

  if (error) {
    console.error("save-reply-example error:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
