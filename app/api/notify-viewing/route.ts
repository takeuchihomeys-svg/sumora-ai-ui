import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// 日付文字列 (YYYY-MM-DD) を JST 基準で「今日」「明日」「○月○日」に変換
function getDateLabel(dateStr: string): string {
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstNow = new Date(now.getTime() + jstOffset);
  const jstToday = jstNow.toISOString().slice(0, 10);
  const jstTomorrow = new Date(jstNow.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  if (dateStr === jstToday) return "今日";
  if (dateStr === jstTomorrow) return "明日";
  const m = parseInt(dateStr.slice(5, 7));
  const d = parseInt(dateStr.slice(8, 10));
  return `${m}月${d}日`;
}

// HH:MM を「○時〜」に変換
function getTimeLabel(time: string): string {
  if (!time) return "";
  const [h, m] = time.split(":");
  const min = m === "00" ? "" : `${m}分`;
  return `${parseInt(h)}時${min}〜`;
}

const EVENT_LABEL: Record<string, string> = {
  viewing: "内覧",
  contract: "契約",
  key_handover: "鍵渡し",
  application: "申込",
  other: "対応",
};

export async function POST(req: NextRequest) {
  try {
    const { customer_name, event_type, date, time, notes } = await req.json() as {
      customer_name: string;
      event_type: string;
      date: string;
      time?: string;
      notes?: string;
    };

    if (!customer_name || !event_type || !date) {
      return NextResponse.json({ ok: false, error: "required fields missing" }, { status: 400 });
    }

    const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
    if (!token) {
      return NextResponse.json({ ok: false, error: "LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN not set" }, { status: 500 });
    }

    // グループID取得（env優先 → DBフォールバック）
    let groupId = process.env.LINE_STAFF_GROUP_ID ?? null;
    if (!groupId) {
      const { data } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").single();
      groupId = (data?.value as string) ?? null;
    }
    if (!groupId) {
      return NextResponse.json({ ok: false, error: "group_id not configured" }, { status: 500 });
    }

    const dateLabel = getDateLabel(date);
    const timeLabel = time ? getTimeLabel(time) : "";
    const eventLabel = EVENT_LABEL[event_type] ?? notes ?? "対応";

    // 「今日Kさん16時〜内覧お願い！」
    const text = `${dateLabel}${customer_name}さん${timeLabel}${eventLabel}お願い！`;

    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: groupId, messages: [{ type: "text", text }] }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[notify-viewing] LINE push error:", errText);
      return NextResponse.json({ ok: false, error: errText }, { status: 500 });
    }

    return NextResponse.json({ ok: true, text });
  } catch (e) {
    console.error("[notify-viewing] error:", e);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
