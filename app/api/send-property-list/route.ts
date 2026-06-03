import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const TOKEN = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? "";

type Customer = {
  id: string;
  customer_name: string;
  status: string;
  desired_area: string;
  last_property_sent_at: string | null;
  next_due_label: string;
  days_since_sent: number | null;
};

const STATUS_EMOJI: Record<string, string> = {
  new_inquiry:     "🆕",
  hot:             "🔥",
  property_search: "🏠",
};

const STATUS_LABEL: Record<string, string> = {
  new_inquiry:     "新規",
  hot:             "毎日",
  property_search: "3日ごと",
};

async function getTodayList(): Promise<Customer[]> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL ?? "https://sumora-ai-ui.vercel.app"}/api/property-tasks`);
  const data = await res.json() as { ok: boolean; customers: Customer[] };
  return data.ok ? data.customers : [];
}

async function getGroupId(): Promise<string | null> {
  const { data } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", "group_id")
    .single();
  return data?.value ?? null;
}

async function pushToLine(to: string, text: string) {
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text }],
    }),
  });
}

export async function POST() {
  const groupId = await getGroupId();
  if (!groupId) {
    return NextResponse.json({ ok: false, error: "グループIDが未設定です" }, { status: 400 });
  }

  const customers = await getTodayList();

  if (customers.length === 0) {
    await pushToLine(groupId, "✅ 今日の物件出し対象者はいません！");
    return NextResponse.json({ ok: true, count: 0 });
  }

  const today = new Date().toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" });
  const lines = [
    `📋 ${today} 物件出しリスト（${customers.length}名）`,
    "─────────────────",
    ...customers.map((c, i) => {
      const emoji = STATUS_EMOJI[c.status] ?? "🏠";
      const label = STATUS_LABEL[c.status] ?? "";
      const area = c.desired_area ? `　${c.desired_area}` : "";
      const days = c.days_since_sent !== null ? `（${c.days_since_sent}日前送信）` : "（未送信）";
      return `${i + 1}. ${emoji}【${label}】${c.customer_name}様${area}${days}`;
    }),
    "─────────────────",
    "完了したら「完了 [名前]」と返信してください",
  ];

  await pushToLine(groupId, lines.join("\n"));
  return NextResponse.json({ ok: true, count: customers.length });
}
