import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { put } from "@vercel/blob";
import { requireInternalAuth } from "@/app/lib/api-auth";

const TOKEN = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? "";

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

  try {
    const { image_base64, file_name, caption } = await req.json() as {
      image_base64: string;
      file_name?: string;
      caption?: string;
    };

    if (!image_base64) {
      return NextResponse.json({ error: "image_base64が空です" }, { status: 400 });
    }

    const name = file_name || `物件リスト_${new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }).replace(/\//g, "-")}.png`;

    // Vercel Blobにアップロード
    const bytes = Buffer.from(image_base64, "base64");
    const blob = await put(name, bytes, {
      access: "public",
      contentType: "image/png",
    });

    const groupId = await getGroupId();
    if (!groupId || !TOKEN) {
      return NextResponse.json({ ok: true, url: blob.url, line_sent: false });
    }

    // LINE グループに画像として送信
    const messages: object[] = [
      {
        type: "image",
        originalContentUrl: blob.url,
        previewImageUrl: blob.url,
      },
    ];

    // キャプションがあればテキストも追加
    if (caption) {
      messages.unshift({ type: "text", text: caption });
    }

    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ to: groupId, messages }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error("[send-image-to-line] LINE push失敗:", res.status, errBody);
      return NextResponse.json(
        { error: `LINE送信に失敗しました (status ${res.status})`, url: blob.url, line_sent: false },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true, url: blob.url, line_sent: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
