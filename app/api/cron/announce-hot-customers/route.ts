import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

function getJSTHour(): number {
  return (new Date().getUTCHours() + 9) % 24;
}

function getTodayJSTStart(): Date {
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  jstNow.setUTCHours(0, 0, 0, 0);
  return new Date(jstNow.getTime() - 9 * 60 * 60 * 1000);
}

// ☑ (AIX約束あり・未送信) → ・(未対応) → ✅ (AIX済み) の優先度
function getMarkPriority(staffInfo: { hasAix: boolean; hasStaff: boolean } | undefined): number {
  if (!staffInfo) return 1;      // ・未対応
  if (staffInfo.hasAix) return 2; // ✅ AIX済み（後回しでOK）
  return 0;                       // ☑ AIX未送信（約束あり・最優先）
}

const MOTIVATIONS = [
  "全部✅にしたら今日は最強の一日や🔥",
  "✅埋めた分だけ契約に近づく⚡️",
  "今日の行動が来月の結果になる🎯",
  "全✅目指してGO🚀",
  "鈴木なら絶対全部いける💪",
];

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // クールダウンガード（90分）
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

  // LINE グループID・トークン
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
      { ok: false, error: "LINE_STAFF_GROUP_ID not configured" },
      { status: 500 }
    );
  }

  const token =
    process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ??
    process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "LINE token not configured" }, { status: 500 });
  }

  // is_flagged=true の会話を取得（申込中以降は除外）
  const { data: flaggedConvs, error: convError } = await supabase
    .from("conversations")
    .select("id, customer_name, account, last_message, last_sender, updated_at, status")
    .eq("is_flagged", true)
    .not("status", "in", "(applying,screening,contract,closed_won,closed_lost)")
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

  const todayStart = getTodayJSTStart();
  const convIds = convList.map((c) => c.id);

  // 今日のスタッフメッセージ（✅/☑判定用）
  const { data: todayStaffMsgs } = await supabase
    .from("messages")
    .select("conversation_id, is_aix_generated")
    .eq("sender", "staff")
    .gte("created_at", todayStart.toISOString())
    .in("conversation_id", convIds);

  const staffMsgMap = new Map<string, { hasAix: boolean; hasStaff: boolean }>();
  for (const msg of todayStaffMsgs ?? []) {
    const existing = staffMsgMap.get(msg.conversation_id) ?? { hasAix: false, hasStaff: false };
    staffMsgMap.set(msg.conversation_id, {
      hasAix: existing.hasAix || !!msg.is_aix_generated,
      hasStaff: true,
    });
  }

  function getActionMark(convId: string): string {
    const info = staffMsgMap.get(convId);
    if (!info) return "・";
    return info.hasAix ? "✅" : "☑";
  }

  // 直近30日のメッセージ（AIX無視日数カウント用）
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const { data: recentMsgs } = await supabase
    .from("messages")
    .select("conversation_id, sender, is_aix_generated, created_at")
    .in("conversation_id", convIds)
    .gte("created_at", thirtyDaysAgo.toISOString())
    .order("created_at", { ascending: true });

  const msgsByConv = new Map<
    string,
    Array<{ sender: string; is_aix_generated: boolean | null; created_at: string }>
  >();
  for (const msg of recentMsgs ?? []) {
    const arr = msgsByConv.get(msg.conversation_id) ?? [];
    arr.push(msg);
    msgsByConv.set(msg.conversation_id, arr);
  }

  /**
   * AIXを送った日（JST）のうち、その後にお客様返信がなかった日数を返す。
   * 1日に何回AIX送っても1カウント。3以上で要対応から自動解除。
   */
  function getAixIgnoredDayCount(convId: string): number {
    const msgs = msgsByConv.get(convId) ?? [];

    // JST日付ごとに最後のAIX送信時刻を記録
    const aixDayLastTime = new Map<string, Date>();
    for (const msg of msgs) {
      if (msg.sender === "staff" && msg.is_aix_generated) {
        const jstMs = new Date(msg.created_at).getTime() + 9 * 3600000;
        const dateStr = new Date(jstMs).toISOString().slice(0, 10); // YYYY-MM-DD (JST)
        const msgTime = new Date(msg.created_at);
        const prev = aixDayLastTime.get(dateStr);
        if (!prev || msgTime > prev) {
          aixDayLastTime.set(dateStr, msgTime);
        }
      }
    }

    if (aixDayLastTime.size === 0) return 0;

    let ignored = 0;
    for (const lastAixTime of aixDayLastTime.values()) {
      const customerReplied = msgs.some(
        (m) => m.sender === "customer" && new Date(m.created_at) > lastAixTime
      );
      if (!customerReplied) ignored++;
    }

    return ignored;
  }

  // AIX 3日無視されたお客さんを自動解除
  const toRemove = convList.filter((c) => getAixIgnoredDayCount(c.id) >= 3);

  if (toRemove.length > 0) {
    await supabase
      .from("conversations")
      .update({ is_flagged: false })
      .in("id", toRemove.map((c) => c.id));

    const removeNames = toRemove.map((c) => `・${c.customer_name || "名称未設定"}`).join("\n");
    const removeMsg = [
      "【ターゲットリスト 自動解除】",
      "",
      "AIXを3日間無視されたため要対応から外しました：",
      removeNames,
    ].join("\n");

    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: targetId, messages: [{ type: "text", text: removeMsg }] }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  // 解除済みを除いたリスト
  const removeIds = new Set(toRemove.map((c) => c.id));
  const activeList = convList.filter((c) => !removeIds.has(c.id));

  if (activeList.length === 0) {
    return NextResponse.json({ ok: true, removed: toRemove.length, sent: 0 });
  }

  // ソート: ① ☑(AIX約束未送信) → ・(未対応) → ✅(AIX済み) ② 直近やり取り順（updated_at DESC）
  const sorted = [...activeList].sort((a, b) => {
    const ma = getMarkPriority(staffMsgMap.get(a.id));
    const mb = getMarkPriority(staffMsgMap.get(b.id));
    if (ma !== mb) return ma - mb;

    return (
      new Date(b.updated_at ?? "").getTime() -
      new Date(a.updated_at ?? "").getTime()
    );
  });

  const hour = getJSTHour();

  const lines = sorted.map((c) => {
    const mark = getActionMark(c.id);
    const name = c.customer_name || "名称未設定";
    return `${mark}${name}`;
  });

  const motivation = MOTIVATIONS[Math.floor(Date.now() / (24 * 3600 * 1000)) % MOTIVATIONS.length];

  const message = [
    "【しょーへいの今日のターゲット全リスト】",
    "",
    "► 決まる（最優先）",
    lines.join("\n"),
    "",
    motivation,
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

  await supabase.from("hanbancyo_settings").upsert(
    { key: "announce_hot_last_sent_at", value: new Date().toISOString() },
    { onConflict: "key" }
  );

  return NextResponse.json({
    ok: true,
    flagged: convList.length,
    removed: toRemove.length,
    sent: sorted.length,
  });
}
