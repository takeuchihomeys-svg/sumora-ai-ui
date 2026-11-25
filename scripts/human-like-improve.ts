/**
 * 人間らしさ未達の改善周回
 *
 *   npx tsx --env-file=.env.local scripts/human-like-improve.ts
 *   npx tsx --env-file=.env.local scripts/human-like-improve.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/human-like-improve.ts --yes-cost
 *
 * ①正本で測る → ②計画（間隔寄せは人の再読込／位置は photo_learn）→ ③--yes-cost で Vision
 * ④束反映 → ⑤拡張再読込・自動1回は人 → ⑥再測
 *
 * 竹内さん「費用かかっても大丈夫／画像学習から改善しても大丈夫」・統括Proが枚数を決める
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  computeHumanNearness,
  gapsFromOps,
  pressGapsFromRows,
  NEARNESS_ALLOW,
} from "../app/lib/human-nearness";
import { isAutoMode } from "../app/lib/press-by";
import {
  buildHumanLikeImprovePlan,
  learnGapPaceFromNormalGaps,
  evaluateHumanLikeImproveStamp,
  pickNearnessForImprove,
  pickPointPctForImprove,
} from "../app/lib/human-like-improve-loop";
import { auditHumanLike, judgeHumanLikePass } from "../app/lib/human-like-audit";
import { findShotsToLearn, learnFromWeakShots } from "../app/lib/shot-learn-server";
import { prepareBundleForWrite } from "../app/lib/bundle-write-prepare";

const args = process.argv.slice(2);
const yesCost = args.includes("--yes-cost");
const dryRun = args.includes("--dry-run") || (!yesCost && !args.includes("--plan-only"));
const planOnly = args.includes("--plan-only");
const hours = Math.max(1, Number((args.find((a) => a.startsWith("--hours=")) || "").replace("--hours=", "")) || 48);

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

function hr() {
  console.log("─".repeat(66));
}

async function measureNearness() {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const rows: Array<{ mode?: unknown; shot_ops?: unknown; install_id?: unknown }> = [];
  for (let i = 0; i < 3000; i += 1000) {
    const { data, error } = await sb
      .from("human_motion_learn")
      .select("mode,shot_ops,install_id")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(i, i + 999);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...(data as never[]));
    if (data.length < 1000) break;
  }

  const normalGaps: number[] = [];
  const autoGaps: number[] = [];
  for (const r of rows) {
    const m = String(r.mode || "").toLowerCase();
    const ops = Array.isArray(r.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [];
    const gs = gapsFromOps(ops);
    if (isAutoMode(m)) autoGaps.push(...gs);
    else if (m === "normal") normalGaps.push(...gs);
  }
  const nRaw = computeHumanNearness({ normalGaps, autoGaps });

  const folded = pressGapsFromRows(rows, (row) => {
    const m = String(row.mode || "").toLowerCase();
    if (isAutoMode(m)) return "auto";
    if (m === "normal") return "normal";
    return null;
  });
  const nFold = computeHumanNearness({
    normalGaps: folded.normal?.gaps || [],
    autoGaps: folded.auto?.gaps || [],
  });

  return { fetched: rows.length, nRaw, nFold, folded, normalGaps, autoGaps };
}

async function loadBundlePointPct(): Promise<{
  pointPct: number | null;
  cursorPct: number | null;
  thinFields: string[];
  bundleId: number | null;
  bundle: Record<string, unknown> | null;
}> {
  const { data } = await sb
    .from("human_learn_profile")
    .select("id,bundle")
    .eq("scope", "realpro")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const b = (data?.bundle || null) as Record<string, unknown> | null;
  const hl = (b?.human_like || {}) as Record<string, unknown>;
  const pointPct = typeof hl.point_pct === "number" ? hl.point_pct : null;
  const cursorPct = typeof hl.cursor_pct === "number" ? hl.cursor_pct : null;
  const points = (b?.points || {}) as Record<string, { n?: number; x?: number; y?: number }>;
  const thinFields: string[] = [];
  for (const [k, v] of Object.entries(points)) {
    if (typeof v?.x !== "number") continue;
    if ((Number(v.n) || 0) < 3) thinFields.push(k);
  }
  return { pointPct, cursorPct, thinFields: thinFields.slice(0, 12), bundleId: data?.id ?? null, bundle: b };
}

/** 直近自動の point_fields（pressBy=auto）で位置%を測る — 束 human_like は photo 後も動かない */
async function measureAutoPointPct(hoursBack: number): Promise<{
  pointPct: number | null;
  cursorPct: number | null;
  rows: number;
  line: string;
}> {
  const since = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
  const rows: Array<{ mode?: unknown; shot_ops?: unknown; point_fields?: unknown; moves_n?: unknown }> = [];
  for (let i = 0; i < 2000; i += 1000) {
    const { data, error } = await sb
      .from("human_motion_learn")
      .select("mode,shot_ops,point_fields,moves_n")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(i, i + 999);
    if (error) throw error;
    if (!data?.length) break;
    for (const r of data as never[]) {
      const m = String((r as { mode?: unknown }).mode || "").toLowerCase();
      if (isAutoMode(m)) rows.push(r as never);
    }
    if (data.length < 1000) break;
  }
  if (rows.length < 3) {
    return { pointPct: null, cursorPct: null, rows: rows.length, line: `自動行不足 n=${rows.length}` };
  }
  const audit = auditHumanLike(rows as never, { pressBy: "auto" });
  const pass = judgeHumanLikePass(audit);
  return {
    pointPct: pass.pointPct,
    cursorPct: pass.cursorPct,
    rows: audit.rows,
    line: `自動監査 rows=${audit.rows} 位置${pass.pointPct}% カーソル${pass.cursorPct}%`,
  };
}

