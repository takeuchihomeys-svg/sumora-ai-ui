/**
 * 並べ替えを連続録画から理解できるまで学ぶ
 *
 *   npx tsx --env-file=.env.local scripts/sort-sequence-learn.ts --plan
 *   npx tsx --env-file=.env.local scripts/sort-sequence-learn.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/sort-sequence-learn.ts --yes-cost
 *
 * 統括Pro: 未学習 run（mwrkvjeo_ug84 等）を order=sequence で読み、
 * sort_detail/高→低 を束に載せ、誤認の棟戸並べ替え points を落とす。
 */
import { createClient } from "@supabase/supabase-js";
import { learnFromWeakShots } from "../app/lib/shot-learn-server";
import { expandAliasPoints } from "../app/lib/field-name-aliases";
import { prepareBundleForWrite } from "../app/lib/bundle-write-prepare";
import {
  SORT_FOCUS_FIELDS,
  tallySortRuns,
  evaluateSortUnderstandGate,
  pickSortRunsToLearn,
  stripFalseSortPoints,
  harvestSortPointsFromOps,
} from "../app/lib/sort-sequence-learn";

const args = process.argv.slice(2);
const planOnly = args.includes("--plan");
const dryRun = args.includes("--dry-run") || (!args.includes("--yes-cost") && !planOnly);
const yesCost = args.includes("--yes-cost");
const days = Math.max(1, Number((args.find((a) => a.startsWith("--days=")) || "").replace("--days=", "")) || 14);
const preferRaw = (args.find((a) => a.startsWith("--run=")) || "").replace("--run=", "");
const preferRuns = preferRaw
  ? preferRaw.split(",").map((s) => s.trim()).filter(Boolean)
  : ["mwrkvjeo_ug84", "mwrkvjdp_4zgr"];

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

