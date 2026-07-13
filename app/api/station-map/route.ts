import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

export async function GET() {
  const db = getDb();
  const { data, error } = await db
    .from("station_map")
    .select("token, ward, realpro_lines, itandi_lines, reins_line, confidence, source")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ stations: data ?? [] });
}

// DELETE /api/station-map?token=XXX → 間違いエントリを削除し、token_blockで再学習を永久ブロック
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });

  const db = getDb();
  const { error } = await db.from("station_map").delete().eq("token", token);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 誤学習防止: token_block に登録して AI による再解決を永久にブロック
  await db.from("token_block").upsert(
    { token, type: "station", blocked_at: new Date().toISOString() },
    { onConflict: "token" },
  );

  return NextResponse.json({ ok: true, deleted: token });
}
