import { NextRequest, NextResponse } from "next/server";

function getToken(account?: string): string | undefined {
  switch (account) {
    case "ieyasu": return process.env.LINE_IEYASU_CHANNEL_ACCESS_TOKEN;
    case "giga":   return process.env.LINE_GIGA_CHANNEL_ACCESS_TOKEN;
    case "hasu":   return process.env.LINE_HASU_CHANNEL_ACCESS_TOKEN;
    default:       return process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  }
}

export async function POST(req: NextRequest) {
  const { line_user_id, message, image_url, account } = await req.json();

  if (!line_user_id || (!message && !image_url)) {
    return NextResponse.json({ ok: false, error: "line_user_id and message or image_url required" }, { status: 400 });
  }

  const token = getToken(account);
  if (!token) {
    return NextResponse.json({ ok: false, error: "LINE token not configured" }, { status: 500 });
  }

  const messages: unknown[] = [];
  if (message) messages.push({ type: "text", text: message });
  if (image_url) messages.push({ type: "image", originalContentUrl: image_url, previewImageUrl: image_url });

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: line_user_id, messages }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("LINE push error:", text);
    return NextResponse.json({ ok: false, error: text }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
