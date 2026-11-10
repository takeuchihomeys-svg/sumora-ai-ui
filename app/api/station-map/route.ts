import { serverSupabaseKey } from "@/app/lib/supabase-server-key";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { deriveSiteLines } from "@/app/lib/station-line-maps";

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serverSupabaseKey()!,
  );
}

export async function GET() {
  const db = getDb();
  const { data, error } = await db
    .from("station_map")
    .select("token, ward, realpro_lines, itandi_lines, reins_line, confidence, source, priority")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ stations: data ?? [] });
}

// POST /api/station-map {token, ward?, realpro_lines?} → 「駅として登録」（従業員の手直し）
// 2026-09-24 竹内「従業員が手直ししたところは学習されているのか」: 今まで駅の手動正解 API が無く、
//   「✗ 間違い」は市区名（地名）しか受け付けなかった。手直しは priority 100 で、拡張の仕分けはハードコードより先にこれを見る。
export async function POST(req: Request) {
  let token = "";
  let ward: string | null = null;
  let realproLines: string[] = [];
  try {
    const body = await req.json() as { token?: string; ward?: string | null; realpro_lines?: string[] };
    token = String(body.token ?? "").trim();
    ward = body.ward ? String(body.ward).trim() : null;
    realproLines = Array.isArray(body.realpro_lines) ? body.realpro_lines.map((s) => String(s).trim()).filter(Boolean) : [];
    if (!token || token.length > 40) throw new Error("bad");
  } catch {
    return NextResponse.json({ error: "token required" }, { status: 400 });
  }
  const db = getDb();
  const { data: prev } = await db.from("station_map").select("realpro_lines, itandi_lines, reins_line, ward").eq("token", token).maybeSingle();
  const p = prev as { realpro_lines?: string[] | null; itandi_lines?: string[] | null; reins_line?: string | null; ward?: string | null } | null;
  const finalRealpro = realproLines.length ? realproLines : (Array.isArray(p?.realpro_lines) ? p!.realpro_lines! : []);
  // 2026-11-10: 今まではリアプロの列だけ直し、ITANDI・REINS は古いまま残っていた。
  //   同じ対応表（popup-maps.js の写し app/lib/station-line-maps.ts）で作り直す。変換できない路線がある列は前の値を残して返す
  const site = deriveSiteLines(finalRealpro, p, realproLines.length > 0);
  const { error } = await db.from("station_map").upsert(
    {
      token,
      ward: ward ?? p?.ward ?? null,
      realpro_lines: finalRealpro,
      itandi_lines: site.itandi_lines,
      reins_line: site.reins_line,
      confidence: 100, source: "manual", priority: 100,
    },
    { onConflict: "token" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // 駅として正解が入ったので、地名側の学習とブロックは外す
  await Promise.all([
    db.from("region_map").delete().eq("token", token),
    db.from("token_block").delete().eq("token", token),
  ]);
  const unmapped = Array.from(new Set([...site.unmapped_itandi, ...site.unmapped_reins]));
  return NextResponse.json({
    ok: true, token,
    site_lines: { itandi: site.itandi, reins: site.reins, unmapped_itandi: site.unmapped_itandi, unmapped_reins: site.unmapped_reins },
    ...(unmapped.length ? { warning: `対応表に無い路線のため前の値を残しました: ${unmapped.join("・")}` } : {}),
  });
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
