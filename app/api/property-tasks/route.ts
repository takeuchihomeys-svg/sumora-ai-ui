import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

type Customer = {
  id: string;
  customer_name: string;
  status: string;
  desired_area: string;
  last_property_sent_at: string | null;
};

function needsActionToday(c: Customer): boolean {
  if (c.status === "pending") return false;
  if (c.status === "new_inquiry") return true;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (c.status === "hot") {
    if (!c.last_property_sent_at) return true;
    return new Date(c.last_property_sent_at) < todayStart;
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

// GET: 今日アクション必要な顧客リスト
export async function GET() {
  const { data, error } = await supabase
    .from("property_customers")
    .select("id, customer_name, status, desired_area, last_property_sent_at")
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

// POST: 完了マーク（last_property_sent_at を更新）
export async function POST(req: NextRequest) {
  const { customer_id, upgrade_to_hot } = await req.json() as {
    customer_id: string;
    upgrade_to_hot?: boolean;
  };

  const update: Record<string, unknown> = {
    last_property_sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (upgrade_to_hot) update.status = "hot";

  const { error } = await supabase
    .from("property_customers")
    .update(update)
    .eq("id", customer_id);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
