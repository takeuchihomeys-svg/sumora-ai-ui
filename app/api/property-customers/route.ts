import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// 今日まだ未対応かどうか判定
function needsActionToday(c: { status: string; last_property_sent_at: string | null; hot_confirmed_at?: string | null }): boolean {
  if (c.status === "new_inquiry") return true;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (c.status === "hot") {
    const sent = c.last_property_sent_at && new Date(c.last_property_sent_at) >= todayStart;
    const confirmed = c.hot_confirmed_at && new Date(c.hot_confirmed_at) >= todayStart;
    return !sent && !confirmed;
  }
  if (c.status === "property_search") {
    if (!c.last_property_sent_at) return true;
    return (now.getTime() - new Date(c.last_property_sent_at).getTime()) / 86400000 >= 3;
  }
  return false;
}

// 全員完了したときだけ🎉を売上番長グループに送る
async function checkAllDone(): Promise<void> {
  try {
    const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
    if (!token) return;
    let groupId: string | null = process.env.LINE_STAFF_GROUP_ID ?? null;
    if (!groupId) {
      const { data: grp } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").single();
      groupId = (grp?.value as string) ?? null;
    }
    if (!groupId) return;

    const { data } = await supabase
      .from("property_customers")
      .select("status, last_property_sent_at, hot_confirmed_at")
      .in("status", ["new_inquiry", "hot", "property_search"]);
    if (!data || data.length === 0) return;

    const remaining = (data as Array<{ status: string; last_property_sent_at: string | null; hot_confirmed_at: string | null }>)
      .filter(needsActionToday).length;
    if (remaining > 0) return;

    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: groupId, messages: [{ type: "text", text: "🎉 本日の物件出し全員完了！\nお疲れ様でした！" }] }),
    });
  } catch { /* 失敗は無視 */ }
}

export async function GET() {
  const [{ data, error }, { data: convData }] = await Promise.all([
    supabase.from("property_customers").select("*").order("updated_at", { ascending: false }),
    supabase
      .from("conversations")
      .select("id, property_customer_id, last_message, last_sender, updated_at, account, status, profile_image_url, customer_name")
      .not("property_customer_id", "is", null),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const convMap = new Map((convData || []).map((c) => [c.property_customer_id, c]));
  const result = (data || []).map((c) => ({
    ...c,
    is_linked: convMap.has(c.id),
    linked_conversation: convMap.get(c.id) ?? null,
  }));
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { error, data } = await supabase
    .from("property_customers")
    .insert(body)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { id, ...fields } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  // 物件送信（last_property_sent_at 更新）時の自動ステータス処理
  if ("last_property_sent_at" in fields && !("status" in fields)) {
    const { data: current } = await supabase
      .from("property_customers")
      .select("id, status, property_send_count, line_user_id")
      .eq("id", id)
      .single();

    if (current?.status === "new_inquiry") {
      // 新規問い合わせ → 毎日物件出しに自動昇格
      fields.status = "hot";
      fields.property_send_count = 1;
    } else if (current?.status === "hot") {
      // 毎日物件出しの場合: 返信状況を確認してカウント管理
      const newCount = ((current.property_send_count as number) ?? 0) + 1;

      // 紐付き会話の最終送信者を確認（返信があればカウントリセット）
      let lastSender: string | null = null;
      if (current.line_user_id) {
        const { data: conv } = await supabase
          .from("conversations")
          .select("last_sender")
          .eq("line_user_id", current.line_user_id as string)
          .order("updated_at", { ascending: false })
          .limit(1)
          .single();
        lastSender = conv?.last_sender ?? null;
      }

      const hasCustomerReply = lastSender === "customer";
      if (hasCustomerReply) {
        // お客さんから返信あり → カウントリセット
        fields.property_send_count = 1;
      } else if (newCount >= 2) {
        // 返信なしで2回送信 → 物件出しにダウングレード
        fields.status = "property_search";
        fields.property_send_count = 0;
      } else {
        fields.property_send_count = newCount;
      }
    }
  }

  const { error, data } = await supabase
    .from("property_customers")
    .update(fields)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 物件送った or 確認済みのとき: 全員完了チェック（fire-and-forget）
  if ("last_property_sent_at" in body || "property_viewed_at" in body) {
    void checkAllDone();
  }

  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("property_customers")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
