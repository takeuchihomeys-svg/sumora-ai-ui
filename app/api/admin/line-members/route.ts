import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let groupId = process.env.LINE_STAFF_GROUP_ID ?? null;
  if (!groupId) {
    const { data } = await supabase
      .from("hanbancyo_settings")
      .select("value")
      .eq("key", "group_id")
      .maybeSingle();
    groupId = data?.value ?? null;
  }

  const token =
    process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ??
    process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;

  if (!groupId || !token) {
    return NextResponse.json({ ok: false, error: "LINE config missing" }, { status: 500 });
  }

  const res = await fetch(
    `https://api.line.me/v2/bot/group/${groupId}/members/all`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    return NextResponse.json({ ok: false, error: await res.text() }, { status: 500 });
  }

  const data = await res.json();
  return NextResponse.json({ ok: true, members: data.members });
}
