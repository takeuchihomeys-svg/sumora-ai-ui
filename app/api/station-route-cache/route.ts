import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 15;

type StationRow = {
  token: string;
  realpro_lines: string[] | null;
};

export async function GET() {
  try {
    const PAGE_SIZE = 1000;
    const map: Record<string, string[]> = {};
    let offset = 0;

    // supabase-js は1回のSELECTで最大1000行のため range でページング全件取得
    while (true) {
      const { data, error } = await supabase
        .from("station_map")
        .select("token, realpro_lines")
        .neq("source", "unknown") // ネガティブキャッシュ行を除外
        .order("token")
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        return NextResponse.json(
          { error: error.message },
          { status: 500 }
        );
      }

      const rows = (data ?? []) as StationRow[];
      for (const row of rows) {
        const lines = Array.isArray(row.realpro_lines)
          ? row.realpro_lines.filter((l): l is string => typeof l === "string" && l.length > 0)
          : [];
        if (lines.length === 0) continue; // realpro_lines が空の行は未解決扱いのため除外
        map[row.token] = lines;
      }

      if (rows.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    return NextResponse.json(
      { data: map },
      {
        headers: {
          "Cache-Control": "public, max-age=86400",
        },
      }
    );
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
