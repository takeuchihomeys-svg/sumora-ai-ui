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

const SELECT = [
  "created_at", "site", "mode", "ext_version",
  "moves_n", "move_speed_px_s", "move_curve", "move_ms",
  "points_n", "point_x", "point_y", "point_fields",
  "scrolls_n", "scroll_dy", "shot_ops", "shot_learn",
].join(", ");

/**
 * 2026-11-13: 記録から**その場で**学習の束を作る（cron を待たない）。
 *   直近3日・最大3000行（重くしない）。`shot_ops` が無いDBでは外して読み直す。
 *   作った束は DB にも残す（次からは速い・他の PC も読める）。
 */
async function buildNow(scope: string, note?: (why: string) => void) {
  const since = new Date(Date.now() - 3 * 86400_000).toISOString();
  const fetchPage = (cols: string, from: number, to: number) => {
    let q = supabase.from("human_motion_learn").select(cols).gte("created_at", since);
    if (scope && scope !== "all") q = q.eq("site", scope);
    return q.order("created_at", { ascending: false }).range(from, to);
  };
  const rows: unknown[] = [];
  let cols = SELECT;
  for (let i = 0; i < 3000; i += 1000) {
    let r = await fetchPage(cols, i, i + 999);
    if (r.error && /shot_ops|does not exist|schema cache/i.test(r.error.message)) {
      cols = SELECT.replace(", shot_ops", "").replace(", shot_learn", "");
      r = await fetchPage(cols, i, i + 999);
    }
    if (r.error) { try { note?.("select: " + r.error.message); } catch (_) {} return null; }
    rows.push(...((r.data ?? []) as unknown[]));
    if (!r.data || r.data.length < 1000) break;
  }
  if (!rows.length) { try { note?.("no_rows"); } catch (_) {} return null; }
  const { buildHumanLearnBundle, compactBundle } = await import("@/app/lib/human-learn-brain");
  const bundle = compactBundle(buildHumanLearnBundle(rows as never));
  if (!bundle.source.rows) { try { note?.("empty_bundle"); } catch (_) {} return null; }
  // DB にも残す（同じ scope の古い行は消す＝いつも1つだけ）
  try {
    await supabase.from("human_learn_profile").delete().eq("scope", scope);
    await supabase.from("human_learn_profile").insert({
      scope,
      source_rows: bundle.source.rows,
      source_from: bundle.source.from,
      source_to: bundle.source.to,
      ext_version: null,
      bundle,
      lines: bundle.lines,
    });
  } catch { /* 残せなくても返す（今この瞬間に使えればよい） */ }
  return bundle;
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
    /**
     * 2026-11-13: 表がまだ無い時（migrate の前）も **200 で返す**（拡張が止まらないように）。
     *   旧は 42P01 だけを見ていたが、PostgREST は「スキーマキャッシュに無い」という別の文
     *   （`Could not find the table ... in the schema cache`）を返すので 500 になっていた。
     */
    const missing = /does not exist|42P01|Could not find the table|schema cache/i.test(r.error.message);
    return NextResponse.json(
      { ok: false, error: r.error.message, empty: true, bundle: null, lines: [], missing_table: missing },
      { status: missing ? 200 : 500, headers: CORS },
    );
  }
  const row = (r.data ?? [])[0] as Record<string, unknown> | undefined;
  /**
   * 2026-11-13 竹内さん「連携するようにする」（学習が22:20のcron待ちで、すぐ確かめられない）:
   *   束が**無い**時と、**古い**時（前回から30分以上たっている）は、
   *   **その場で記録から作る**（cron を待たない）。作った物は DB に残すので次からは速い。
   *   ⚠ 重くしない: 直近3日・最大3000行まで。作れなければ今まで通り（空を返す）。
   */
  const stale = !row || (Date.now() - Date.parse(String(row.created_at ?? 0)) > 30 * 60 * 1000);
  let why: string | null = null;
  if (stale) {
    try {
      const fresh = await buildNow(scope, (m) => { why = m; });
      if (fresh) {
        return NextResponse.json({
          ok: true, empty: false, scope, generated_now: true,
          generated_at: fresh.generated_at,
          source_rows: fresh.source.rows,
          source_from: fresh.source.from,
          source_to: fresh.source.to,
          ext_version: null,
          lines: fresh.lines,
          bundle: fresh,
        }, { headers: CORS });
      }
    } catch (e) {
      console.warn("[human-learn-profile] その場で作れませんでした:", e instanceof Error ? e.message : String(e));
    }
  }
  if (!row) {
    /**
     * 2026-11-13: **なぜ作れなかったか**を返す（空だけ返すと原因が分からない）。
     *   画面・スクリプトから `why` を見れば、次の手が打てる。
     */
    return NextResponse.json({ ok: true, empty: true, scope, bundle: null, lines: [], why: why || "no_rows_or_build_failed" }, { headers: CORS });
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
