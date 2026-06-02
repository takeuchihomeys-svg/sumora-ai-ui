import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export async function GET() {
  const [{ data, error }, { data: convData }] = await Promise.all([
    supabase.from("property_customers").select("*").order("created_at", { ascending: false }),
    supabase.from("conversations").select("property_customer_id").not("property_customer_id", "is", null),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const linkedIds = new Set((convData || []).map((r) => r.property_customer_id).filter(Boolean));
  const result = (data || []).map((c) => ({ ...c, is_linked: linkedIds.has(c.id) }));
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
