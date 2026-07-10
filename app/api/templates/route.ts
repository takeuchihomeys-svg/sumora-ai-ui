import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export type StructureBlock = { label: string; text: string };

export async function GET() {
  const { data, error } = await supabase
    .from("templates")
    .select("id, category, label, text, structure, sort_order, use_count, win_rate, requires_image, second_msg_type, second_msg_delay, recommend_shown_count, recommend_picked_count, status_pick_stats, created_at")
    .order("category")
    .order("sort_order")
    .order("created_at");

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, templates: data ?? [] });
}

export async function POST(req: NextRequest) {
  let category: string, label: string, text: string, structure: StructureBlock[] | null | undefined, requires_image: boolean | undefined;
  try {
    ({ category, label, text, structure, requires_image } = await req.json() as { category: string; label: string; text: string; structure?: StructureBlock[] | null; requires_image?: boolean });
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  if (!label?.trim() || !text?.trim()) {
    return NextResponse.json({ ok: false, error: "label と text は必須" }, { status: 400 });
  }

  const cat = category?.trim() || "全般";

  // 同カテゴリの最大 sort_order を取得して末尾に追加
  const { data: existing } = await supabase
    .from("templates")
    .select("sort_order")
    .eq("category", cat)
    .order("sort_order", { ascending: false })
    .limit(1);
  const maxOrder = existing?.[0]?.sort_order ?? -1;
  const newOrder = (maxOrder ?? -1) + 1;

  const { data, error } = await supabase
    .from("templates")
    .insert({ category: cat, label: label.trim(), text: text.trim(), structure: structure ?? null, requires_image: requires_image ?? false, sort_order: newOrder })
    .select()
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, template: data });
}

export async function PATCH(req: NextRequest) {
  let updates: Array<{ id: string; sort_order: number }>;
  try {
    ({ updates } = await req.json() as { updates: Array<{ id: string; sort_order: number }> });
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
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
  let id: string, category: string, label: string, text: string, structure: StructureBlock[] | null | undefined, requires_image: boolean | undefined, second_msg_type: string | null | undefined, second_msg_delay: number | null | undefined;
  try {
    ({ id, category, label, text, structure, requires_image, second_msg_type, second_msg_delay } = await req.json() as { id: string; category: string; label: string; text: string; structure?: StructureBlock[] | null; requires_image?: boolean; second_msg_type?: string | null; second_msg_delay?: number | null });
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  if (!id || !label?.trim() || !text?.trim()) {
    return NextResponse.json({ ok: false, error: "id, label, text は必須" }, { status: 400 });
  }

  const { error } = await supabase
    .from("templates")
    .update({ category: category?.trim() || "全般", label: label.trim(), text: text.trim(), structure: structure ?? null, requires_image: requires_image ?? false, second_msg_type: second_msg_type ?? null, second_msg_delay: second_msg_type ? (second_msg_delay ?? null) : null })
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
