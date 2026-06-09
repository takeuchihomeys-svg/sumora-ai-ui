import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

type Customer = {
  id: string;
  customer_name: string;
  status: string;
  desired_area: string;
  last_property_sent_at: string | null;
  hot_confirmed_at: string | null;
  property_viewed_at?: string | null;
};

function needsActionToday(c: Customer): boolean {
  if (c.status === "pending") return false;
  if (c.status === "new_inquiry") return true;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (c.status === "hot") {
    const sentToday      = c.last_property_sent_at && new Date(c.last_property_sent_at) >= todayStart;
    const confirmedToday = c.hot_confirmed_at      && new Date(c.hot_confirmed_at)      >= todayStart;
    const viewedToday    = c.property_viewed_at    && new Date(c.property_viewed_at)    >= todayStart;
    return !sentToday && !confirmedToday && !viewedToday;
  }
  if (c.status === "property_search") {
    if (!c.last_property_sent_at) return true;
    const diff = (now.getTime() - new Date(c.last_property_sent_at).getTime()) / 86400000;
    return diff >= 3;
  }
  return false;
}

function nextDueLabel(c: Customer): string {
  if (c.status === "hot") return "毎日";
  if (c.status === "new_inquiry") return "今すぐ";
  if (c.status === "property_search") return "3日ごと";
  return "";
}

// 全員完了したときだけ🎉を売上番長グループに送る
async function checkAllDone(): Promise<void> {
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  if (!token) return;

  let groupId: string | null = process.env.LINE_STAFF_GROUP_ID ?? null;
  if (!groupId) {
    const { data } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").single();
    groupId = (data?.value as string) ?? null;
  }
  if (!groupId) return;

  const { data } = await supabase
    .from("property_customers")
    .select("status, last_property_sent_at, hot_confirmed_at, property_viewed_at")
    .in("status", ["new_inquiry", "hot", "property_search"]);
  if (!data || data.length === 0) return;

  const remaining = (data as Customer[]).filter(needsActionToday).length;
  if (remaining > 0) return;

  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: groupId, messages: [{ type: "text", text: "🎉 本日の物件出し全員完了！\nお疲れ様でした！" }] }),
  });
}

// GET: 今日アクション必要な顧客リスト
export async function GET() {
  const { data, error } = await supabase
    .from("property_customers")
    .select("id, customer_name, status, desired_area, last_property_sent_at, hot_confirmed_at, property_viewed_at")
    .not("status", "eq", "pending")
    .order("status", { ascending: true });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const customers = (data as Customer[]).filter(needsActionToday).map((c) => ({
    ...c,
    next_due_label: nextDueLabel(c),
    days_since_sent: c.last_property_sent_at
      ? Math.floor((Date.now() - new Date(c.last_property_sent_at).getTime()) / 86400000)
      : null,
  }));

  return NextResponse.json({ ok: true, customers });
}

// POST: 完了マーク（物件送信 or 確認済み）+ LINEグループ✅通知
export async function POST(req: NextRequest) {
  const { customer_id, upgrade_to_hot, action } = await req.json() as {
    customer_id: string;
    upgrade_to_hot?: boolean;
    action?: "send" | "confirm";
  };

  const now = new Date().toISOString();
  const update: Record<string, unknown> = { updated_at: now };

  if (action === "confirm") {
    update.hot_confirmed_at = now;
  } else {
    update.last_property_sent_at = now;
  }
  if (upgrade_to_hot) update.status = "hot";

  const { error } = await supabase
    .from("property_customers")
    .update(update)
    .eq("id", customer_id);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // hotに格上げした場合は会話の🔥マークも同時更新
  if (upgrade_to_hot) {
    await supabase
      .from("conversations")
      .update({ is_hot: true })
      .eq("property_customer_id", customer_id)
      .eq("is_hot", false);
  }

  // 全員完了チェック → 完了したら🎉をグループに通知（fire-and-forget）
  void checkAllDone().catch(() => {});

  return NextResponse.json({ ok: true });
}
