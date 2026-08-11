import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

type StationRow = {
  token: string;
  itandi_lines: string[] | null;
  ward: string | null;
};

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const tokens: unknown = body?.tokens;

  if (!Array.isArray(tokens) || tokens.length === 0) {
    return NextResponse.json({ error: "tokens must be a non-empty array" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("station_map")
    .select("token, itandi_lines, ward")
    .in("token", tokens as string[])
    .neq("source", "unknown");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows: StationRow[] = (data ?? []) as StationRow[];

  // itandi_linesが空のエントリは解決済みとして扱わない（unknown扱い）
  const resolvedMap = new Map(
    rows
      .filter((r) => r.itandi_lines && r.itandi_lines.length > 0)
      .map((r) => [r.token, { itandi_lines: r.itandi_lines as string[], ward: r.ward }]),
  );

  const resolved: Record<string, { itandi_lines: string[]; ward: string | null }> = {};
  for (const [k, v] of resolvedMap) resolved[k] = v;

  const unknown_tokens = (tokens as string[]).filter((t) => !resolvedMap.has(t));

  return NextResponse.json({ resolved, unknown_tokens });
}
