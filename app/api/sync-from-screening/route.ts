import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import webpush from "web-push";

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    "mailto:takeuchi.homeys@gmail.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

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

// Web Push: 全登録端末に通知を送る
async function sendWebPush(title: string, body: string) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;

  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth");
  if (!subs || subs.length === 0) return;

  const payload = JSON.stringify({ title, body, url: "/" });
  const staleEndpoints: string[] = [];

  await Promise.allSettled(
    subs.map(async (s: { endpoint: string; p256dh: string; auth: string }) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload
        );
      } catch (err: unknown) {
        // 期限切れ・無効なsubscriptionを削除
        if (err && typeof err === "object" && "statusCode" in err &&
            ((err as { statusCode: number }).statusCode === 410 || (err as { statusCode: number }).statusCode === 404)) {
          staleEndpoints.push(s.endpoint);
        }
      }
    })
  );

  if (staleEndpoints.length > 0) {
    await supabase.from("push_subscriptions").delete().in("endpoint", staleEndpoints);
  }
}

export async function POST(req: NextRequest) {
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

  if (type === "DELETE" || !record) {
    return NextResponse.json({ ok: true, action: "ignored" });
  }

  if (table === "conversations") {
    const ACCOUNT_MAP: Record<string, string> = {
      "スモラ":   "sumora",  sumora:  "sumora",
      "イエヤス": "ieyasu",  ieyasu:  "ieyasu",
      "ギガ賃貸": "giga",    giga:    "giga",
    };
    const rawAccount = record.account as string | null | undefined;
    let resolvedAccount = rawAccount ? (ACCOUNT_MAP[rawAccount] ?? rawAccount) : null;

    if (!resolvedAccount && record.line_user_id) {
      resolvedAccount = await resolveAccountByLineUserId(record.line_user_id as string);
    }

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
    if (record.sender === "staff") {
      return NextResponse.json({ ok: true, action: "ignored_staff_message" });
    }

    let imageUrl: string | null = (record.image_url as string) ?? null;

    // 画像メッセージ検出: より広い条件で判定
    const msgText = String(record.text ?? "");
    const msgType = String(record.message_type ?? record.type ?? "");
    const isImageMsg = !imageUrl && record.sender === "customer" && (
      msgText === "[画像]" ||
      msgText === "[image]" ||
      msgText === "" ||
      msgType === "image"
    );

    if (isImageMsg) {
      // LINE message IDを複数フィールド名で探す（DBのIDではなくLINEのメッセージID）
      const lineMessageId = (
        (record.line_message_id as string) ||
        (record.lineMessageId as string) ||
        (record.message_id as string) ||
        (record.line_id as string) ||
        null
      );

      console.log("[sync] 画像メッセージ検出:", {
        id: record.id,
        text: msgText,
        type: msgType,
        line_message_id: lineMessageId,
        keys: Object.keys(record).join(","),
      });

      if (lineMessageId) {
        const { data: conv } = await supabase
          .from("conversations")
          .select("account")
          .eq("id", String(record.conversation_id))
          .single();

        const TOKEN_MAP: Record<string, string | undefined> = {
          sumora: process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN,
          ieyasu: process.env.LINE_IEYASU_CHANNEL_ACCESS_TOKEN,
          giga:   process.env.LINE_GIGA_CHANNEL_ACCESS_TOKEN,
        };
        const token = conv?.account ? TOKEN_MAP[conv.account as string] : undefined;

        if (token) {
          try {
            const contentRes = await fetch(
              `https://api-data.line.me/v2/bot/message/${lineMessageId}/content`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (contentRes.ok) {
              const contentType = contentRes.headers.get("content-type") || "image/jpeg";
              const ext = contentType.includes("png") ? "png" : contentType.includes("gif") ? "gif" : "jpg";
              const arrayBuffer = await contentRes.arrayBuffer();
              const buffer = Buffer.from(arrayBuffer);
              const storagePath = `line-images/${lineMessageId}.${ext}`;

              const { error: uploadErr } = await supabase.storage
                .from("property-images")
                .upload(storagePath, buffer, { contentType, upsert: true });

              if (!uploadErr) {
                const { data: urlData } = supabase.storage
                  .from("property-images")
                  .getPublicUrl(storagePath);
                imageUrl = urlData.publicUrl;
                console.log("[sync] LINE画像を取得・保存:", storagePath);
              } else {
                console.error("[sync] Storage upload error:", uploadErr.message);
              }
            } else {
              console.warn("[sync] LINE Content API returned", contentRes.status, "for message", lineMessageId);
            }
          } catch (err) {
            console.error("[sync] LINE Content API fetch error:", err);
          }
        }
      } else {
        console.warn("[sync] line_message_id が見つかりません。利用可能なフィールド:", Object.keys(record).join(", "));
      }
    }

    const { error } = await supabase
      .from("messages")
      .upsert(
        {
          id: record.id,
          conversation_id: record.conversation_id,
          sender: record.sender,
          text: record.text ?? "",
          image_url: imageUrl,
          created_at: record.created_at,
        },
        { onConflict: "id" }
      );

    if (error) {
      console.error("sync messages error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // お客さんのメッセージが届いたら Web Push 通知を送る
    if (record.sender === "customer") {
      const notifBody = isImageMsg
        ? "📷 画像が届きました"
        : msgText || "新しいメッセージが届きました";
      sendWebPush("AIX LINX — 新着メッセージ", notifBody).catch(() => {});
    }

    return NextResponse.json({ ok: true, synced: "message", id: record.id, image_fetched: !!imageUrl });
  }

  return NextResponse.json({ ok: true, action: "ignored_unknown_table", table });
}
