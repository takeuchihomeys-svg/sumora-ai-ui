import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// Vercel Functions のタイムアウト上限（秒）— 最大100件のLINE push送信に余裕を持たせる
export const maxDuration = 300;

const ACCOUNT_KEY_MAP: Record<string, string> = {
  "イエヤス": "ieyasu",
  "ギガ賃貸": "giga",
  "スモラ":   "sumora",
};

function getToken(accountKey: string): string | undefined {
  switch (accountKey) {
    case "ieyasu": return process.env.LINE_IEYASU_CHANNEL_ACCESS_TOKEN;
    case "giga":   return process.env.LINE_GIGA_CHANNEL_ACCESS_TOKEN;
    case "hasu":   return process.env.LINE_HASU_CHANNEL_ACCESS_TOKEN;
    default:       return process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  }
}

function resolveAccountKey(account?: string): string {
  if (!account) return "sumora";
  const validKeys = ["ieyasu", "giga", "hasu", "sumora"];
  if (validKeys.includes(account)) return account;
  return ACCOUNT_KEY_MAP[account] ?? "sumora";
}

async function pushToLine(lineUserId: string, messages: unknown[], token: string) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: lineUserId, messages }),
    // LINE APIハング時にmaxDuration(300秒)まで滞留するのを防ぐ
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function GET(req: NextRequest) {
  // Vercel Cron は Authorization: Bearer <CRON_SECRET> を送る
  // fail-closed: CRON_SECRET 未設定時も拒否（未認証実行を防ぐ）
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date().toISOString();

  // stale sending リカバリ（タイムアウトや前回クラッシュで stuck したものを回収）
  const staleThreshold = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await supabase
    .from("scheduled_messages")
    .update({ status: "failed", error: "stale sending (timeout recovery)" })
    .eq("status", "sending")
    .lt("updated_at", staleThreshold);

  const { data: pending, error: fetchErr } = await supabase
    .from("scheduled_messages")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_at", now)
    .order("scheduled_at", { ascending: true })
    .limit(100);

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!pending?.length) return NextResponse.json({ ok: true, processed: 0 });

  let processed = 0;

  for (const msg of pending) {
    try {
      // アトミッククレーム: 並行実行での二重送信を防止
      const { data: claimed } = await supabase
        .from("scheduled_messages")
        .update({ status: "sending", updated_at: new Date().toISOString() })
        .eq("id", msg.id as string)
        .eq("status", "pending")
        .select("id");
      if (!claimed?.length) continue;

      const accountKey = resolveAccountKey(msg.account as string | undefined);
      const token = getToken(accountKey);
      if (!token) throw new Error(`LINE token not configured: ${accountKey}`);

      const imageUrls: string[] = Array.isArray(msg.image_urls) ? (msg.image_urls as string[]) : [];
      const text: string = (msg.text as string) || "";
      const sentAt = new Date();

      // 画像送信（1枚ずつ）
      for (const imageUrl of imageUrls) {
        await pushToLine(msg.line_user_id as string, [
          { type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl },
        ], token);
      }

      // テキスト送信
      if (text) {
        await pushToLine(msg.line_user_id as string, [{ type: "text", text }], token);
      }

      // messages テーブルに記録
      if (imageUrls.length > 0) {
        const imageUrlData = imageUrls.length === 1 ? imageUrls[0] : JSON.stringify(imageUrls);
        const { error: imgInsertErr } = await supabase.from("messages").insert({
          conversation_id: msg.conversation_id,
          sender: "staff",
          text: "[画像]",
          image_url: imageUrlData,
          created_at: sentAt.toISOString(),
        });
        if (imgInsertErr) {
          console.error("[send-scheduled] 画像message記録失敗（LINE送信は成功）:", imgInsertErr.message, "id:", msg.id);
        }
      }
      if (text) {
        const textAt = imageUrls.length > 0 ? new Date(sentAt.getTime() + 1000) : sentAt;
        const { error: textInsertErr } = await supabase.from("messages").insert({
          conversation_id: msg.conversation_id,
          sender: "staff",
          text,
          created_at: textAt.toISOString(),
        });
        if (textInsertErr) {
          console.error("[send-scheduled] message記録失敗（LINE送信は成功）:", textInsertErr.message, "id:", msg.id);
        }
      }

      // conversations 更新
      const lastText = text || (imageUrls.length > 0 ? "[画像]" : "");
      const { error: convUpdateErr } = await supabase
        .from("conversations")
        .update({ last_message: lastText, last_sender: "staff", updated_at: sentAt.toISOString(), ai_draft: null, is_flagged: false })
        .eq("id", msg.conversation_id as string);
      if (convUpdateErr) {
        console.error("[send-scheduled] conversations更新失敗:", convUpdateErr.message, "id:", msg.id);
      }

      const { error: sentErr } = await supabase.from("scheduled_messages").update({ status: "sent" }).eq("id", msg.id as string);
      if (sentErr) {
        // LINE送信は成功済み。DBステータス更新が失敗しても "failed" にしない（次回Cronで重複送信されるのを防ぐ）
        console.error("[send-scheduled] status更新失敗（LINE送信は成功）:", sentErr.message, "id:", msg.id);
      }
      processed++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await supabase.from("scheduled_messages").update({ status: "failed", error: errMsg }).eq("id", msg.id as string);
    }
  }

  return NextResponse.json({ ok: true, processed });
}
