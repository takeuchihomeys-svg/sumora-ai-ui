import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// JSTの現在時刻を分で返す (例: 10:30 → 630)
function getJSTMinutes(): { todayJST: string; nowMinutes: number } {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayJST = jst.toISOString().slice(0, 10);
  const nowMinutes = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  return { todayJST, nowMinutes };
}

async function sendGroupMessage(text: string): Promise<void> {
  let targetId = process.env.LINE_STAFF_GROUP_ID ?? null;
  if (!targetId) {
    const { data } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").single();
    targetId = (data?.value as string) ?? null;
  }
  if (!targetId) return;
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  if (!token) return;

  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: targetId, messages: [{ type: "text", text }] }),
  });
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { todayJST, nowMinutes } = getJSTMinutes();

  // 今日の内覧を取得
  const { data: viewings, error } = await supabase
    .from("viewings")
    .select("*")
    .eq("viewing_date", todayJST)
    .eq("status", "scheduled");

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!viewings || viewings.length === 0) return NextResponse.json({ ok: true, announced: 0 });

  let announced = 0;

  for (const v of viewings) {
    const customerName = (v.customer_name as string) || "お客様";
    const timeStr = (v.viewing_time as string) || "";

    // 内覧時刻を分で取得
    let viewingMinutes: number | null = null;
    if (timeStr) {
      const parts = timeStr.split(":");
      if (parts.length >= 2) {
        viewingMinutes = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
      }
    }

    // ── 内覧前アナウンス ──
    if (!v.pre_announce_sent) {
      let shouldPre = false;

      if (viewingMinutes !== null) {
        // 内覧1時間前〜内覧時刻の間、または朝9時台（まだ内覧前）
        const oneHourBefore = viewingMinutes - 60;
        if (nowMinutes >= oneHourBefore && nowMinutes < viewingMinutes) shouldPre = true;
        if (nowMinutes >= 9 * 60 && nowMinutes < 9 * 60 + 30 && nowMinutes < viewingMinutes) shouldPre = true;
      } else {
        // 時刻未指定: 朝9〜9:30 JSTに送る
        if (nowMinutes >= 9 * 60 && nowMinutes < 9 * 60 + 30) shouldPre = true;
      }

      if (shouldPre) {
        const timeLabel = timeStr ? ` ${timeStr}〜` : "";
        const text = `📅【内覧前アナウンス】\n今日${customerName}さん${timeLabel}内覧！！\n内覧前挨拶を送ってあげて！！`;
        await sendGroupMessage(text);
        await supabase.from("viewings").update({ pre_announce_sent: true }).eq("id", v.id as string);
        announced++;
      }
    }

    // ── 内覧後アナウンス ──
    if (!v.post_announce_sent) {
      let shouldPost = false;

      if (viewingMinutes !== null) {
        // 内覧時刻の30分後以降
        if (nowMinutes >= viewingMinutes + 30) shouldPost = true;
      } else {
        // 時刻未指定: 夕方18〜18:30 JSTに送る
        if (nowMinutes >= 18 * 60 && nowMinutes < 18 * 60 + 30) shouldPost = true;
      }

      if (shouldPost) {
        const text = `🏠【内覧後アナウンス】\n${customerName}さん内覧終わり！！\nAIX→挨拶（内覧後）で挨拶送って！！😊`;
        await sendGroupMessage(text);
        await supabase.from("viewings").update({ post_announce_sent: true }).eq("id", v.id as string);
        announced++;
      }
    }
  }

  return NextResponse.json({ ok: true, announced });
}
