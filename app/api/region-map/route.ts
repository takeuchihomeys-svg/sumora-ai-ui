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
    .from("region_map")
    .select("token, ward, confidence, source")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ regions: data ?? [] });
}

// POST /api/region-map {token, ward} → 「✗ 間違い」の正解学習
// ユーザーが入力した正しい市区名を最高信頼度でupsertし、誤learned駅エントリ・ブロックを解除する
export async function POST(req: Request) {
  let token = "";
  let ward = "";
  try {
    const body = await req.json() as { token?: string; ward?: string };
    token = String(body.token ?? "").trim();
    ward = String(body.ward ?? "").trim();
    if (!token || !ward || !/[市区郡]/.test(ward)) throw new Error("bad");
  } catch {
    return NextResponse.json({ error: "token and ward (市区郡を含む) required" }, { status: 400 });
  }

  const db = getDb();
  // 手動修正は confidence 100（AI学習の80より優先される正解データ）
  const { error } = await db.from("region_map").upsert(
    { token, ward, confidence: 100, source: "manual" },
    { onConflict: "token" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 正解が入ったので、誤学習された駅エントリと再解決ブロックは解除する
  await Promise.all([
    db.from("station_map").delete().eq("token", token),
    db.from("token_block").delete().eq("token", token),
  ]);

  return NextResponse.json({ ok: true, token, ward });
}

// DELETE /api/region-map?token=XXX → 間違いエントリを削除し、token_blockで再学習を永久ブロック
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });

  const db = getDb();
  const { error } = await db.from("region_map").delete().eq("token", token);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 誤学習防止: token_block に登録して AI による再解決を永久にブロック
  await db.from("token_block").upsert(
    { token, type: "region", blocked_at: new Date().toISOString() },
    { onConflict: "token" },
  );

  return NextResponse.json({ ok: true, deleted: token });
}
