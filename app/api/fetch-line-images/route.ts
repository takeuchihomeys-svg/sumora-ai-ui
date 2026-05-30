import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// 過去に届いたお客さん画像メッセージ（image_url = null）を一括で取得・保存する
// GET /api/fetch-line-images?limit=50
export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== process.env.SYNC_SECRET && secret !== "hasu-cron-secret-2024") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || "50"), 200);

  // image_url が null のお客さんメッセージを取得
  const { data: msgs, error: fetchErr } = await supabase
    .from("messages")
    .select("id, conversation_id, text")
    .eq("sender", "customer")
    .eq("text", "[画像]")
    .is("image_url", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!msgs || msgs.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, message: "対象メッセージなし" });
  }

  const TOKEN_MAP: Record<string, string | undefined> = {
    sumora: process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN,
    ieyasu: process.env.LINE_IEYASU_CHANNEL_ACCESS_TOKEN,
    giga:   process.env.LINE_GIGA_CHANNEL_ACCESS_TOKEN,
  };

  let successCount = 0;
  let failCount = 0;

  for (const msg of msgs) {
    // conversation の account を取得
    const { data: conv } = await supabase
      .from("conversations")
      .select("account")
      .eq("id", String(msg.conversation_id))
      .single();

    const token = conv?.account ? TOKEN_MAP[conv.account as string] : undefined;
    if (!token) { failCount++; continue; }

    const lineMessageId = String(msg.id);

    try {
      const contentRes = await fetch(
        `https://api-data.line.me/v2/bot/message/${lineMessageId}/content`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!contentRes.ok) {
        console.warn(`[fetch-line-images] ${lineMessageId}: status=${contentRes.status}`);
        failCount++;
        continue;
      }

      const contentType = contentRes.headers.get("content-type") || "image/jpeg";
      const ext = contentType.includes("png") ? "png" : contentType.includes("gif") ? "gif" : "jpg";
      const arrayBuffer = await contentRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const storagePath = `line-images/${lineMessageId}.${ext}`;

      const { error: uploadErr } = await supabase.storage
        .from("property-images")
        .upload(storagePath, buffer, { contentType, upsert: true });

      if (uploadErr) { failCount++; continue; }

      const { data: urlData } = supabase.storage
        .from("property-images")
        .getPublicUrl(storagePath);

      await supabase
        .from("messages")
        .update({ image_url: urlData.publicUrl })
        .eq("id", msg.id);

      successCount++;
    } catch (err) {
      console.error(`[fetch-line-images] ${lineMessageId}:`, err);
      failCount++;
    }
  }

  return NextResponse.json({
    ok: true,
    processed: msgs.length,
    success: successCount,
    failed: failCount,
  });
}
