import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";

const HANBANCYO_TOKEN = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? "";

async function getGroupId(): Promise<string | null> {
  const { data } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", "group_id")
    .single();
  return data?.value ?? null;
}

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;

  const { imageBase64 } = await req.json() as { imageBase64: string };

  const groupId = await getGroupId();
  if (!groupId || !HANBANCYO_TOKEN) {
    return NextResponse.json({ ok: false, error: "売上番長グループが未設定です" }, { status: 500 });
  }

  // base64 → Buffer → Supabaseにアップロード
  const base64Data = imageBase64.replace(/^data:image\/png;base64,/, "");
  const buf = Buffer.from(base64Data, "base64");
  const path = `estimate-preview/${Date.now()}.png`;

  const { error: uploadError } = await supabase.storage
    .from("property-images")
    .upload(path, buf, { contentType: "image/png", upsert: true });

  if (uploadError) {
    return NextResponse.json({ ok: false, error: uploadError.message }, { status: 500 });
  }

  const { data } = supabase.storage.from("property-images").getPublicUrl(path);
  const imageUrl = data.publicUrl;

  // 売上番長からグループに画像送信
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${HANBANCYO_TOKEN}`,
    },
    body: JSON.stringify({
      to: groupId,
      messages: [
        { type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl },
      ],
    }),
    // LINE APIハング時に関数がタイムアウト上限まで滞留するのを防ぐ
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ ok: false, error: text }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
