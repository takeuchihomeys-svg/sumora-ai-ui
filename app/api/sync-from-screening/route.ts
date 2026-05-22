import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// Supabase Database Webhook payload shape
interface DbWebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
}

export async function POST(req: NextRequest) {
  // Verify shared secret to reject unauthorized callers
  const secret = req.headers.get("x-sync-secret");
  if (!process.env.SYNC_SECRET || secret !== process.env.SYNC_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: DbWebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { type, table, record } = payload;

  // Only sync INSERT and UPDATE; ignore DELETE to preserve local data
  if (type === "DELETE" || !record) {
    return NextResponse.json({ ok: true, action: "ignored" });
  }

  if (table === "conversations") {
    const { error } = await supabase
      .from("conversations")
      .upsert(
        {
          id: String(record.id),
          customer_name: record.customer_name ?? null,
          status: record.status ?? null,
          line_user_id: record.line_user_id ?? "",
          last_message: record.last_message ?? null,
          last_sender: record.last_sender ?? null,
          updated_at: record.updated_at ?? null,
          profile_image_url: record.profile_image_url ?? null,
          account: record.account ?? null,
        },
        { onConflict: "id" }
      );

    if (error) {
      console.error("sync conversations error:", error.code, error.message, error.details, error.hint);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, synced: "conversation", id: record.id });
  }

  if (table === "messages") {
    const { error } = await supabase
      .from("messages")
      .upsert(
        {
          id: record.id,
          conversation_id: record.conversation_id,
          sender: record.sender,
          text: record.text ?? "",
          image_url: record.image_url ?? null,
          created_at: record.created_at,
        },
        { onConflict: "id" }
      );

    if (error) {
      console.error("sync messages error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, synced: "message", id: record.id });
  }

  return NextResponse.json({ ok: true, action: "ignored_unknown_table", table });
}
