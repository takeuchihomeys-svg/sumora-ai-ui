import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const ACCOUNT_TOKEN: Record<string, string | undefined> = {
  ieyasu: process.env.LINE_IEYASU_CHANNEL_ACCESS_TOKEN,
  sumora: process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN,
  giga:   process.env.LINE_GIGA_CHANNEL_ACCESS_TOKEN,
};

export async function POST(req: NextRequest) {
  const { imageBase64 } = await req.json() as { imageBase64: string };

  const adminUserId = process.env.ADMIN_LINE_USER_ID;
  const adminAccount = process.env.ADMIN_LINE_ACCOUNT || "ieyasu";
  const token = ACCOUNT_TOKEN[adminAccount];

  if (!adminUserId || !token) {
    return NextResponse.json({ ok: false, error: "管理者LINEが未設定です" }, { status: 500 });
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

  // LINE push（画像メッセージ）
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: adminUserId,
      messages: [
        { type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ ok: false, error: text }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
