import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

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

  // 物件送信（last_property_sent_at 更新）かつ新規問い合わせ → 毎日物件出しに自動昇格
  if ("last_property_sent_at" in fields && !("status" in fields)) {
    const { data: current } = await supabase
      .from("property_customers")
      .select("status")
      .eq("id", id)
      .single();
    if (current?.status === "new_inquiry") {
      fields.status = "hot";
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
