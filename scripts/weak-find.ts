/**
 * 弱い所の横断洗い出し（F60）
 *
 *   npx tsx --env-file=.env.local scripts/weak-find.ts
 *
 * 測る → 名指し → 強化ルート。推測で弱点を増やさない。
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fetchPlaybookReflect } from "../app/lib/playbook-reflect-server";
import {
  computeHumanNearness,
  pressGapsFromRows,
  NEARNESS_ALLOW,
} from "../app/lib/human-nearness";
import { isAutoMode } from "../app/lib/press-by";
import { auditHumanLike, judgeHumanLikePass } from "../app/lib/human-like-audit";
import { auditGuideScreenGraspFromAudits } from "../app/lib/guide-screen-grasp";
import { auditExtTestImproveLoop } from "../app/lib/ext-test-improve-loop";
import {
  buildWeakFindPlan,
  WEAK_FIND_STAMP_REL,
} from "../app/lib/weak-find-strengthen";
import { evaluateHumanLikeImproveStamp } from "../app/lib/human-like-improve-loop";
import { autoRulesVersion, type PlaybookSeen } from "../app/lib/auto-procedure-rules";
import { countFineAtomsAcrossAudits } from "../app/lib/handoff-loop-ledger";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

function hr() {
  console.log("─".repeat(66));
}

async function main() {
  hr();
  console.log("【F60 弱所横断】realpro");
  hr();

  const { data: prof } = await sb
    .from("human_learn_profile")
    .select("id,bundle,created_at")
    .eq("scope", "realpro")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const bundle = (prof?.bundle || {}) as Record<string, unknown>;
  const pb = (bundle.playbook || null) as { build_v?: number; rules?: unknown[] } | null;
  const points = (bundle.points || {}) as Record<string, { n?: number; x?: number }>;
  let thin = 0;
  for (const v of Object.values(points)) {
    if (typeof v?.x === "number" && (Number(v.n) || 0) < 3) thin++;
  }

  const rep = await fetchPlaybookReflect(process.env, { scope: "realpro", runs: 10 });
  /** 統括Pro: playbook_seen は「印あり」だけでは不足。決まり版(rv)がコードと一致すること */
  const codeRv = autoRulesVersion();
  const seenRows = rep.runs
    .map((r) => r.seen)
    .filter((s): s is PlaybookSeen => !!s && s !== "none");
  let playbookSeen = false;
  let playbookSeenWhy: string | null = null;
  if (!seenRows.length) {
    playbookSeenWhy = "直近自動に playbook_seen 印なし";
  } else {
    const last = seenRows[0];
    if (last.rules_v && last.rules_v === codeRv) {
      playbookSeen = true;
    } else {
      playbookSeenWhy = `印ありだが rv=${last.rules_v ?? "-"} ≠ コード ${codeRv}`;
    }
  }
  const adNg = rep.per_rule.find((p) => p.id === "ad_sort_hover");
  const adSortOk = !adNg ? null : adNg.ng > 0 ? false : adNg.ok > 0 ? true : null;

  /** ★ 列名は ext_version（extension_version だと PostgREST が空返し→連続客0件の誤測） */
  const { data: audits } = await sb
    .from("search_audits")
    .select("steps,mode,ext_version,created_at")
    .eq("site", "realpro")
    .order("created_at", { ascending: false })
    .limit(40);

  const f57 = auditGuideScreenGraspFromAudits(
    (audits || []).map((a) => ({
      steps: a.steps,
      mode: a.mode,
      ext_version: a.ext_version,
    })),
  );
  const f58 = auditExtTestImproveLoop(process.cwd());

  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const motion: Array<{ mode?: unknown; shot_ops?: unknown; install_id?: unknown; point_fields?: unknown; moves_n?: unknown }> = [];
  for (let i = 0; i < 3000; i += 1000) {
    const { data } = await sb
      .from("human_motion_learn")
      .select("mode,shot_ops,install_id,point_fields,moves_n")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(i, i + 999);
    if (!data?.length) break;
    motion.push(...(data as never[]));
    if (data.length < 1000) break;
  }
  const folded = pressGapsFromRows(motion, (row) => {
    const m = String(row.mode || "").toLowerCase();
    if (isAutoMode(m)) return "auto";
    if (m === "normal") return "normal";
    return null;
  });
  const nFold = computeHumanNearness({
    normalGaps: folded.normal?.gaps || [],
    autoGaps: folded.auto?.gaps || [],
  });

  const autoRows = motion.filter((r) => isAutoMode(String(r.mode || "").toLowerCase()));
  let autoPoint: number | null = null;
  let autoCursor: number | null = null;
  if (autoRows.length >= 3) {
    const pass = judgeHumanLikePass(auditHumanLike(autoRows as never, { pressBy: "auto" }));
    autoPoint = pass.pointPct;
    autoCursor = pass.cursorPct;
  }

  const bundleAt = prof?.created_at ? new Date(prof.created_at).getTime() : 0;
  const autoAfter = (audits || []).some((a) => {
    const t = a.created_at ? new Date(a.created_at).getTime() : 0;
    return t > bundleAt && /aix|auto|staff|brain/i.test(String(a.mode || ""));
  });

  const handoffTallied = countFineAtomsAcrossAudits(
    (audits || []).map((a) => ({ steps: a.steps })),
  );
  const mustHandoff = ["switch", "place_clear", "search", "fill_done", "post_send_clear", "ready_next"] as const;
  const continuousOk = mustHandoff.every((id) => (handoffTallied.counts[id] || 0) >= 1);
  const continuousWhy = continuousOk
    ? null
    : `弱0回=${handoffTallied.weak.slice(0, 5).join("・") || "必須欠"}／post=${handoffTallied.counts.post_send_clear}`;

  const plan = buildWeakFindPlan({
    autoAfterBundle: autoAfter,
    playbookReflectOk: rep.reflect.ok,
    playbookReflectWhy: rep.reflect.why.slice(0, 2).join("／") || null,
    playbookSeenRecent: playbookSeen,
    playbookSeenWhy,
    adSortOk,
    nearnessScore: nFold.score.total,
    humanBandPct: nFold.auto.humanBandPct,
    autoPointPct: autoPoint,
    autoCursorPct: autoCursor,
    f57Ok: f57.improve_complete,
    f57Why: (f57.line || "").slice(0, 80) || null,
    extTestOk: f58.ok,
    thinPointFields: thin,
    continuousHandoffOk: continuousOk,
    continuousHandoffWhy: continuousWhy,
  });

  console.log(`■ 束 realpro#${prof?.id} build_v=${pb?.build_v} rules=${Array.isArray(pb?.rules) ? pb!.rules!.length : "-"} thin=${thin}`);
  console.log(`  手順書反映: ${rep.reflect.ok ? "✓" : "✗"} ${rep.reflect.why.slice(0, 2).join("／")}`);
  console.log(`  新束後自動: ${autoAfter ? "あり" : "なし"}／playbook_seen=${playbookSeen ? "✓現行" : `✗ ${playbookSeenWhy || ""}`}`);
  console.log(`  近さ畳み: ${nFold.line}`);
  console.log(`  自動位置/カーソル: ${autoPoint ?? "-"}% / ${autoCursor ?? "-"}%`);
  console.log(`  F57: ${f57.improve_complete ? "✓" : "✗"} ${(f57.line || "").slice(0, 100)}`);
  console.log(`  F58: ${f58.ok ? "✓" : "✗"} ${f58.line}`);
  console.log(`  連続客F61/F62: ${continuousOk ? "✓" : "✗"} ${handoffTallied.line.slice(0, 120)}`);

  console.log("\n■ 弱所一覧（優先順）");
  if (!plan.gaps.length) {
    console.log("  （未達なし）");
  } else {
    plan.gaps.forEach((g, i) => {
      const m = g.mech.exists
        ? `仕組みあり/${g.mech.blocked === "none" ? "完了" : g.mech.blocked === "human" ? "人待ち" : g.mech.blocked === "cost" ? "費用" : "コード"}`
        : "仕組み無し";
      console.log(`  ${i + 1}. [${g.severity}/${g.layer}] ${g.id}: ${g.why}`);
      console.log(`      → ${g.next}`);
      console.log(`      道具: ${g.script} ／ ${m}（${g.mech.name}）`);
    });
  }
  console.log(`\n■ ${plan.line}`);
  console.log(`  ${plan.mech_line}`);
  console.log(`  次: ${plan.next}`);

  const hlPath = join(process.cwd(), "memory/human_like_improve_last.json");
  if (existsSync(hlPath)) {
    try {
      const stamp = JSON.parse(readFileSync(hlPath, "utf8"));
      const ev = evaluateHumanLikeImproveStamp(stamp);
      console.log(`\n■ F59 人間らしさスタンプ: ${ev.ok ? "✓" : "未完"} ${ev.next}`);
    } catch (_) { /* ignore */ }
  }

  mkdirSync(join(process.cwd(), "memory"), { recursive: true });
  const stamp = {
    at: plan.at,
    ok: plan.ok,
    line: plan.line,
    mech_line: plan.mech_line,
    next: plan.next,
    gaps: plan.gaps.map((g) => ({
      id: g.id,
      severity: g.severity,
      why: g.why,
      script: g.script,
      layer: g.layer,
      mech: g.mech,
    })),
    findings_n: plan.findings.length,
    allow: {
      pointMin: 60,
      cursorMin: 70,
      humanBandMin: NEARNESS_ALLOW.humanBandMinPct,
      nearnessMin: NEARNESS_ALLOW.scoreMin,
    },
    bundle_id: prof?.id ?? null,
  };
  writeFileSync(join(process.cwd(), WEAK_FIND_STAMP_REL), JSON.stringify(stamp, null, 2));
  console.log(`\nスタンプ: ${WEAK_FIND_STAMP_REL}`);
  hr();
  if (!plan.ok) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
