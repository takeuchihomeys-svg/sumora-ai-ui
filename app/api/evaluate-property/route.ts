import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 15;

// CORS headers — allow Chrome extension origins
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

// ─── 間取りユーティリティ ────────────────────────────────────────────────────
// "1LDK" → { rooms: 1, type: "LDK" }, "ワンルーム"/"1R" → { rooms: 1, type: "R" }
function parseFloorPlan(fp: string): { rooms: number; type: string } | null {
  const s = fp.trim().toUpperCase().replace(/ワンルーム/g, "1R");
  const m = s.match(/(\d+)\s*(R|K|DK|LDK|SK|SDK|SLDK)/);
  if (!m) return null;
  return { rooms: parseInt(m[1], 10), type: m[2] };
}

// ─── リクエスト型 ────────────────────────────────────────────────────────────
interface PropertyInput {
  name: string;
  room_no: string;
  rent: number;
  admin_fee?: number;
  floor_plan?: string;
  area_sqm?: number;
  walk_minutes?: number;
  deposit?: number;
  key_money?: number;
  ad_months?: number;
  building_age?: number;
}

interface EvaluateRequestBody {
  property_customer_id?: string;
  property?: Partial<PropertyInput>;
}

// ─── OPTIONS (preflight) ─────────────────────────────────────────────────────
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// ─── POST handler ────────────────────────────────────────────────────────────
// POST /api/evaluate-property
// body: { property_customer_id, property: { name, room_no, rent, ... } }
export async function POST(req: NextRequest) {
  let body: EvaluateRequestBody;
  try {
    body = (await req.json()) as EvaluateRequestBody;
  } catch {
    return NextResponse.json(
      { error: "リクエストbodyのJSONが不正です" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const propertyCustomerId = body.property_customer_id;
  const property = body.property;

  if (!propertyCustomerId) {
    return NextResponse.json(
      { error: "property_customer_id は必須です" },
      { status: 400, headers: CORS_HEADERS }
    );
  }
  if (!property || typeof property.rent !== "number") {
    return NextResponse.json(
      { error: "property.rent（家賃・数値）は必須です" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const propertyName = (property.name ?? "").trim();
  const roomNo = (property.room_no ?? "").trim();

  // ── 顧客条件取得 ───────────────────────────────────────────────────────────
  const { data: customer, error: customerError } = await supabase
    .from("property_customers")
    .select(
      "rent_max, max_rent, walk_minutes, floor_plan, layout, floor_area_min, pet, building_age, desired_area, preferences, ng_points"
    )
    .eq("id", propertyCustomerId)
    .single();

  if (customerError || !customer) {
    return NextResponse.json(
      { error: `顧客が見つかりません: ${customerError?.message ?? "not found"}` },
      { status: 404, headers: CORS_HEADERS }
    );
  }

  const customerRentMax: number | null =
    (customer.rent_max as number | null) ?? (customer.max_rent as number | null) ?? null;
  const customerWalk: number | null = (customer.walk_minutes as number | null) ?? null;
  const customerFloorPlan: string | null =
    (customer.floor_plan as string | null) ?? (customer.layout as string | null) ?? null;
  const customerAreaMin: number | null = (customer.floor_area_min as number | null) ?? null;

  // ── 重複チェック（sent_properties） ───────────────────────────────────────
  const { data: sentRows, error: sentError } = await supabase
    .from("sent_properties")
    .select("property_name, room_no, sent_at")
    .eq("property_customer_id", propertyCustomerId)
    .order("sent_at", { ascending: false });

  if (sentError) {
    return NextResponse.json(
      { error: sentError.message },
      { status: 500, headers: CORS_HEADERS }
    );
  }

  const normalizedRoomNo = roomNo.toLowerCase();
  const isDuplicate = (sentRows ?? []).some((row) => {
    const rowRoom = ((row.room_no as string) ?? "").trim().toLowerCase();
    const rowName = ((row.property_name as string) ?? "").trim();
    // 号室完全一致 → 重複確定
    if (normalizedRoomNo && rowRoom === normalizedRoomNo) return true;
    // 物件名 類似度80%以上 → 重複とみなす
    if (propertyName && stringSimilarity(rowName, propertyName) >= 0.8) return true;
    return false;
  });

  // ── スコアリング ──────────────────────────────────────────────────────────
  const ngFlags: string[] = [];
  const rent = property.rent;

  // budget（0-40点）
  let budgetScore = 0;
  if (customerRentMax == null || customerRentMax <= 0) {
    budgetScore = 40; // 予算未設定はペナルティなし
  } else if (rent <= customerRentMax) {
    budgetScore = 40;
  } else if (rent <= customerRentMax * 1.05) {
    budgetScore = 25;
  } else if (rent <= customerRentMax * 1.1) {
    budgetScore = 10;
  } else {
    budgetScore = 0;
    ngFlags.push("予算超過");
  }

  // floor_plan（0-20点）
  let floorPlanScore = 0;
  if (!customerFloorPlan || !customerFloorPlan.trim()) {
    floorPlanScore = 20; // 希望条件未設定はペナルティなし
  } else if (!property.floor_plan || !property.floor_plan.trim()) {
    floorPlanScore = 10; // 物件側の間取り不明は中間扱い
  } else {
    const wantParsed = parseFloorPlan(customerFloorPlan);
    const propParsed = parseFloorPlan(property.floor_plan);
    const normWant = customerFloorPlan.trim().toUpperCase().replace(/\s/g, "");
    const normProp = property.floor_plan.trim().toUpperCase().replace(/\s/g, "");
    if (normWant === normProp) {
      floorPlanScore = 20; // 完全一致
    } else if (wantParsed && propParsed && wantParsed.rooms === propParsed.rooms) {
      floorPlanScore = 10; // 部屋数が同じ
    } else {
      floorPlanScore = 0;
      ngFlags.push("間取り不一致");
    }
  }

  // walk（0-15点）
  let walkScore = 0;
  if (customerWalk == null || customerWalk <= 0) {
    walkScore = 15; // 希望未設定
  } else if (property.walk_minutes == null) {
    walkScore = 7; // 物件側不明は中間扱い
  } else if (property.walk_minutes <= customerWalk) {
    walkScore = 15;
  } else if (property.walk_minutes <= customerWalk * 1.5) {
    walkScore = 7;
  } else {
    walkScore = 0;
  }

  // ad（0-15点）
  const adMonths = property.ad_months ?? 0;
  let adScore = 0;
  if (adMonths >= 2) {
    adScore = 15;
  } else if (adMonths >= 1) {
    adScore = 8;
  }

  // area_per_rent（0-10点）
  let areaPerRentScore = 0;
  if (property.area_sqm != null && property.area_sqm > 0 && rent > 0) {
    const rentPerSqm = rent / property.area_sqm;
    if (rentPerSqm <= 2000) {
      areaPerRentScore = 10;
    } else if (rentPerSqm <= 2500) {
      areaPerRentScore = 6;
    } else if (rentPerSqm <= 3000) {
      areaPerRentScore = 3;
    } else {
      areaPerRentScore = 0;
    }
  } else {
    areaPerRentScore = 5; // 面積・家賃不明は中間値
  }

  const score =
    budgetScore + floorPlanScore + walkScore + adScore + areaPerRentScore;

  // ── 類似顧客の勝ちパターン参照（物件選定ヒント）──────────────────────────
  // 家賃帯が近い（±15%）かつ同じ間取り希望の顧客で、interested になったオススメポイントを集計。
  // スコアリングには使わず、スタッフへの「選定ヒント」として返す。
  let patternHints: string[] = [];
  try {
    if (customerRentMax && customerRentMax > 0) {
      let q = supabase
        .from("property_selection_patterns")
        .select("selling_points")
        .eq("customer_reaction", "interested")
        .gte("customer_rent_max", Math.round(customerRentMax * 0.85))
        .lte("customer_rent_max", Math.round(customerRentMax * 1.15))
        .limit(40);
      if (customerFloorPlan) q = q.eq("customer_floor_plan", customerFloorPlan);
      const { data: pspRows } = await q;
      if (pspRows && pspRows.length > 0) {
        const counts: Record<string, number> = {};
        for (const row of pspRows) {
          for (const pt of ((row.selling_points as string[]) ?? [])) {
            counts[pt] = (counts[pt] ?? 0) + 1;
          }
        }
        patternHints = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([pt]) => pt);
      }
    }
  } catch { /* ignore — ヒントは補助情報のためエラーでも返す */ }

  return NextResponse.json(
    {
      score,
      is_duplicate: isDuplicate,
      recommended: score >= 70 && !isDuplicate,
      ng_flags: ngFlags,
      score_breakdown: {
        budget: budgetScore,
        floor_plan: floorPlanScore,
        walk: walkScore,
        ad: adScore,
        area_per_rent: areaPerRentScore,
      },
      customer_conditions: {
        rent_max: customerRentMax,
        floor_plan: customerFloorPlan,
        walk_minutes: customerWalk,
        area_min: customerAreaMin,
      },
      // 類似条件のお客さんで反応の良かったセリングポイント（上位5件）
      pattern_hints: patternHints,
    },
    { headers: CORS_HEADERS }
  );
}
