import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export async function GET() {
  const { data, error } = await supabase
    .from("templates")
    .select("id, category, label, text, sort_order, requires_image, created_at")
    .order("category")
    .order("sort_order")
    .order("created_at");

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, templates: data ?? [] });
}

export async function POST(req: NextRequest) {
  const { category, label, text, requires_image } = await req.json() as { category: string; label: string; text: string; requires_image?: boolean };
  if (!label?.trim() || !text?.trim()) {
    return NextResponse.json({ ok: false, error: "label と text は必須" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("templates")
    .insert({ category: category?.trim() || "全般", label: label.trim(), text: text.trim(), requires_image: requires_image ?? false })
    .select()
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, template: data });
}

export async function PATCH(req: NextRequest) {
  const { updates } = await req.json() as { updates: Array<{ id: string; sort_order: number }> };
  if (!Array.isArray(updates) || updates.length === 0) {
    return NextResponse.json({ ok: false, error: "updates required" }, { status: 400 });
  }

  for (const { id, sort_order } of updates) {
    const { error } = await supabase.from("templates").update({ sort_order }).eq("id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function PUT(req: NextRequest) {
  const { id, category, label, text, requires_image } = await req.json() as { id: string; category: string; label: string; text: string; requires_image?: boolean };
  if (!id || !label?.trim() || !text?.trim()) {
    return NextResponse.json({ ok: false, error: "id, label, text は必須" }, { status: 400 });
  }

  const { error } = await supabase
    .from("templates")
    .update({ category: category?.trim() || "全般", label: label.trim(), text: text.trim(), requires_image: requires_image ?? false })
    .eq("id", id);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  const { error } = await supabase.from("templates").delete().eq("id", id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
