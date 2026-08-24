import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const maxDuration = 10;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { property_customer_id, customer_name, site, candidates } = body as {
      property_customer_id?: string | null;
      customer_name?: string | null;
      site?: string | null;
      candidates: Array<{ rank: number; name: string; rent?: number | null; floor_plan?: string | null; walk_minutes?: number | null; ad_months?: number | null }>;
    };

    if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
      return NextResponse.json({ ok: false, error: "candidates required" }, { status: 400, headers: CORS });
    }

    const { error } = await supabase.from("property_candidate_pools").insert({
      property_customer_id: property_customer_id || null,
      customer_name: customer_name || null,
      site: site || null,
      candidates,
    });

    if (error) throw error;

    return NextResponse.json({ ok: true, count: candidates.length }, { headers: CORS });
  } catch (e) {
    console.error("[log-property-candidates]", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: CORS }
    );
  }
}
