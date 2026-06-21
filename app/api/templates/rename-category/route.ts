import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export async function POST(req: NextRequest) {
  const { oldCategory, newCategory } = await req.json() as { oldCategory: string; newCategory: string };
  if (!oldCategory?.trim() || !newCategory?.trim()) {
    return NextResponse.json({ ok: false, error: "oldCategory と newCategory は必須" }, { status: 400 });
  }
  if (oldCategory.trim() === newCategory.trim()) {
    return NextResponse.json({ ok: true });
  }

  const { error } = await supabase
    .from("templates")
    .update({ category: newCategory.trim() })
    .eq("category", oldCategory.trim());

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