async function patchRealproBundle(
  mutator: (bundle: Record<string, unknown>) => void,
): Promise<string> {
  const { data } = await sb
    .from("human_learn_profile")
    .select("id,bundle")
    .eq("scope", "realpro")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.bundle) return "束なし";
  const clone = JSON.parse(JSON.stringify(data.bundle)) as Record<string, unknown>;
  mutator(clone);
  try {
    prepareBundleForWrite(clone);
  } catch {
    /* playbook が作れなくても gaps / nearness は書く */
  }
  const r = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/human_learn_profile?id=eq.${data.id}`,
    {
      method: "PATCH",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ bundle: clone }),
    },
  );
  return r.ok ? `反映 ok id=${data.id}` : `反映失敗 ${r.status}`;
}

async function main() {
  hr();
  console.log(`【人間らしさ改善】hours=${hours} dryRun=${dryRun} yesCost=${yesCost} planOnly=${planOnly}`);
  hr();

  const { fetched, nRaw, nFold, folded } = await measureNearness();
  console.log(`■ 測る（${hours}h・fetched=${fetched}）`);
  console.log(`  参考 gapsFromOps（生）: ${nRaw.line}`);
  console.log(`    判定: ${nRaw.allowed ? "許可OK" : "未達"} ${nRaw.gaps.join("／")}`);
  console.log(`  正本 1押下畳み: ${nFold.line}`);
  console.log(`    判定: ${nFold.allowed ? "許可OK" : "未達"} ${nFold.gaps.join("／")}`);

  const bp = await loadBundlePointPct();
  const autoPt = await measureAutoPointPct(hours);
  const ptPick = pickPointPctForImprove(autoPt.pointPct, bp.pointPct, autoPt.rows);
  const cursorForPlan =
    autoPt.cursorPct != null && autoPt.rows >= 3 ? autoPt.cursorPct : bp.cursorPct;
  console.log(
    `■ 束 realpro#${bp.bundleId} bundle位置=${bp.pointPct}% cursor=${bp.cursorPct}% thin欄=${bp.thinFields.length}`,
  );
  console.log(`  ${autoPt.line} → 計画は位置=${ptPick.pointPct}%（${ptPick.source}）`);

  const unread = (await findShotsToLearn({
    site: "realpro",
    mode: "normal",
    days: 7,
    limit: 200,
    order: "newest",
    perSig: 8,
    strideMs: 1500,
  })).length;
  console.log(`  通常未学習（候補）: ${unread}`);

  // 人の間隔は畳み通常を使う（生は写真窓の重ねで短く見える）
  const normalForPace = (folded.normal?.gaps?.length ? folded.normal.gaps : []) as number[];
  const pace = learnGapPaceFromNormalGaps(normalForPace.length >= 10 ? normalForPace : []);
  if (pace) {
    console.log(`■ 人の間隔（束へ書く材料・畳み）: 中央値${pace.median_ms}ms・n=${pace.samples}・floor=${pace.floor_ms}・human帯${pace.humanBandPct}%`);
  }

  // ★ 改善計画は 1押下畳みを主（生は短間隔が人工的に跳ねる）
  const nearPick = pickNearnessForImprove(
    { score: nRaw.score.total, fast: nRaw.auto.fast400pct, hb: nRaw.auto.humanBandPct, gN: nRaw.auto.gN },
    { score: nFold.score.total, fast: nFold.auto.fast400pct, hb: nFold.auto.humanBandPct, gN: nFold.auto.gN },
  );
  console.log(`  近さの正本: ${nearPick.source}（畳み自動n=${nFold.auto.gN}／生n=${nRaw.auto.gN}）`);

  const plan = buildHumanLikeImprovePlan({
    nearnessScore: nearPick.nearnessScore,
    fast400pct: nearPick.fast400pct,
    humanBandPct: nearPick.humanBandPct,
    pointPct: ptPick.pointPct,
    cursorPct: cursorForPlan,
    unreadNormal: unread,
    thinPointFields: bp.thinFields.length ? bp.thinFields : undefined,
  });

  console.log("\n■ 計画");
  console.log(`  ${plan.line}`);
  console.log(`  phase=${plan.phase} photo_limit=${plan.photo_limit}`);
  plan.cycle.forEach((t, i) => {
    console.log(`  ${i + 1}. [${t.kind}] ${t.what}`);
    console.log(`      なぜ: ${t.why} ／費用: ${t.cost}${t.limit != null ? ` ／limit=${t.limit}` : ""}`);
  });

  const stampDir = join(process.cwd(), "memory");
  mkdirSync(stampDir, { recursive: true });
  const stamp = {
    at: plan.at,
    hours,
    nearness_source: nearPick.source,
    nearness_raw: {
      score: nRaw.score.total,
      fast: nRaw.auto.fast400pct,
      hb: nRaw.auto.humanBandPct,
      allowed: nRaw.allowed,
      gN: nRaw.auto.gN,
    },
    nearness_fold: {
      score: nFold.score.total,
      fast: nFold.auto.fast400pct,
      hb: nFold.auto.humanBandPct,
      allowed: nFold.allowed,
      gN: nFold.auto.gN,
    },
    point_pct: ptPick.pointPct,
    point_source: ptPick.source,
    auto_point: { rows: autoPt.rows, point: autoPt.pointPct, cursor: autoPt.cursorPct },
    cursor_pct: cursorForPlan,
    gap_pace: pace,
    plan: { phase: plan.phase, gaps: plan.gaps, photo_limit: plan.photo_limit, cycle: plan.cycle.map((t) => t.kind) },
    allow: NEARNESS_ALLOW,
  };
  writeFileSync(join(stampDir, "human_like_improve_last.json"), JSON.stringify(stamp, null, 2));
  const ev = evaluateHumanLikeImproveStamp(stamp);
  console.log(`■ スタンプ判定: ${ev.ok ? "完了" : "未完"} ${ev.next}`);

  if (plan.ok) {
    console.log("\n✓ 完了線クリア（周回不要）");
    return;
  }
  if (planOnly) {
    console.log("\n（--plan-only のため実行しない）");
    return;
  }

  // 無料: 人の間隔を束に書く（間隔寄せの材料）
  if (pace && plan.cycle.some((t) => t.kind === "reflect_auto" && /gaps|間隔/.test(t.what))) {
    const refGaps = await patchRealproBundle((b) => {
      b.gaps = {
        median_ms: pace.median_ms,
        samples: pace.samples,
        p10: pace.p10,
        p50: pace.p50,
        p90: pace.p90,
        floor_ms: pace.floor_ms,
        fast400pct: pace.fast400pct,
        humanBandPct: pace.humanBandPct,
        at: pace.at,
      };
      b.human_nearness = {
        score: nRaw.score.total,
        allowed: nRaw.allowed,
        gaps: nRaw.gaps,
        line: nRaw.line,
        auto_fast400pct: nRaw.auto.fast400pct,
        auto_humanBandPct: nRaw.auto.humanBandPct,
        auto_p50: nRaw.auto.p50,
        normal_p50: nRaw.normal.p50,
        auto_gN: nRaw.auto.gN,
        normal_gN: nRaw.normal.gN,
        allow_scoreMin: NEARNESS_ALLOW.scoreMin,
        allow_fast400MaxPct: NEARNESS_ALLOW.fast400MaxPct,
        allow_humanBandMinPct: NEARNESS_ALLOW.humanBandMinPct,
        at: new Date().toISOString(),
      };
      b.human_like_improve = {
        at: plan.at,
        phase: plan.phase,
        gaps: plan.gaps,
        photo_limit: plan.photo_limit,
        next: plan.cycle[0]?.kind ?? null,
      };
    });
    console.log(`\n■ 束へ gaps / nearness 反映: ${refGaps}`);
  }

  const photoTasks = plan.cycle.filter((t) => t.kind === "photo_learn");
  if (!photoTasks.length) {
    console.log("\n■ Vision なし（間隔寄せは人の手）");
    for (const t of plan.cycle) {
      if (t.kind === "need_ext_reload" || t.kind === "need_auto_run" || t.kind === "verify_improve") {
        console.log(`  🙋 ${t.what}`);
      }
    }
    console.log("  1. chrome://extensions 再読込（≥2.8.198）→束取得→自動1回");
    console.log("  2. npx tsx --env-file=.env.local scripts/human-like-improve.ts --plan-only");
    return;
  }

  if (dryRun && !yesCost) {
    const focus = photoTasks[0].fields || [];
    const limit = Math.min(plan.photo_limit || 40, Number(photoTasks[0].limit) || 40);
    console.log(`\n■ dry-run Vision（2枚・読み方確かめ） focus=${focus.slice(0, 4).join("・")}`);
    const r = await learnFromWeakShots({
      site: "realpro",
      mode: "normal",
      days: 7,
      limit: 2,
      order: "newest",
      perSig: 4,
      strideMs: 800,
      dryRun: true,
      noRefresh: true,
      concurrency: 1,
      focusFields: focus.length ? focus : null,
    });
    console.log(`  dry-run: 試した${r.tried}・読めた${r.learned}・fields=${r.fields} errors=${r.errors.slice(0, 2).join("｜") || "-"}`);
    console.log("\n次: --yes-cost で本番読み（枚数≈" + limit + "＋連続があれば別途）");
    console.log("    npx tsx --env-file=.env.local scripts/human-like-improve.ts --yes-cost");
    return;
  }

  if (!yesCost) {
    console.log("\n💰 photo_learn は --yes-cost が必要（竹内さん「費用かかっても大丈夫」なら付けて実行）");
    process.exitCode = 3;
    return;
  }

  let learnedTotal = 0;
  /**
   * ★ 2026-11-23: 途中は noRefresh（何度も束を作ると重い）。
   *   最後の1回だけ束を作り直す → 学習した位置が points に届く。
   *   （実測: 全タスク noRefresh のままだと 51+26枚読んでも束 thin が動かない）
   */
  for (let ti = 0; ti < photoTasks.length; ti++) {
    const task = photoTasks[ti];
    const last = ti === photoTasks.length - 1;
    const limit = Math.min(Number(task.limit) || plan.photo_limit || 40, 120);
    const focus = task.fields || [];
    const order = (task.order as "newest" | "sequence") || "newest";
    console.log(`\n■ photo_learn 実行 order=${order} limit=${limit} focus=${focus.slice(0, 5).join("・")}${last ? "（最後→束作り直し）" : ""}`);
    let r = await learnFromWeakShots({
      site: "realpro",
      mode: "normal",
      days: 7,
      limit,
      order,
      perSig: order === "sequence" ? 4 : 10,
      strideMs: order === "sequence" ? 400 : 800,
      dryRun: false,
      noRefresh: !last,
      concurrency: 3,
      focusFields: focus.length ? focus : null,
      onProgress: (done, total, lastMsg) => {
        if (done === total || done % 5 === 0) console.log(`  … ${done}/${total} ${lastMsg.slice(0, 60)}`);
      },
    });
    if (r.tried === 0 && focus.length) {
      console.log("  ↪ 通常0 → サイト指定なしで再試行");
      r = await learnFromWeakShots({
        site: null,
        mode: "normal",
        days: 7,
        limit,
        order,
        perSig: 10,
        strideMs: 800,
        dryRun: false,
        noRefresh: !last,
        concurrency: 3,
        focusFields: focus,
      });
    }
    learnedTotal += r.learned;
    console.log(`  結果: 試した${r.tried}・読めた${r.learned}・保存${r.saved}・fields=${r.fields}`);
    if (r.errors.length) console.log(`  ⚠ ${r.errors.slice(0, 3).join("｜")}`);
  }

  /** 作り直し後に人の間隔・近さを上書き（brain の全ops中央値で薄まらないように） */
  const ref = await patchRealproBundle((b) => {
    if (pace) {
      b.gaps = {
        median_ms: pace.median_ms,
        samples: pace.samples,
        p10: pace.p10,
        p50: pace.p50,
        p90: pace.p90,
        floor_ms: pace.floor_ms,
        fast400pct: pace.fast400pct,
        humanBandPct: pace.humanBandPct,
        at: pace.at,
      };
    }
    b.human_nearness = {
      score: nFold.score.total,
      allowed: nFold.allowed,
      gaps: nFold.gaps,
      line: nFold.line,
      auto_fast400pct: nFold.auto.fast400pct,
      auto_humanBandPct: nFold.auto.humanBandPct,
      at: new Date().toISOString(),
      source: "fold",
    };
    b.human_like_improve = {
      at: new Date().toISOString(),
      phase: plan.phase,
      gaps: plan.gaps,
      photo_learned: learnedTotal,
      next: "need_ext_reload",
    };
  });
  console.log(`  gaps/nearness 再載: ${ref}`);

  console.log("\n■ 人の手（ここから）");
  console.log("  1. chrome://extensions で拡張再読込（≥2.8.206）");
  console.log("  2. ポップアップで束取得（gaps.median_ms・points が入っていること）");
  console.log("  3. 自動1回");
  console.log("  4. npx tsx --env-file=.env.local scripts/human-like-improve.ts --plan-only");
  console.log("     （近さ・位置が完了線に近づいたか再測。未達ならまた --yes-cost）");

  try {
    const { saveImprovement } = await import("../app/lib/learn-improvements");
    await saveImprovement({
      area: "学習",
      title: `人間らしさ改善ループ photo=${learnedTotal}・gaps中央値${pace?.median_ms ?? "-"}`,
      why: plan.line,
      how: "human-like-improve: 測る→gaps書込→photo_learn→束反映→拡張→自動→再測",
      effect: "point_pct・aim有・短間隔/human帯を完了線へ寄せる",
      verify: "npx tsx --env-file=.env.local scripts/human-like-improve.ts --plan-only",
    });
  } catch (_) { /* ignore */ }

  hr();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
