import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

function getJSTHour(): number {
  return (new Date().getUTCHours() + 9) % 24;
}

const COOLDOWN_KEY = "announce_sonota_last_sent_at";
const COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20時間（1日1回ガード）

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // クールダウンガード（20時間）
  const { data: cooldownRow } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", COOLDOWN_KEY)
    .maybeSingle();
  if (cooldownRow?.value) {
    const lastSentAt = new Date(cooldownRow.value).getTime();
    if (Date.now() - lastSentAt < COOLDOWN_MS) {
      return NextResponse.json({ ok: true, skipped: true, reason: "cooldown (20h)" });
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

  // Step1: その他の会話 = is_flagged=false + 申込以降除外 + property_customer_id あり
  const { data: convs, error: convError } = await supabase
    .from("conversations")
    .select("id, customer_name, property_customer_id, line_status")
    .eq("is_flagged", false)
    .not("status", "in", "(applying,screening,contract,closed_won,closed_lost)")
    .not("property_customer_id", "is", null)
    .neq("line_status", "blocked")
    .limit(300);

  if (convError) {
    console.error("announce-sonota conv error:", convError);
    return NextResponse.json({ ok: false, error: convError.message }, { status: 500 });
  }

  if (!convs || convs.length === 0) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no sonota customers" });
  }

  // Step2: 対応する property_customers を取得（送信/確認日時）
  const pcIds = convs.map((c) => c.property_customer_id as string).filter(Boolean);
  const { data: pcs } = await supabase
    .from("property_customers")
    .select("id, customer_name, last_property_sent_at, property_viewed_at, status")
    .in("id", pcIds)
    .not("status", "in", "(applying,screening,contract,closed_won,closed_lost)");

  const pcMap = new Map((pcs ?? []).map((pc) => [pc.id as string, pc]));

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Step3: 今日リストに出す顧客をフィルタ
  // ✅ = 7日以内に送済み → 出ない
  // ✅ = 7日以上前に送済み → 出る（再送時期）
  // ☑ = property_viewed_at あり → 常に出る（要対応に昇格するまで）
  // ・ = 未送信 → 出る
  const toShow = convs
    .map((c) => ({
      convId: c.id,
      name: c.customer_name as string | null,
      pc: pcMap.get(c.property_customer_id as string) ?? null,
    }))
    .filter((c) => c.pc != null)
    .filter((c) => {
      const pc = c.pc!;
      const sentRecently =
        pc.last_property_sent_at &&
        new Date(pc.last_property_sent_at as string) > sevenDaysAgo;
      const hasViewed = !!(pc.property_viewed_at);
      // 7日以内に送って、かつ確認もされていない → 非表示
      return !sentRecently || hasViewed;
    });

  if (toShow.length === 0) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "all customers sent within 7 days",
    });
  }

  function getMark(pc: {
    last_property_sent_at: string | null;
    property_viewed_at: string | null;
  }): string {
    if (pc.property_viewed_at) return "☑";
    if (!pc.last_property_sent_at) return "・";
    return "✅"; // 7日以上前に送済み → 再送時期
  }

  function getMarkPriority(mark: string): number {
    if (mark === "☑") return 0; // 確認済み（最優先フォロー）
    if (mark === "・") return 1; // 未送信
    return 2;                    // ✅ 再送時期
  }

  // ソート: ☑ → ・ → ✅、同マーク内は最終送信が古い順
  const sorted = [...toShow].sort((a, b) => {
    const ma = getMark(a.pc!);
    const mb = getMark(b.pc!);
    const pa = getMarkPriority(ma);
    const pb = getMarkPriority(mb);
    if (pa !== pb) return pa - pb;
    const sa = a.pc!.last_property_sent_at
      ? new Date(a.pc!.last_property_sent_at as string).getTime()
      : 0;
    const sb = b.pc!.last_property_sent_at
      ? new Date(b.pc!.last_property_sent_at as string).getTime()
      : 0;
    return sa - sb;
  });

  const hour = getJSTHour();

  const lines = sorted.slice(0, 50).map((c) => {
    const mark = getMark(c.pc!);
    const name = c.name ?? c.pc!.customer_name ?? "名称未設定";
    return `${mark}${name}`;
  });

  const suffix = sorted.length > 50 ? `\n（他 ${sorted.length - 50} 名）` : "";

  const bodyText = [
    "【その他 本日のリスト】",
    "",
    lines.join("\n") + suffix,
    "",
    "✅=再送時期　☑=確認済み追跡中　・=未送信",
    "良い反応あれば要対応に昇格 👆",
    "",
    `AIX LINX より ${hour}:30`,
  ].join("\n");

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: targetId,
      messages: [{ type: "text", text: bodyText }],
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("announce-sonota LINE error:", errText);
    return NextResponse.json({ ok: false, error: errText }, { status: 500 });
  }

  await supabase
    .from("hanbancyo_settings")
    .upsert(
      { key: COOLDOWN_KEY, value: new Date().toISOString() },
      { onConflict: "key" }
    );

  return NextResponse.json({
    ok: true,
    total: convs.length,
    shown: Math.min(sorted.length, 50),
    skipped_7day: convs.length - sorted.length,
  });
}
