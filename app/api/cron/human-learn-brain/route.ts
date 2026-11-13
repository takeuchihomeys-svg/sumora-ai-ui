// GET /api/cron/human-learn-brain
// 「学習担当のブレイン」の毎晩のまとめ（2026-11-13 竹内さん
//   「ちゃんと学習担当のブレインをつくってより効率的に学習できるようにする。データベースを有効活用する」）
//
// 何をするか:
//   ① 溜まった `human_motion_learn` を読む（直近 N 日・サイトごと）
//   ② `buildHumanLearnBundle` で**1つの束にまとめる**（押す順番・押す場所・動きの速さ・サイトごとの手順）
//   ③ `human_learn_profile` に書く（scope='all' と、サイトごとの行）
//
// なぜ効率的か:
//   拡張は毎回バラバラの記録（数百行）を読んでいた。束にすると**1行（数十KB）**を読むだけでよく、
//   記録が増えても拡張の負担が増えない。学習を足す時もここ1か所を直せばよい。
//
// ⚠ 入れるのは欄の名前・操作の種類・時刻・位置の割合だけ。入力した中身は入れない。
//
// 実行: ?dry=1 で記録しない／?days=30 で期間を変える
export const maxDuration = 60;
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { buildHumanLearnBundle, compactBundle, type MotionRow } from "@/app/lib/human-learn-brain";

const SELECT = [
  "created_at", "site", "mode", "ext_version", "ops",
  "moves_n", "move_speed_px_s", "move_curve", "move_ms", "move_dist",
  "points_n", "point_x", "point_y", "point_fields",
  "scrolls_n", "scroll_dy", "kinds", "fields", "field_order", "shot_ops",
].join(", ");
/**
 * 2026-11-13: `shot_ops` の列がまだ無い DB でも動くようにする。
 *   旧は列を要求していたので、**列を足す前は丸ごと読めなかった**（＝学習が動かない）。
 *   → 列が無いと言われたら、`shot_ops` を外して読み直す。
 *     （押す順番は写真の並びから学ぶので、列が無い間は「押す場所・動き」だけ学ぶ）
 */
async function selectRows(build: (cols: string) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<{ rows: MotionRow[]; error: string | null; hasShotOps: boolean }> {
  const first = await build(SELECT);
  if (!first.error) return { rows: (first.data ?? []) as MotionRow[], error: null, hasShotOps: true };
  if (/shot_ops/i.test(first.error.message)) {
    const fallback = SELECT.replace(", shot_ops", "");
    const second = await build(fallback);
    if (second.error) return { rows: [], error: second.error.message, hasShotOps: false };
    return { rows: (second.data ?? []) as MotionRow[], error: null, hasShotOps: false };
  }
  return { rows: [], error: first.error.message, hasShotOps: false };
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const days = Math.min(Math.max(Number(req.nextUrl.searchParams.get("days") ?? 30) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const logId = dry ? null : await startCronLog("human-learn-brain");

  // ① 読む（PostgREST は1回1000行までなので頁で読む）
  const rows: MotionRow[] = [];
  let error: string | null = null;
  let hasShotOps = true;
  for (let i = 0; i < 20_000; i += 1000) {
    const r = await selectRows((cols) => supabase
      .from("human_motion_learn")
      .select(cols)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(i, i + 999));
    if (r.error) { error = r.error; break; }
    hasShotOps = r.hasShotOps;
    rows.push(...r.rows);
    if (r.rows.length < 1000) break;
  }

  if (error) {
    await finishCronLog(logId, false, { ok: false, error }, error);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }

  // ② まとめる（全サイト＋サイトごと）
  const now = Date.now();
  const all = compactBundle(buildHumanLearnBundle(rows, now));
  const sites = Array.from(new Set(rows.map((r) => String(r.site || "")).filter(Boolean)));
  const perSite: Array<{ scope: string; bundle: ReturnType<typeof compactBundle> }> = [];
  for (const s of sites) {
    const sub = rows.filter((r) => String(r.site || "") === s);
    if (sub.length < 5) continue; // 少なすぎる物は束にしない（偶然を学ばない）
    perSite.push({ scope: s, bundle: compactBundle(buildHumanLearnBundle(sub, now)) });
  }

  const extVersion = rows.length ? String(rows[0]?.ext_version ?? "") || null : null;
  const payloads = [
    { scope: "all", bundle: all },
    ...perSite,
  ];

  // ③ 書く（同じ scope の古い行は消してから入れる＝いつも1つだけ）
  let written = 0;
  if (!dry) {
    for (const p of payloads) {
      try {
        await supabase.from("human_learn_profile").delete().eq("scope", p.scope);
        const { error: insErr } = await supabase.from("human_learn_profile").insert({
          scope: p.scope,
          source_rows: p.bundle.source.rows,
          source_from: p.bundle.source.from,
          source_to: p.bundle.source.to,
          ext_version: extVersion,
          bundle: p.bundle,
          lines: p.bundle.lines,
        });
        if (insErr) { error = insErr.message; break; }
        written++;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        break;
      }
    }
  }

  const report = {
    ok: !error,
    dry,
    days,
    rows: rows.length,
    has_shot_ops: hasShotOps,
    scopes: payloads.map((p) => p.scope),
    written,
    learned: {
      next: Object.keys(all.next).length,
      points: Object.keys(all.points).length,
      buttons: all.buttons.length,
      sites: Object.keys(all.site_flow).length,
    },
    lines: all.lines,
    ...(error ? { error } : {}),
  };
  await finishCronLog(logId, !error, report as unknown as Record<string, unknown>, error ?? undefined);
  return NextResponse.json(report, { status: error ? 500 : 200 });
}
