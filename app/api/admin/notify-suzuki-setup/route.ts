import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 15;

const GROUP_ID = "Cdacb0a3b75ba2513a2db6030248cf1bb";

export async function GET() {
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
  if (!token) return NextResponse.json({ error: "token未設定" }, { status: 500 });

  const text = `鈴木！！一個頼みがある！！\nスモラ・イエヤス・ギガ賃貸のどれかのLINE公式アカウントに「テスト」って一回送ってくれ！！\nメンション通知の設定に必要やから！！これだけでOK！！`;

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: GROUP_ID, messages: [{ type: "text", text }] }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    return NextResponse.json({ error: "LINE push失敗", status: res.status, body }, { status: 502 });
  }

  return NextResponse.json({ ok: true, sent: text });
}
