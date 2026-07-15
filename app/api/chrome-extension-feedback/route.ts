import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 30;

const VALID_CATEGORIES = ["station_area_mismatch", "station_map_request", "bug_report", "other"] as const;
const VALID_SITES = ["realpro", "itandi", "reins"] as const;

export async function POST(req: NextRequest) {
  let body: { category?: string; content?: string; area_raw?: string; token?: string; site?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const { category, content, area_raw, token, site } = body;
  if (!category || !VALID_CATEGORIES.includes(category as (typeof VALID_CATEGORIES)[number])) {
    return NextResponse.json({ ok: false, error: "invalid category" }, { status: 400 });
  }
  if (!content?.trim()) {
    return NextResponse.json({ ok: false, error: "content required" }, { status: 400 });
  }

  const { error } = await supabase.from("chrome_extension_feedback").insert({
    category,
    content: content.trim(),
    area_raw: area_raw?.trim() || null,
    token: token?.trim() || null,
    site: VALID_SITES.includes(site as (typeof VALID_SITES)[number]) ? site : null,
  });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function GET() {
  const { data, error } = await supabase
    .from("chrome_extension_feedback")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, feedbacks: data ?? [] });
}
