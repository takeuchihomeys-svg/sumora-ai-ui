import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { ParsedProperty, parsePropertyFromImage, calcScore } from "@/app/lib/property-scoring";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { base64?: string; mediaType?: string; property?: ParsedProperty; parse_only?: boolean };

    let prop: ParsedProperty | null = body.property ?? null;
    if (!prop && body.base64 && body.mediaType) {
      prop = await parsePropertyFromImage(body.base64, body.mediaType);
    }
    if (!prop) {
      return NextResponse.json({ ok: false, error: "物件情報を読み取れませんでした" }, { status: 400 });
    }

    // 読み取りのみモード（マッチングはしない）
    if (body.parse_only) {
      return NextResponse.json({ ok: true, property: prop });
    }

    const { data: customers, error } = await supabase
      .from("property_customers")
      .select("id, customer_name, desired_area, area, rent_max, max_rent, floor_plan, layout, building_age, walk_minutes, floor_area_min, floor_area_max, pet, status")
      .in("status", ["hot", "property_search", "new_inquiry"]);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    const results: Array<{
      id: string;
      customer_name: string;
      score: number;
      breakdown: Array<{ label: string; point: number; note: string }>;
    }> = [];

    for (const c of (customers ?? [])) {
      const r = calcScore(c as Record<string, unknown>, prop);
      if (r.matched) {
        results.push({ id: c.id as string, customer_name: c.customer_name as string, score: r.score, breakdown: r.breakdown });
      }
    }

    results.sort((a, b) => b.score - a.score);

    return NextResponse.json({ ok: true, property: prop, matched: results, total: (customers ?? []).length });
  } catch (e) {
    console.error("[match-property-customers]", e);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
