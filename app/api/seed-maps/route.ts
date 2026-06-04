import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

type RegionRow  = { token: string; ward: string; source: string; confidence: number };
type StationRow = { token: string; ward: string | null; realpro_lines: string[]; itandi_lines: string[]; reins_line: string | null; source: string; confidence: number };

export async function POST(req: NextRequest) {
  const { regions, stations } = await req.json() as { regions: RegionRow[]; stations: StationRow[] };
  const db = getDb();

  const errors: string[] = [];

  if (regions?.length > 0) {
    // 100件ずつバッチ処理
    for (let i = 0; i < regions.length; i += 100) {
      const batch = regions.slice(i, i + 100);
      const { error } = await db.from("region_map").upsert(batch, { onConflict: "token" });
      if (error) errors.push(`region[${i}]: ${error.message}`);
    }
  }

  if (stations?.length > 0) {
    for (let i = 0; i < stations.length; i += 100) {
      const batch = stations.slice(i, i + 100);
      const { error } = await db.from("station_map").upsert(batch, { onConflict: "token" });
      if (error) errors.push(`station[${i}]: ${error.message}`);
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    inserted: { regions: regions?.length ?? 0, stations: stations?.length ?? 0 },
    errors,
  });
}
