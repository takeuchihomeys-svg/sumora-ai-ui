import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const ACCOUNT_LABEL: Record<string, string> = {
  sumora: "スモラ",
  ieyasu: "イエヤス",
  giga: "ギガ賃貸",
  hasu: "ハス",
};

function getRelativeTime(dateString?: string | null): string {
  if (!dateString) return "不明";
  const diff = Date.now() - new Date(dateString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

// JST 時刻ラベル（アナウンスに使用）
function getJSTHour(): number {
  return new Date().getUTCHours() + 9;
}

export async function GET(req: NextRequest) {
  // Vercel cron の自動認証 or 手動呼び出し時はCRON_SECRETで検証
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const targetId = process.env.LINE_STAFF_GROUP_ID;
  if (!targetId) {
    return NextResponse.json({ ok: false, error: "LINE_STAFF_GROUP_ID not configured" }, { status: 500 });
  }

  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "LINE token not configured" }, { status: 500 });
  }

  // 🔥マークされた会話を取得
  const { data: hotConvs, error } = await supabase
    .from("conversations")
    .select("id, customer_name, account, last_message, last_sender, updated_at")
    .eq("is_hot", true)
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  if (!hotConvs || hotConvs.length === 0) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no hot customers" });
  }

  const hour = getJSTHour();
  const lines = (hotConvs as Array<{
    id: string;
    customer_name: string | null;
    account: string | null;
    last_message: string | null;
    last_sender: string | null;
    updated_at: string | null;
  }>).map((c, i) => {
    const name = c.customer_name || "名称未設定";
    const acct = ACCOUNT_LABEL[c.account ?? "sumora"] ?? c.account ?? "スモラ";
    const time = getRelativeTime(c.updated_at);
    const needsReply = c.last_sender === "customer";
    const status = needsReply ? "⏰ 未返信" : "✅ 返信済";
    const preview = (c.last_message ?? "").slice(0, 20) + ((c.last_message ?? "").length > 20 ? "…" : "");
    return `${i + 1}. ${name}（${acct}）\n   ${status} ${time}\n   └ ${preview}`;
  });

  const message = `🔥 あついお客さん（${hotConvs.length}人）\n${hour}:00 の物件出し確認\n\n${lines.join("\n\n")}\n\nAIX LINX より`;

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: targetId,
      messages: [{ type: "text", text: message }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("announce-hot-customers LINE error:", text);
    return NextResponse.json({ ok: false, error: text }, { status: 500 });
  }

  return NextResponse.json({ ok: true, sent: hotConvs.length });
}
