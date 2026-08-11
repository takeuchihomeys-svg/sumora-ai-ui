import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

async function sendGroupMessage(text: string): Promise<void> {
  let targetId = process.env.LINE_STAFF_GROUP_ID ?? null;
  if (!targetId) {
    const { data: grpRow } = await supabase
      .from("hanbancyo_settings")
      .select("value")
      .eq("key", "group_id")
      .single();
    targetId = grpRow?.value ?? null;
  }
  if (!targetId) return;

  const token =
    process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ??
    process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  if (!token) return;

  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to: targetId, messages: [{ type: "text", text }] }),
  });
}

// POST: LINEグループへ任意テキストを通知（バッチ自動化ツールから呼ばれる）
export async function POST(req: NextRequest) {
  const body = await req.json() as { text?: string };
  const { text } = body;
  if (!text) {
    return NextResponse.json({ ok: false, error: "text required" }, { status: 400 });
  }
  await sendGroupMessage(text).catch(console.error);
  return NextResponse.json({ ok: true });
}