async function loadRows() {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 8000; i += 1000) {
    const { data, error } = await sb
      .from("human_motion_learn")
      .select("created_at,site,mode,kinds,fields,point_fields,shot_ops,shot_learn,shot_taken,shot_key")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Array<Record<string, unknown>>));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function loadRealproBundle() {
  const { data } = await sb
    .from("human_learn_profile")
    .select("id,bundle,created_at,read_count")
    .eq("scope", "realpro")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function patchBundle(mutator: (b: Record<string, unknown>) => void): Promise<string> {
  const data = await loadRealproBundle();
  if (!data?.bundle) return "束なし";
  const clone = JSON.parse(JSON.stringify(data.bundle)) as Record<string, unknown>;
  mutator(clone);
  try {
    prepareBundleForWrite(clone);
  } catch {
    /* playbook 失敗でも points は書く */
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
  console.log("──────────────────────────────────────────────────────────────────");
  console.log(`【並べ替え連続学習】days=${days} dryRun=${dryRun} yesCost=${yesCost} plan=${planOnly}`);
  console.log("──────────────────────────────────────────────────────────────────");

  const rows = await loadRows();
  const runs = tallySortRuns(rows);
  const realUnlearned = runs.filter((r) => r.hasRealSort && r.realUnlearned > 0);
  const bun = await loadRealproBundle();
  const points = ((bun?.bundle as { points?: Record<string, { x?: number; y?: number; n?: number }> })?.points) || {};
  const gate0 = evaluateSortUnderstandGate({ points, runs });

  console.log(`■ 通常行=${rows.filter((r) => String(r.mode).toLowerCase() === "normal").length} sortラン=${runs.length} 本物未読ラン=${realUnlearned.length}`);
  console.log(`■ 束#${bun?.id} read=${bun?.read_count ?? "-"}`);
  console.log(`■ ${gate0.line}`);
  console.log(`  次: ${gate0.next}`);
  if (gate0.falsePointKeys.length) {
    console.log(`  誤認points: ${gate0.falsePointKeys.slice(0, 6).join("・")}${gate0.falsePointKeys.length > 6 ? "…" : ""}`);
  }
  if (gate0.realPointKeys.length) {
    console.log(`  本物points: ${gate0.realPointKeys.join("・")}`);
  }

  const targets = pickSortRunsToLearn(runs, preferRuns, 4);
  console.log("\n■ 学習対象ラン（本物 sort・未読優先）");
  for (const t of targets) {
    console.log(`  ${t.run_id}  shot=${t.withShot} 本物=${t.realShot} 本物未読=${t.realUnlearned} hits=${t.hits.join("|")}`);
  }
  if (!targets.length) {
    console.log("  （本物の未学習ランなし）");
  }

  if (planOnly) {
    console.log("\n（--plan のため Vision しない）");
    return;
  }

  if (gate0.ok && !yesCost) {
    console.log("\n✓ 理解完了線クリア。拡張再読込→自動1回へ");
    return;
  }

  // 無料: 誤認除去＋通常opsから sort_detail/高→低 の座標を収穫して束へ
  {
    const harvested = harvestSortPointsFromOps(rows);
    const ref = await patchBundle((b) => {
      const pts = {
        ...((b.points || {}) as Record<string, { x?: number; y?: number; n?: number }>),
        ...harvested,
      };
      const stripped = stripFalseSortPoints(pts);
      b.points = expandAliasPoints(stripped.points);
      b.sort_sequence_learn = {
        at: new Date().toISOString(),
        stripped_false: stripped.removed,
        harvested_keys: Object.keys(harvested),
        phase: "ops_harvest",
      };
    });
    console.log(
      `\n■ 誤認除去＋ops収穫: ${ref} 収穫=${Object.keys(harvested).length}キー`
        + (Object.keys(harvested).length
          ? `（例: ${Object.entries(harvested).slice(0, 3).map(([k, v]) => `${k}@${v.x},${v.y} n=${v.n}`).join("／")}）`
          : ""),
    );
  }

  const focus = [...SORT_FOCUS_FIELDS];
  let learnedTotal = 0;

  if (dryRun && !yesCost) {
    console.log(`\n■ dry-run Vision（2枚・読み方確かめ） focus=${focus.join("・")}`);
    const r = await learnFromWeakShots({
      site: "realpro",
      mode: "normal",
      days,
      limit: 2,
      order: "sequence",
      perSig: 4,
      strideMs: 400,
      dryRun: true,
      noRefresh: true,
      concurrency: 1,
      focusFields: focus,
      runId: targets[0]?.run_id || null,
    });
    console.log(`  dry-run: 試した${r.tried}・読めた${r.learned}・fields=${r.fields} errors=${r.errors.slice(0, 2).join("｜") || "-"}`);
    console.log("\n次: --yes-cost で未学習ランを連続読み（統括枚数・解けるまで）");
    console.log("    npx tsx --env-file=.env.local scripts/sort-sequence-learn.ts --yes-cost");
    return;
  }

  if (!yesCost) {
    console.log("\n💰 本番は --yes-cost が必要");
    process.exitCode = 3;
    return;
  }

  // 各ランを sequence で読む（最後のランだけ束作り直し）
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const last = i === targets.length - 1;
    const limit = Math.min(40, Math.max(t.realUnlearned, 6));
    console.log(`\n■ photo_learn sequence run=${t.run_id} limit=${limit}${last ? "（最後→束作り直し）" : ""}`);
    const r = await learnFromWeakShots({
      site: "realpro",
      mode: "normal",
      days,
      limit,
      order: "sequence",
      perSig: 12,
      strideMs: 200,
      dryRun: false,
      noRefresh: !last,
      concurrency: 3,
      focusFields: focus,
      runId: t.run_id,
      /** ラン指定時は間引きを緩め、未読を残さず読む（理解できるまで） */
      all: true,
      onProgress: (done, total, msg) => {
        if (done === total || done % 5 === 0) console.log(`  … ${done}/${total} ${msg.slice(0, 70)}`);
      },
    });
    learnedTotal += r.learned;
    console.log(`  結果: 試した${r.tried}・読めた${r.learned}・保存${r.saved}・fields=${r.fields}`);
    if (r.errors.length) console.log(`  ⚠ ${r.errors.slice(0, 3).join("｜")}`);
  }

  // 作り直し後: ops収穫＋誤認除去＋別名複製を再適用（brain が棟戸を戻しても落とす）
  const harvested2 = harvestSortPointsFromOps(await loadRows());
  const ref2 = await patchBundle((b) => {
    const pts = {
      ...((b.points || {}) as Record<string, { x?: number; y?: number; n?: number }>),
      ...harvested2,
    };
    const stripped = stripFalseSortPoints(pts);
    b.points = expandAliasPoints(stripped.points);
    b.sort_sequence_learn = {
      at: new Date().toISOString(),
      photo_learned: learnedTotal,
      runs: targets.map((t) => t.run_id),
      harvested_keys: Object.keys(harvested2),
      stripped_false: stripped.removed,
      next: "need_ext_reload",
    };
  });
  console.log(`\n■ 束へ sort points/別名: ${ref2}`);

  const rows2 = await loadRows();
  const runs2 = tallySortRuns(rows2);
  const bun2 = await loadRealproBundle();
  const pts2 = ((bun2?.bundle as { points?: Record<string, { x?: number; y?: number; n?: number }> })?.points) || {};
  const gate1 = evaluateSortUnderstandGate({ points: pts2, runs: runs2 });
  console.log(`\n■ 再測: ${gate1.line}`);
  console.log(`  次: ${gate1.next}`);
  console.log("\n■ 人の手");
  console.log("  1. chrome://extensions 再読込（≥2.8.206）");
  console.log("  2. ポップアップで束取得");
  console.log("  3. 自動1回 → ad_sort_hover / aim有 / sort_detail");
  if (!gate1.ok) {
    console.log("  4. 未達ならまた: npx tsx --env-file=.env.local scripts/sort-sequence-learn.ts --yes-cost");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
