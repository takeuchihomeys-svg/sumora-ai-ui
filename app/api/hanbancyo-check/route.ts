import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export async function GET() {
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? "";
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN ?? "";

  const { data: groupRow } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", "group_id")
    .single();

  const groupId = groupRow?.value ?? null;

  // LINE bot profile 確認（token が有効かチェック）
  let botName: string | null = null;
  let tokenOk = false;
  if (token) {
    try {
      const res = await fetch("https://api.line.me/v2/bot/info", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const info = await res.json() as { displayName?: string };
        botName = info.displayName ?? null;
        tokenOk = true;
      }
    } catch { /* noop */ }
  }

  return NextResponse.json({
    token_set: !!token,
    token_valid: tokenOk,
    bot_name: botName,
    blob_token_set: !!blobToken,
    group_id_registered: !!groupId,
    group_id: groupId ? groupId.slice(0, 8) + "..." : null,
    status: tokenOk && !!groupId && !!blobToken ? "✅ 送信準備OK" : "❌ 設定不足",
    issues: [
      !token        && "LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN 未設定",
      !tokenOk      && token && "LINE token が無効（期限切れ or 間違い）",
      !blobToken    && "BLOB_READ_WRITE_TOKEN 未設定",
      !groupId      && "group_id 未登録 → LINEグループでメッセージを送ってください",
    ].filter(Boolean),
  });
}
