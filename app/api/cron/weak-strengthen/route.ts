/**
 * GET /api/cron/weak-strengthen
 *
 * 弱い部分の強化計画を立て、無料の反映（束の作り直し）まで進める。
 * Vision（photo_learn）は ?yes_cost=1 または WEAK_STRENGTHEN_YES_COST=1 の時だけ。
 *
 * 竹内さん「弱い部分を強化していく仕組みもあわせてつくる」
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { fetchBundleReflectHint } from "@/app/lib/bundle-reflect";
import { buildImproveLoop } from "@/app/lib/improve-loop";
import { summarizeLatestAutoChallenges } from "@/app/lib/latest-learn-loop";
import { buildWeakStrengthenPlan } from "@/app/lib/weak-strengthen-loop";
import { buildRecChallengeReinforce } from "@/app/lib/rec-challenge-reinforce";
import { findShotsToLearn, learnFromWeakShots } from "@/app/lib/shot-learn-server";
import { LEARN_PERIODS, materialsDays, sinceIso } from "@/app/lib/learn-periods";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const yesCost =
    req.nextUrl.searchParams.get("yes_cost") === "1" ||
    process.env.WEAK_STRENGTHEN_YES_COST === "1";
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const logId = dry ? null : await startCronLog("weak-strengthen");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  const sb = createClient(url, key);
  const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://sumora-ai-ui.vercel.app";

  try {
    const since = sinceIso(LEARN_PERIODS.materialsMs);
    const matDays = materialsDays();
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 2000; i += 1000) {
      const { data } = await sb
        .from("human_motion_learn")
        .select("created_at,mode,shot_key,shot_w,shot_learn,ext_version,shot_ops")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .range(i, i + 999);
      rows.push(...((data || []) as Array<Record<string, unknown>>));
      if ((data || []).length < 1000) break;
    }

    const hint = await fetchBundleReflectHint(sb, { scope: "all" });
    const { data: prof } = await sb
      .from("human_learn_profile")
      .select("bundle")
      .eq("scope", "all")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const bundle = (prof?.bundle || {}) as {
      shots?: { learned?: Record<string, Array<{ x?: number; y?: number; n?: number }>> };
    };
    let screen_all = 0, screen_solid = 0;
    const learned = bundle.shots?.learned;
    if (learned) {
      for (const list of Object.values(learned)) {
        for (const f of Array.isArray(list) ? list : []) {
          if (typeof f?.x !== "number") continue;
          screen_all++;
          if ((Number(f.n) || 0) >= 3) screen_solid++;
        }
      }
    }

    const ch = summarizeLatestAutoChallenges(rows as never, { hours: 48 });
    const loop = buildImproveLoop({
      photoInStorage: rows.length,
      withOps: rows.length,
      screenSolid: screen_solid,
      screenAll: screen_all,
      hint,
      challengeFields: ch.fields,
      canMeasure: hint.read_count > 0 && hint.auto_after,
    });
    const unread = (await findShotsToLearn({
      site: "all", mode: "normal", days: matDays, limit: 40, order: "newest", perSig: 8, strideMs: 1500,
    })).length;

    const plan = buildWeakStrengthenPlan({
      weakFields: ch.fields || [],
      challengeFields: ch.fields || [],
      unreadNormal: unread,
      bottleneck_n: loop.bottleneck_n,
      round: 1,
    });

    /**
     * ★ 2026-11-18: 録画→課題→学習→仕組み補強→学び方強化を cron でも見る。
     *   read_count=0 のとき flash 偏重を止め、人の再読込を next_human に出す。
     */
    const hl = (bundle as { human_like?: {
      withPoint?: number; withCursor?: number; rows?: number; point_pct?: number; cursor_pct?: number;
      changedWithoutClick?: number;
    } }).human_like;
    const rowsN = Number(hl?.rows) || 0;
    const pointPct = rowsN > 0
      ? Math.round((Number(hl?.withPoint || 0) / rowsN) * 100)
      : (hl?.point_pct ?? null);
    const cursorPct = rowsN > 0
      ? Math.round((Number(hl?.withCursor || 0) / rowsN) * 100)
      : (hl?.cursor_pct ?? null);
    const rcr = buildRecChallengeReinforce({
      pointPct,
      cursorPct,
      readCount: hint.read_count,
      screenSolid: screen_solid,
      screenAll: screen_all,
      unreadNormal: unread,
      autoAfterBundle: hint.auto_after === true,
      fireAtPointWired: true,
      extVersion: "2.8.90",
      didFlash: unread === 0,
      usedKinds: unread === 0 ? ["photo_learn"] : [],
      humanLike: hl
        ? {
            withPoint: Number(hl.withPoint) || 0,
            withCursor: Number(hl.withCursor) || 0,
            rows: rowsN,
            changedWithoutClick: Number(hl.changedWithoutClick) || 0,
          }
        : null,
    });
    const gateReloadFirst = rcr.method.upgrades.some((u) => u.id === "order_reload_before_flash")
      || hint.read_count < 1;

    let photo: { tried: number; learned: number; saved: number } | null = null;
    let reflect = "";
    let photo_skipped: string | null = null;
    if (!dry) {
      /**
       * ★ 2026-11-17: fresh=1 直呼びは学習消失の抜け穴（実測 solid 96→0）。
       *   → 束の作り直しは human-learn-profile の wipe 拒否付き経路に任せるが、
       *     cron からは **touch=0 の読み**だけにし、強制 fresh はしない。
       *     学習後の反映は shot-learn-server 側の inherit 付き書き込みに任せる。
       */
      const r = await fetch(`${BASE}/api/human-learn-profile?touch=0&scope=all`, { cache: "no-store" });
      reflect = r.ok ? "束確認ok（fresh禁止）" : `束確認失敗 http_${r.status}`;

      if (yesCost) {
        const photoTask = plan.cycle.find((t) => t.kind === "photo_learn")
          || rcr.tasks.find((t) => t.kind === "photo_learn");
        /**
         * ★ 統括Pro: 関所（再読込）と flash は同時可。
         *   read=0でも束への thin 載せは進めてよい。ただし next_human は再読込を先頭に残す。
         *   「flashだけで完了」と誤認しないよう gate_reload_first 印は残す。
         */
        if (photoTask) {
          const limit = Math.min(40, Number(photoTask.limit) || 20);
          const lr = await learnFromWeakShots({
            site: null, mode: "normal", days: matDays, limit,
            order: "newest", perSig: 12, strideMs: 800, dryRun: false,
          });
          photo = { tried: lr.tried, learned: lr.learned, saved: lr.saved };
          // 学習後も fresh=1 しない（shot-learn-server が inherit 付きで書く）
          reflect = gateReloadFirst
            ? "学習後・fresh禁止（thin載せ可・効果は再読込後）"
            : "学習後・fresh禁止（shot側反映）";
          if (gateReloadFirst) {
            photo_skipped = null;
          }
        } else if (gateReloadFirst) {
          photo_skipped = "photo課題なし。拡張再読込→自動1回が先（関所優先）";
        }
      }
    }

    const nextHuman = [
      ...rcr.tasks.filter((t) => t.kind === "need_ext_reload" || t.kind === "need_auto_run").map((t) => t.what),
      ...plan.cycle.filter((t) => t.kind === "need_ext_reload" || t.kind === "need_auto_run").map((t) => t.what),
    ].filter((v, i, a) => a.indexOf(v) === i);

    const body = {
      ok: true,
      dry,
      yes_cost: yesCost,
      line: plan.line,
      targets: plan.targets,
      cycle: plan.cycle.map((t) => t.kind),
      continue_loop: plan.continue_loop || rcr.continue_loop,
      bottleneck: loop.bottleneck,
      unread,
      reflect,
      photo,
      photo_skipped,
      rec_loop: rcr.line,
      method_line: rcr.method.line,
      next_method: rcr.method.next_method_line,
      gate_reload_first: gateReloadFirst,
      next_human: nextHuman,
    };
    await finishCronLog(logId, true, body);
    return NextResponse.json(body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, { ok: false, error: msg }, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
