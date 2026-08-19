import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  // JST 今日の00:00 (UTC前日15:00)
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jstNow.setUTCHours(0, 0, 0, 0);
  const todayStartUTC = new Date(jstNow.getTime() - 9 * 60 * 60 * 1000);

  const [{ count: todayCount }, { count: totalCount }] = await Promise.all([
    supabase
      .from("iyeyasu_page_views")
      .select("*", { count: "exact", head: true })
      .gte("created_at", todayStartUTC.toISOString()),
    supabase
      .from("iyeyasu_page_views")
      .select("*", { count: "exact", head: true }),
  ]);

  const token =
    process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ??
    process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  const groupId =
    process.env.LINE_IYEYASU_REPORT_GROUP_ID ?? process.env.LINE_STAFF_GROUP_ID;

  if (!token || !groupId) {
    return NextResponse.json({ ok: false, error: "LINE config missing" }, { status: 500 });
  }

  const jstDate = jstNow.toISOString().slice(0, 10);
  const text = [
    `📊 イエヤスLP 本日のアクセス（${jstDate}）`,
    `────────────────`,
    `👁 本日：${todayCount ?? 0}件`,
    `📈 累計：${totalCount ?? 0}件`,
    `────────────────`,
    `https://ieyas-chintai.com`,
  ].join("\n");

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to: groupId, messages: [{ type: "text", text }] }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("[iyeyasu-daily-report] LINE push failed:", res.status, body);
    return NextResponse.json({ ok: false, error: body }, { status: 500 });
  }

  return NextResponse.json({ ok: true, today: todayCount, total: totalCount });
}
