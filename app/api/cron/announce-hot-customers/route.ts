import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

function getJSTHour(): number {
  return (new Date().getUTCHours() + 9) % 24;
}

/** JST 今日の 00:00:00 を UTC の Date として返す */
function getTodayJSTStart(): Date {
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  jstNow.setUTCHours(0, 0, 0, 0);
  return new Date(jstNow.getTime() - 9 * 60 * 60 * 1000);
}

export async function GET(req: NextRequest) {
  // 認証チェック（CRON_SECRET）
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // CRON-004: クールダウンガード（90分以内の重複送信を防ぐ）
  const { data: cooldownRow } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", "announce_hot_last_sent_at")
    .maybeSingle();
  if (cooldownRow?.value) {
    const lastSentAt = new Date(cooldownRow.value).getTime();
    if (Date.now() - lastSentAt < 90 * 60 * 1000) {
      return NextResponse.json({ ok: true, skipped: true, reason: "cooldown (90min)" });
    }
  }

  // LINE グループID
  let targetId = process.env.LINE_STAFF_GROUP_ID ?? null;
  if (!targetId) {
    const { data: grpRow } = await supabase
      .from("hanbancyo_settings")
      .select("value")
      .eq("key", "group_id")
      .maybeSingle();
    targetId = grpRow?.value ?? null;
  }
  if (!targetId) {
    return NextResponse.json(
      { ok: false, error: "LINE_STAFF_GROUP_ID not configured (env) and hanbancyo_settings group_id not set (db)" },
      { status: 500 }
    );
  }

  const token =
    process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ??
    process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "LINE token not configured" }, { status: 500 });
  }

  // is_flagged=true の会話を全取得（ステータス問わず・申込以降も含む）
  const { data: flaggedConvs, error: convError } = await supabase
    .from("conversations")
    .select("id, customer_name, account, last_message, last_sender, updated_at, status")
    .eq("is_flagged", true)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (convError) {
    console.error("announce-hot-customers conv error:", convError);
    return NextResponse.json({ ok: false, error: convError.message }, { status: 500 });
  }

  const convList = flaggedConvs ?? [];
  if (convList.length === 0) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no flagged customers" });
  }

  // JST 今日の開始時刻
  const todayStart = getTodayJSTStart();

  // 対象会話IDリスト
  const convIds = convList.map((c) => c.id);

  // 今日のスタッフメッセージを一括取得（is_aix_generated の有無も取る）
  const { data: todayStaffMsgs } = await supabase
    .from("messages")
    .select("conversation_id, is_aix_generated")
    .eq("sender", "staff")
    .gte("created_at", todayStart.toISOString())
    .in("conversation_id", convIds);

  // conversation_id → { hasAix, hasStaff } のマップを構築
  const staffMsgMap = new Map<string, { hasAix: boolean; hasStaff: boolean }>();
  for (const msg of todayStaffMsgs ?? []) {
    const existing = staffMsgMap.get(msg.conversation_id) ?? { hasAix: false, hasStaff: false };
    staffMsgMap.set(msg.conversation_id, {
      hasAix: existing.hasAix || !!msg.is_aix_generated,
      hasStaff: true,
    });
  }

  /**
   * ✅ = 今日 AIX で送信（is_aix_generated=true のスタッフメッセージが今日ある）
   * ☑  = 今日スタッフが返信したが AIX でない
   * ・ = 今日スタッフ返信なし
   */
  function getActionMark(convId: string): string {
    const info = staffMsgMap.get(convId);
    if (!info) return "・";
    return info.hasAix ? "✅" : "☑";
  }

  // ソート: お客様からの返信あり（last_sender='customer'）を先頭、次に待機時間長い順（updated_at 昇順）
  const sorted = [...convList].sort((a, b) => {
    const aWaiting = a.last_sender === "customer" ? 0 : 1;
    const bWaiting = b.last_sender === "customer" ? 0 : 1;
    if (aWaiting !== bWaiting) return aWaiting - bWaiting;
    return (
      new Date(a.updated_at ?? "").getTime() -
      new Date(b.updated_at ?? "").getTime()
    );
  });

  const hour = getJSTHour();

  // 各行フォーマット: ✅/☑/・ + 名前（status）
  const lines = sorted.map((c) => {
    const mark = getActionMark(c.id);
    const name = c.customer_name || "名称未設定";
    const status = c.status || "";
    return `${mark}${name}（${status}）`;
  });

  const message = [
    "【しょーへいの今日のターゲット全リスト】",
    "",
    "► 決まる（最優先）",
    lines.join("\n"),
    "",
    `AIX LINX より ${hour}:00`,
  ].join("\n");

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: targetId, messages: [{ type: "text", text: message }] }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("announce-hot-customers LINE error:", text);
    return NextResponse.json({ ok: false, error: text }, { status: 500 });
  }

  // CRON-004: 送信成功後にクールダウン用タイムスタンプを更新
  await supabase.from("hanbancyo_settings").upsert(
    { key: "announce_hot_last_sent_at", value: new Date().toISOString() },
    { onConflict: "key" }
  );

  return NextResponse.json({ ok: true, flagged: convList.length, sent: sorted.length });
}
