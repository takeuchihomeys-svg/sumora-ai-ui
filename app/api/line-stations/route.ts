import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

// GET /api/line-stations
// 全路線の駅順序を返す: { lines: { [line_name]: string[] } }
// popup.js の LEARNED_LINE_ORDER に格納してgetAdjacentStations/expandStationRangeで使用
export async function GET() {
  const db = getDb();
  const { data, error } = await db
    .from("line_stations")
    .select("line_name, station_name, order_idx")
    .order("line_name")
    .order("order_idx");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // { [line_name]: string[] } 形式に変換
  const lines: Record<string, string[]> = {};
  for (const row of data ?? []) {
    if (!lines[row.line_name]) lines[row.line_name] = [];
    lines[row.line_name][row.order_idx] = row.station_name;
  }

  return NextResponse.json({ lines });
}
