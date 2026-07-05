import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

const STATUS_LABELS: Record<string, string> = {
  hearing:              "ヒアリング中",
  first_reply:          "初回返信",
  condition_hearing:    "条件ヒアリング",
  property_search:      "物件探し",
  proposing:            "物件提案中",
  property_recommendation: "物件提案中",
  viewing:              "内見調整",
  estimate_request:     "見積依頼",
  availability_check:   "空室確認",
  applying:             "申込中",
  screening:            "審査中",
  contract:             "契約中",
};

function getJSTHour(): number {
  return (new Date().getUTCHours() + 9) % 24;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // 9:00〜19:00 JST の間だけ配信
  const jstHour = getJSTHour();
  if (jstHour < 9 || jstHour >= 19) {
    return NextResponse.json({ ok: true, skipped: true, reason: `JST ${jstHour}時 — 配信時間外（9:00〜19:00のみ）` });
  }

  // 要対応の会話を全取得
  const { data: flagged, error } = await supabase
    .from("conversations")
    .select("id, customer_name, status, last_message, last_sender, updated_at")
    .eq("is_flagged", true)
    .not("status", "in", "(closed_won,closed_lost)")
    .order("updated_at", { ascending: true })
    .limit(50);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!flagged || flagged.length === 0) {
    return NextResponse.json({ ok: true, sent: false, count: 0 });
  }

  // LINEグループ設定（物件出しグループ）
  let groupId: string | null = process.env.LINE_STAFF_GROUP_ID ?? null;
  if (!groupId) {
    const { data } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
    groupId = (data?.value as string) ?? null;
  }
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;

  if (!groupId || !token) {
    return NextResponse.json({ ok: false, error: "LINE config missing" }, { status: 500 });
  }

  // メッセージ組み立て
  const lines = flagged.map((c, i) => {
    const name = (c.customer_name as string) || "名称未設定";
    const statusLabel = STATUS_LABELS[c.status as string] ?? (c.status as string) ?? "";
    const preview = c.last_sender === "customer" && c.last_message
      ? `「${(c.last_message as string).slice(0, 30)}${(c.last_message as string).length > 30 ? "…" : ""}」`
      : "";
    return `${i + 1}. ${name}${statusLabel ? `（${statusLabel}）` : ""}${preview ? `\n   ${preview}` : ""}`;
  });

  const text = [
    `【要対応】返信が必要なお客様が${flagged.length}名います！！`,
    "",
    ...lines,
    "",
    "⚡ 今すぐLINEで返信してあげよ！！",
  ].join("\n");

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: groupId, messages: [{ type: "text", text }] }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("[flagged-reminder] LINE push error:", body);
    return NextResponse.json({ ok: false, error: body }, { status: 500 });
  }

  return NextResponse.json({ ok: true, sent: true, count: flagged.length });
}
