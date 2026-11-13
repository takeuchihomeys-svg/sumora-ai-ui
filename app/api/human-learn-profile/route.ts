// GET /api/human-learn-profile
// 拡張（自動モード）が読む「学習の束」（2026-11-13 竹内さん
//   「ちゃんと学習担当のブレインをつくってより効率的に学習できるようにする。データベースを有効活用する」)
//
// なぜ要るか:
//   これまで拡張は毎回 `human_motion_learn` の**生の記録**（数百行）を読んでいた。
//   → 記録が増えるほど重くなり、押す順番のような「まとめた知識」は読めなかった。
//   ここは `/api/cron/human-learn-brain` が毎晩作った**束（1行）**を返すだけ。軽い・速い・増えても変わらない。
//
// ?scope=all（既定）／?scope=realpro のようにサイトごとも取れる
// 読んだ印（read_at・read_count）を残す（どの PC が読んでいるか分かる）
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";

export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-automation-key",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(req: NextRequest) {
  const scope = (req.nextUrl.searchParams.get("scope") || "all").slice(0, 20);
  const touch = req.nextUrl.searchParams.get("touch") !== "0";

  const r = await supabase
    .from("human_learn_profile")
    .select("id, created_at, scope, source_rows, source_from, source_to, ext_version, bundle, lines, read_count")
    .eq("scope", scope)
    .order("created_at", { ascending: false })
    .limit(1);

  if (r.error) {
    // 表がまだ無い時（列を足す前）も 200 で返す（拡張が止まらないように）
    const missing = /does not exist|42P01/.test(r.error.message);
    return NextResponse.json(
      { ok: false, error: r.error.message, empty: true, bundle: null, lines: [] },
      { status: missing ? 200 : 500, headers: CORS },
    );
  }
  const row = (r.data ?? [])[0] as Record<string, unknown> | undefined;
  if (!row) {
    return NextResponse.json({ ok: true, empty: true, scope, bundle: null, lines: [] }, { headers: CORS });
  }

  if (touch) {
    try {
      await supabase
        .from("human_learn_profile")
        .update({ read_at: new Date().toISOString(), read_count: (Number(row.read_count) || 0) + 1 })
        .eq("id", row.id as number);
    } catch { /* 印は残らなくてもよい */ }
  }

  return NextResponse.json(
    {
      ok: true,
      empty: false,
      scope: row.scope,
      generated_at: (row.bundle as Record<string, unknown> | null)?.generated_at ?? row.created_at,
      source_rows: row.source_rows,
      source_from: row.source_from,
      source_to: row.source_to,
      ext_version: row.ext_version,
      lines: row.lines ?? [],
      bundle: row.bundle,
    },
    { headers: CORS },
  );
}
