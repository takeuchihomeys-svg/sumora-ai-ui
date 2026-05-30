import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export async function GET() {
  const { data, error } = await supabase
    .from("templates")
    .select("id, category, label, text, sort_order, created_at")
    .order("category")
    .order("sort_order")
    .order("created_at");

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, templates: data ?? [] });
}

export async function POST(req: NextRequest) {
  const { category, label, text } = await req.json() as { category: string; label: string; text: string };
  if (!label?.trim() || !text?.trim()) {
    return NextResponse.json({ ok: false, error: "label と text は必須" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("templates")
    .insert({ category: category?.trim() || "全般", label: label.trim(), text: text.trim() })
    .select()
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, template: data });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  const { error } = await supabase.from("templates").delete().eq("id", id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
