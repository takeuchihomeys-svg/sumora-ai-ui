import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const ACCOUNT_LABEL: Record<string, string> = {
  sumora: "スモラ", ieyasu: "イエヤス", giga: "ギガ賃貸", hasu: "ハス",
};

function relTime(d?: string | null): string {
  if (!d) return "不明";
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

function getJSTHour(): number {
  return (new Date().getUTCHours() + 9) % 24;
}

// 物件出しが必要か判定
function needsPropertyAction(status: string, lastSentAt: string | null): boolean {
  if (status === "new_inquiry") return true;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (status === "hot") return !lastSentAt || new Date(lastSentAt) < today;
  if (status === "property_search") {
    if (!lastSentAt) return true;
    return (Date.now() - new Date(lastSentAt).getTime()) / 86400000 >= 3;
  }
  return false;
}

const PROP_STATUS_LABEL: Record<string, string> = {
  new_inquiry: "新規",
  hot: "毎日出し",
  property_search: "物件出し",
};

export async function GET(req: NextRequest) {
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

  // ① 🔥マークされた会話を取得
  const [{ data: hotConvs }, { data: propCustomers }] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, customer_name, account, last_message, last_sender, updated_at")
      .eq("is_hot", true)
      .order("updated_at", { ascending: false }),

    // ② 物件出し要のお客さん（hot/new_inquiry/property_search）
    supabase
      .from("property_customers")
      .select("id, customer_name, status, last_property_sent_at, account")
      .in("status", ["new_inquiry", "hot", "property_search"])
      .order("updated_at", { ascending: false })
      .limit(30),
  ]);

  // 物件出しが実際に必要な人だけに絞る
  type PropCustomer = { id: string; customer_name: string | null; status: string | null; last_property_sent_at: string | null; account: string | null };
  const needsPropList = (propCustomers as PropCustomer[] ?? []).filter((c) =>
    needsPropertyAction(c.status ?? "", c.last_property_sent_at ?? null)
  );

  // どちらも0件ならスキップ
  if ((!hotConvs || hotConvs.length === 0) && needsPropList.length === 0) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no actions needed" });
  }

  const hour = getJSTHour();
  const sections: string[] = [];

  // 🔥セクション
  if (hotConvs && hotConvs.length > 0) {
    type HotConv = { id: string; customer_name: string | null; account: string | null; last_message: string | null; last_sender: string | null; updated_at: string | null };
    const lines = (hotConvs as HotConv[]).map((c, i) => {
      const name = c.customer_name || "名称未設定";
      const acct = ACCOUNT_LABEL[c.account ?? "sumora"] ?? "スモラ";
      const time = relTime(c.updated_at);
      const status = c.last_sender === "customer" ? "⏰ 未返信" : "✅ 返信済";
      const preview = (c.last_message ?? "").slice(0, 18) + ((c.last_message ?? "").length > 18 ? "…" : "");
      return `${i + 1}. ${name}（${acct}）\n   ${status} ${time}\n   └ ${preview}`;
    });
    sections.push(`🔥 あついお客さん（${hotConvs.length}人）\n\n${lines.join("\n\n")}`);
  }

  // 📦物件出し要セクション
  if (needsPropList.length > 0) {
    const lines = needsPropList.map((c, i) => {
      const name = c.customer_name || "名称未設定";
      const label = PROP_STATUS_LABEL[c.status ?? ""] ?? c.status ?? "";
      const sentLabel = c.last_property_sent_at
        ? `${Math.floor((Date.now() - new Date(c.last_property_sent_at).getTime()) / 86400000)}日前送信`
        : "未送信";
      return `${i + 1}. ${name} — ${label} ${sentLabel}`;
    });
    sections.push(`📦 物件出し要（${needsPropList.length}人）\n\n${lines.join("\n")}`);
  }

  const message = `${sections.join("\n\n——————\n\n")}\n\nAIX LINX より ${hour}:00`;

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: targetId, messages: [{ type: "text", text: message }] }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("announce-hot-customers LINE error:", text);
    return NextResponse.json({ ok: false, error: text }, { status: 500 });
  }

  return NextResponse.json({ ok: true, hot: hotConvs?.length ?? 0, needsProp: needsPropList.length });
}
