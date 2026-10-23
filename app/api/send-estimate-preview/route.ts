import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { linePushIdem, parseSendId, sendIdempotencyOn } from "@/app/lib/send-idempotency";

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

  const { imageBase64, send_id } = await req.json() as { imageBase64: string; send_id?: string };
  // 2026-10-23 送信の二重防止: 画面の印があれば LINE の X-Line-Retry-Key に入れる（押し直しで二重に届かない）
  const sendId = sendIdempotencyOn() ? parseSendId(send_id) : null;

  const groupId = await getGroupId();
  if (!groupId || !HANBANCYO_TOKEN) {
    return NextResponse.json({ ok: false, error: "売上番長グループが未設定です" }, { status: 500 });
  }

  // base64 → Buffer → Supabaseにアップロード
  const base64Data = imageBase64.replace(/^data:image\/png;base64,/, "");
  const buf = Buffer.from(base64Data, "base64");
  // 印がある時は置き場所も印で決める（押し直しで同じ所に上書き＝余分な画像を残さない）
  const path = `estimate-preview/${sendId ?? Date.now()}.png`;

  const { error: uploadError } = await supabase.storage
    .from("property-images")
    .upload(path, buf, { contentType: "image/png", upsert: true });

  if (uploadError) {
    return NextResponse.json({ ok: false, error: uploadError.message }, { status: 500 });
  }

  const { data } = supabase.storage.from("property-images").getPublicUrl(path);
  const imageUrl = data.publicUrl;

  // 売上番長からグループに画像送信
  //   LINE APIハング時に関数がタイムアウト上限まで滞留するのを防ぐ（10秒・linePushIdem の既定）
  const r = await linePushIdem({
    token: HANBANCYO_TOKEN, to: groupId, sendId,
    messages: [{ type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl }],
  });

  if (!r.ok) {
    return NextResponse.json({ ok: false, error: r.errorText }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...(r.alreadySent ? { alreadySent: true } : {}) });
}
