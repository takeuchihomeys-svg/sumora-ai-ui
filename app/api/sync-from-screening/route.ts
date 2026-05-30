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

// LINE アカウント定義（どのBotをフォローしているかで判定）
const LINE_ACCOUNTS = [
  { key: "ieyasu", token: process.env.LINE_IEYASU_CHANNEL_ACCESS_TOKEN },
  { key: "giga",   token: process.env.LINE_GIGA_CHANNEL_ACCESS_TOKEN },
  { key: "sumora", token: process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN },
] as const;

// LINE Profile API でどのアカウントのBotをフォローしているか判定（line_contactsをキャッシュとして使用）
async function resolveAccountByLineUserId(lineUserId: string): Promise<string | null> {
  // line_contacts キャッシュを確認
  const ACCOUNT_MAP: Record<string, string> = {
    "スモラ": "sumora", sumora: "sumora",
    "イエヤス": "ieyasu", ieyasu: "ieyasu",
    "ギガ賃貸": "giga", giga: "giga",
  };
  const { data: contact } = await supabase
    .from("line_contacts")
    .select("account")
    .eq("line_user_id", lineUserId)
    .limit(1)
    .single();
  if (contact?.account) {
    return ACCOUNT_MAP[contact.account as string] ?? null;
  }

  // キャッシュになければ LINE Profile API で判定
  for (const acct of LINE_ACCOUNTS) {
    if (!acct.token) continue;
    try {
      const res = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
        headers: { Authorization: `Bearer ${acct.token}` },
      });
      if (res.ok) return acct.key;
    } catch { /* skip */ }
  }
  return null;
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
    // screening-admin の account 値（日本語名 or 英語キー）を英語キーに変換
    const ACCOUNT_MAP: Record<string, string> = {
      "スモラ":   "sumora",  sumora:  "sumora",
      "イエヤス": "ieyasu",  ieyasu:  "ieyasu",
      "ギガ賃貸": "giga",    giga:    "giga",
    };
    const rawAccount = record.account as string | null | undefined;
    let resolvedAccount = rawAccount ? (ACCOUNT_MAP[rawAccount] ?? rawAccount) : null;

    // screening-admin にアカウント情報がない場合は LINE Profile API で自動判定
    if (!resolvedAccount && record.line_user_id) {
      resolvedAccount = await resolveAccountByLineUserId(record.line_user_id as string);
    }

    // account が null の場合はフィールド自体を省略し、既存値を上書きしない
    const upsertData: Record<string, unknown> = {
      id: String(record.id),
      customer_name: record.customer_name ?? null,
      status: record.status ?? null,
      line_user_id: record.line_user_id ?? "",
      last_message: record.last_message ?? null,
      last_sender: record.last_sender ?? null,
      updated_at: record.updated_at ?? null,
      profile_image_url: record.profile_image_url ?? null,
    };
    if (resolvedAccount) upsertData.account = resolvedAccount;

    const { error } = await supabase
      .from("conversations")
      .upsert(upsertData, { onConflict: "id" });

    if (error) {
      console.error("sync conversations error:", error.code, error.message, error.details, error.hint);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, synced: "conversation", id: record.id, account: resolvedAccount });
  }

  if (table === "messages") {
    // screening-adminからのstaffメッセージ（AI自動返信案）は同期しない
    // staffメッセージはsumora-ai-uiの管理画面から直接送信したものだけ表示する
    if (record.sender === "staff") {
      return NextResponse.json({ ok: true, action: "ignored_staff_message" });
    }

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
