import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export async function POST(_req: NextRequest) {
  const { error } = await supabase.from("iyeyasu_page_views").insert({});
  if (error) {
    console.error("[track-view]", error.message);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
