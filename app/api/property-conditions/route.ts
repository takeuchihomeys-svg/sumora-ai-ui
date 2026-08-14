import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 15;

// CORS headers — allow Chrome extension origins
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// GET /api/property-conditions?property_customer_id=xxx
// Chrome拡張から直接呼ばれる。顧客の検索条件を返す。
export async function GET(req: NextRequest) {
  const propertyCustomerId =
    req.nextUrl.searchParams.get("property_customer_id");

  if (!propertyCustomerId) {
    return NextResponse.json(
      { error: "property_customer_id は必須です" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const { data, error } = await supabase
    .from("property_customers")
    .select(
      "desired_area, floor_plan, rent_max, walk_minutes, move_in_time, preferences, ng_points, pet, building_age, floor_area_min"
    )
    .eq("id", propertyCustomerId)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500, headers: CORS_HEADERS }
    );
  }

  if (!data) {
    return NextResponse.json(
      { error: "not found" },
      { status: 404, headers: CORS_HEADERS }
    );
  }

  return NextResponse.json(
    {
      conditions: {
        area: data.desired_area ?? null,
        floor_plan: data.floor_plan ?? null,
        rent_max: data.rent_max ?? null,
        walk_minutes: data.walk_minutes ?? null,
        move_in_time: data.move_in_time ?? null,
        preferences: data.preferences ?? null,
        ng_points: data.ng_points ?? null,
        pet: data.pet ?? null,
        building_age: data.building_age ?? null,
        floor_area_min: data.floor_area_min ?? null,
      },
    },
    { headers: CORS_HEADERS }
  );
}
