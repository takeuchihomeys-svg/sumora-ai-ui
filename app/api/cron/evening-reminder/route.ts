import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // 今日の開始時刻（JST 00:00 = UTC 前日15:00）
  const _jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  _jstNow.setUTCHours(0, 0, 0, 0);
  const todayStart = new Date(_jstNow.getTime() - 9 * 60 * 60 * 1000);

  // 🔥ステータスの顧客を全取得
  const { data: hotCustomers, error } = await supabase
    .from("property_customers")
    .select("id, customer_name, last_property_sent_at, hot_confirmed_at")
    .eq("status", "hot");

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // 今日まだ対応していない顧客
  const unattended = (hotCustomers ?? []).filter((c) => {
    const sentToday = c.last_property_sent_at && new Date(c.last_property_sent_at) >= todayStart;
    const confirmedToday = c.hot_confirmed_at && new Date(c.hot_confirmed_at) >= todayStart;
    return !sentToday && !confirmedToday;
  });

  // LINEグループ設定
  let groupId: string | null = process.env.LINE_STAFF_GROUP_ID ?? null;
  if (!groupId) {
    const { data } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").single();
    groupId = (data?.value as string) ?? null;
  }
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;

  if (!groupId || !token) {
    return NextResponse.json({ ok: false, error: "LINE config missing" }, { status: 500 });
  }

  let text: string;
  if (unattended.length === 0) {
    text = "🎉 今日の🔥あついお客さんへの対応が全員完了しています！\nお疲れ様でした！";
  } else {
    const names = unattended
      .map((c, i) => `${i + 1}. 🔥 ${c.customer_name ?? "名称未設定"}様`)
      .join("\n");
    text = `⚠️ まだ対応できていない🔥あついお客さんがいます！\n\n${names}\n\n物件を送るか、確認して「👀 本日確認済み」を押してください！`;
  }

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: groupId, messages: [{ type: "text", text }] }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("[evening-reminder] LINE push error:", body);
    return NextResponse.json({ ok: false, error: body }, { status: 500 });
  }

  return NextResponse.json({ ok: true, unattended: unattended.length });
}
