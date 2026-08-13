import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 15;

// CORS headers — allow Chrome extension origins
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ─── Levenshtein distance ────────────────────────────────────────────────────
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

function stringSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.trim().toLowerCase();
  const na = norm(a);
  const nb = norm(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

// ─── OPTIONS (preflight) ─────────────────────────────────────────────────────
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// ─── GET handler ─────────────────────────────────────────────────────────────
// Usage: GET /api/check-property-duplicate?property_name=xxx&room_no=xxx&property_customer_id=xxx
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const queryPropertyName = searchParams.get("property_name") ?? "";
  const queryRoomNo = searchParams.get("room_no") ?? "";
  const propertyCustomerId = searchParams.get("property_customer_id") ?? "";

  if (!propertyCustomerId) {
    return NextResponse.json(
      { error: "property_customer_id は必須です" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  // "list mode": no name/room_no — return every sent property for this customer
  // Used by score-overlay.js to prefetch and do local duplicate matching
  if (!queryPropertyName && !queryRoomNo) {
    const { data: listData, error: listError } = await supabase
      .from("sent_properties")
      .select("property_name, room_no, sent_at")
      .eq("property_customer_id", propertyCustomerId)
      .order("sent_at", { ascending: false });
    if (listError) {
      return NextResponse.json(
        { error: listError.message },
        { status: 500, headers: CORS_HEADERS }
      );
    }
    return NextResponse.json({ list: listData ?? [] }, { headers: CORS_HEADERS });
  }

  // Fetch all sent properties for this customer
  const { data, error } = await supabase
    .from("sent_properties")
    .select("property_name, room_no, sent_at")
    .eq("property_customer_id", propertyCustomerId)
    .order("sent_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500, headers: CORS_HEADERS }
    );
  }

  const rows = (data ?? []) as Array<{
    property_name: string;
    room_no: string;
    sent_at: string;
  }>;

  // Fuzzy match: room_no exact match AND property_name similarity > 70%
  // Also catch: property_name similarity > 70% alone (same building, different room note)
  const normalizedRoomNo = queryRoomNo.trim().toLowerCase();
  const matches = rows.filter((row) => {
    const rowRoom = row.room_no.trim().toLowerCase();
    const roomMatch = normalizedRoomNo ? rowRoom === normalizedRoomNo : false;
    const nameSim = queryPropertyName
      ? stringSimilarity(row.property_name, queryPropertyName)
      : 0;

    // Primary: exact room_no match
    if (roomMatch) return true;
    // Secondary: property_name similarity > 70% AND room_no matches
    if (nameSim > 0.7 && roomMatch) return true;
    return false;
  });

  return NextResponse.json(
    {
      is_duplicate: matches.length > 0,
      duplicates: matches.map((r) => ({
        property_name: r.property_name,
        room_no: r.room_no,
        sent_at: r.sent_at,
      })),
    },
    { headers: CORS_HEADERS }
  );
}
