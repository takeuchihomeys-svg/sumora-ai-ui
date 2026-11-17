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
import { findShotsToLearn, learnFromWeakShots } from "@/app/lib/shot-learn-server";

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
    const since = new Date(Date.now() - 2 * 86400_000).toISOString();
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
      site: "all", mode: "normal", days: 7, limit: 40, order: "newest", perSig: 8, strideMs: 1500,
    })).length;

    const plan = buildWeakStrengthenPlan({
      weakFields: ch.fields || [],
      challengeFields: ch.fields || [],
      unreadNormal: unread,
      bottleneck_n: loop.bottleneck_n,
      round: 1,
    });

    let photo: { tried: number; learned: number; saved: number } | null = null;
    let reflect = "";
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
        const photoTask = plan.cycle.find((t) => t.kind === "photo_learn");
        if (photoTask) {
          const limit = Math.min(40, Number(photoTask.limit) || 20);
          const lr = await learnFromWeakShots({
            site: null, mode: "normal", days: 7, limit,
            order: "newest", perSig: 12, strideMs: 800, dryRun: false,
          });
          photo = { tried: lr.tried, learned: lr.learned, saved: lr.saved };
          // 学習後も fresh=1 しない（shot-learn-server が inherit 付きで書く）
          reflect = "学習後・fresh禁止（shot側反映）";
        }
      }
    }

    const body = {
      ok: true,
      dry,
      yes_cost: yesCost,
      line: plan.line,
      targets: plan.targets,
      cycle: plan.cycle.map((t) => t.kind),
      continue_loop: plan.continue_loop,
      bottleneck: loop.bottleneck,
      unread,
      reflect,
      photo,
      next_human: plan.cycle
        .filter((t) => t.kind === "need_ext_reload" || t.kind === "need_auto_run")
        .map((t) => t.what),
    };
    await finishCronLog(logId, true, body);
    return NextResponse.json(body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, { ok: false, error: msg }, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
