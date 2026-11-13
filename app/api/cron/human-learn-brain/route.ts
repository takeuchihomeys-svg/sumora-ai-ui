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
import { selectDroppingMissing } from "@/app/lib/supabase-safe-select";

const SELECT = [
  "created_at", "site", "mode", "ext_version", "ops",
  "moves_n", "move_speed_px_s", "move_curve", "move_ms", "move_dist", "gap_ms",
  "points_n", "point_x", "point_y", "point_fields",
  "scrolls_n", "scroll_dy", "kinds", "fields", "field_order", "shot_ops", "shot_learn", "shot_key",
].join(", ");
/**
 * 2026-11-13 竹内さん「ほかにちゃんと学習の面とかで連携できていない部分などあるか」:
 *   ⚠ 旧は `shot_ops` が無い時だけ外す**決め打ち**だった（学習の入口と写真の一覧で起きたのと同じ型）。
 *     実際に無いのは `shot_learn` の事もあり、その時は**丸ごと読めなくなっていた**。
 *   → 共通の `selectDroppingMissing` で**無い列だけ**外す。
 */
async function selectRows(build: (cols: string) => PromiseLike<{ data: unknown[] | null; error: { message: string; code?: string | null } | null }>): Promise<{ rows: MotionRow[]; error: string | null; hasShotOps: boolean }> {
  const sel = await selectDroppingMissing(SELECT.split(", "), build, {
    onDrop: (c) => console.warn("[human-learn-brain] 列が無いので外します:", c),
  });
  if (sel.error) return { rows: [], error: String(sel.error.message ?? "select_failed"), hasShotOps: false };
  return { rows: (sel.data ?? []) as MotionRow[], error: null, hasShotOps: sel.cols.includes("shot_ops") };
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

  /**
   * ①-2 写真から欄の種類を読む（2026-11-13 竹内さん「ほかに連携できていない部分などあるか」）。
   *   ⚠ `/api/shot-learn` は作ってあったが、**誰も呼んでいなかった**
   *     ＝「種類が分からない: 40件」が永久に埋まらない状態だった。
   *   → 毎晩、`shot_learn` が空で `shot_ops` に種類がある行を拾って、
   *     `shot_ops` から決定論で読む（写真を見ない・LLM を使わない＝費用0）。
   *     ⚠ LLM は使わない（`SHOT_LEARN_LLM=on` でも cron からは呼ばない＝費用を勝手にかけない）。
   *     ⚠ 列が無い DB（`shot_learn` 未作成）では何もしないで次へ。
   */
  let shotLearned = 0;
  if (!dry && hasShotOps) {
    try {
      const targets = rows
        .filter((r) => {
          const x = r as unknown as Record<string, unknown>;
          return Array.isArray(x.shot_ops) && !(x.shot_learn && typeof x.shot_learn === "object");
        })
        .slice(0, 50);
      const { cleanFields, cleanScreen } = await import("@/app/lib/shot-learn");
      for (const r of targets) {
        const x = r as unknown as Record<string, unknown>;
        const ops = Array.isArray(x.shot_ops) ? x.shot_ops : [];
        const fields = cleanFields(ops.map((o) => {
          const y = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
          return { name: y.f, kind: y.w, x: null, y: null };
        }));
        if (!fields.length) continue;
        const out = { screen: cleanScreen("other"), fields, by: "deterministic" as const, confidence: 0.9 };
        // どの行かは id で指定できない（読む時に id を取っていない）→ shot_key で当てる
        const key = typeof x.shot_key === "string" ? x.shot_key : "";
        if (!key) continue;
        const up = await supabase.from("human_motion_learn").update({ shot_learn: out }).eq("shot_key", key);
        if (!up.error) shotLearned++;
        else if (/shot_learn|does not exist|schema cache/i.test(up.error.message)) break;
      }
    } catch (e) {
      console.warn("[human-learn-brain] 写真からの読み取りを飛ばしました:", e instanceof Error ? e.message : String(e));
    }
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

  /**
   * ③ 書く。
   *   2026-11-13 竹内さん「データベースを学習面でも強化していくようにする形とする」:
   *     ⚠ 旧は「消してから入れる」だったので、**入れるのに失敗すると前の束も消えた**。
   *     → **先に入れてから**、古い物を消す（消す順を逆にした）。失敗しても前の束が残る。
   *     ⚠ 消すのは**同じ scope の古い物**だけ（履歴は残す＝推移を見られる）。
   */
  let written = 0;
  let tableMissing = false;
  if (!dry) {
    for (const p of payloads) {
      try {
        const { error: insErr } = await supabase.from("human_learn_profile").insert({
          scope: p.scope,
          source_rows: p.bundle.source.rows,
          source_from: p.bundle.source.from,
          source_to: p.bundle.source.to,
          ext_version: extVersion,
          bundle: p.bundle,
          lines: p.bundle.lines,
        });
        if (insErr) {
          // 2026-11-13: 表がまだ無い（migrate の前）は「失敗」ではなく「まだ作っていない」として返す
          if (/does not exist|42P01|Could not find the table|schema cache/i.test(insErr.message)) { tableMissing = true; break; }
          error = insErr.message; break;
        }
        written++;
        // 入れた後で、古い物を消す（直近100件だけ残す＝履歴は残す）
        try {
          const old = await supabase.from("human_learn_profile")
            .select("id").eq("scope", p.scope)
            .order("created_at", { ascending: false }).range(100, 200);
          const ids = ((old.data ?? []) as Array<{ id: number }>).map((x) => x.id);
          if (ids.length) await supabase.from("human_learn_profile").delete().in("id", ids);
        } catch { /* 消せなくても害はない */ }
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
    shot_learned: shotLearned,
    table_missing: tableMissing,
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
