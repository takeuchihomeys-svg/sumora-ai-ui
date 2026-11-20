/**
 * 通常録画の「駅の遷移（外し・選び）」を、最新の束（realpro / all）の scene_flows.station へ合流する（2026-11-19）
 *
 * なぜ要るか（実測 2026-11-19）:
 *   ・束 id 2445（realpro）の station は `transportation_id → required_time` だけ。
 *     「駅の設定へ進む」「沿線の設定へ戻る」が無い → 自動が駅を外す順番を学べない（F31 が 0）。
 *   ・通常録画の shot_ops には 駅の設定へ進む・沿線の設定へ戻る・one_station・one_line がある。
 *   ・ただし sceneOfOp が one_station / one_line を other に落としていた（2026-11-19 直した）。
 *
 * やること（既定は dry-run）:
 *   1. 直近7日の realpro の人の操作（shot_ops）を、束と同じ材料・同じ窓で読む
 *   2. 駅の遷移を含む回だけ取り出し、場面 station の手順（一番よく出る遷移付き）を作る
 *   3. 最新の束（scope=realpro / all）の scene_flows.station を差し替える（遷移付きの時だけ）
 *   4. inheritLinkFoundations で学習（solid）が消えないか確かめる（危ない時は書かない）
 *   5. --write の時だけ human_learn_profile に新しい行を足す（消さない・古い行は残る）
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/merge-station-transit.ts           （dry-run・書かない）
 *   npx tsx --env-file=.env.local scripts/merge-station-transit.ts --write   （新しい束を足す）
 */
import { createClient } from "@supabase/supabase-js";
import { learnSceneFlows, sceneOfOp } from "../app/lib/learn-flow-steps";
import { applyBundleAliasExpansion } from "../app/lib/field-name-aliases";
import { inheritLinkFoundations, countLearnedSolid } from "../app/lib/learn-bundle-preserve";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);
const doWrite = process.argv.includes("--write");
const TRANSIT = /駅の設定へ進む|沿線の設定へ戻る|one_station|one_line|route_id/;

type Op = { f?: unknown; k?: unknown; by?: unknown };
type Step = { k: string; t: null; by: string };

const hasTransit = (steps: string[]) => steps.some((s) => TRANSIT.test(String(s)));

void (async () => {
  // 1) 直近7日の realpro の人の操作（束の作り方 human-learn-profile と同じ窓・同じ件数）
  const since7 = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data: rows, error: re } = await sb
    .from("human_motion_learn")
    .select("site, mode, shot_ops")
    .eq("site", "realpro")
    .gte("created_at", since7)
    .order("created_at", { ascending: false })
    .limit(600);
  if (re) throw new Error("human_motion_learn: " + re.message);

  const runs: Step[][] = [];
  for (const r of (rows ?? []) as Array<{ shot_ops?: unknown }>) {
    const ops: Op[] = Array.isArray(r.shot_ops) ? (r.shot_ops as Op[]) : [];
    const names: Step[] = ops
      .filter((o) => o && typeof o.f === "string" && String(o.f) && o.k !== "diag")
      .filter((o) => o.by === undefined || o.by === null || o.by === "human")
      .map((o) => ({ k: "click:" + String(o.f), t: null, by: "human" }));
    if (names.length >= 2) runs.push(names.slice(0, 40));
  }

  // 2) 駅の遷移を含む回だけ → 場面 station の手順（一番よく出る遷移付き）
  const transitRuns = runs.filter((r) => r.some((x) => TRANSIT.test(x.k)));
  const stationFlow = learnSceneFlows(transitRuns as never).find((f) => f.scene === "station");
  const stNew = stationFlow && hasTransit(stationFlow.steps) ? stationFlow : null;
  console.log(`録画の手本 ${runs.length}回（うち駅の遷移あり ${transitRuns.length}回）`);
  if (!stNew) {
    console.log("⚠ 遷移付きの駅の手順が作れなかった。束は触らない。");
    return;
  }
  console.log(`新しい station 手順: runs=${stNew.runs} ops=${stNew.ops} variants=${stNew.variants}`);
  console.log("  " + stNew.steps.slice(0, 14).join(" → "));
  console.log("  分類確認: 駅の設定へ進む→" + sceneOfOp("click:駅の設定へ進む｜span") + " / 河内小阪|one_station→" + sceneOfOp("click:河内小阪｜label.one_station"));

  // 3) 最新の束（scope ごと・学習の入った物）に合流
  for (const scope of ["realpro", "all"] as const) {
    const { data: prof, error: pe } = await sb
      .from("human_learn_profile")
      .select("id,created_at,scope,bundle,source_rows,source_from,source_to,lines")
      .eq("scope", scope)
      .order("created_at", { ascending: false })
      .limit(20);
    if (pe) { console.warn(scope, "束を読めない:", pe.message); continue; }
    const donor = (prof ?? []).find((r) => countLearnedSolid((r.bundle || {}) as Record<string, unknown>).solid >= 30) ?? prof?.[0];
    if (!donor) { console.warn(scope, "束が無い"); continue; }

    const bundle = JSON.parse(JSON.stringify(donor.bundle || {})) as Record<string, unknown>;
    const before = countLearnedSolid(bundle).solid;
    const flowsOld = Array.isArray(bundle.scene_flows) ? (bundle.scene_flows as Array<Record<string, unknown>>) : [];
    const oldSt = flowsOld.find((f) => f && f.scene === "station");
    const oldSteps = Array.isArray(oldSt?.steps) ? (oldSt!.steps as string[]) : [];
    const keepTransit = hasTransit(oldSteps);
    if (keepTransit) {
      console.log(scope, "既に駅の遷移あり（置き換えない）:", oldSteps.slice(0, 6).join(" → "));
      continue;
    }
    const next = flowsOld.filter((f) => f && f.scene !== "station");
    next.push({
      scene: "station",
      runs: stNew.runs,
      ops: stNew.ops,
      raw_ops: stNew.raw_ops,
      steps: stNew.steps,
      variants: stNew.variants,
      gap_ms: stNew.gap_ms,
      source: "merge_station_transit_20261119",
    });
    bundle.scene_flows = next;
    bundle.station_transit_merged_at = new Date().toISOString();
    applyBundleAliasExpansion(bundle);

    const pr = await inheritLinkFoundations(sb, bundle, scope, { lookback: 80, minSolid: 30 });
    const after = countLearnedSolid(bundle).solid;
    console.log(scope, { donor: donor.id, solid: `${before}→${after}`, safe: pr.safe_to_write, why: pr.why });

    if (!doWrite) continue;
    if (!pr.safe_to_write) { console.warn(scope, "書かない（学習が消える恐れ）"); continue; }
    // 前の束を写して書くので、手順書（と名前の除去）は書く直前に作り直す（古い手順書を写さない）
    const { prepareBundleForWrite } = await import("../app/lib/bundle-write-prepare");
    prepareBundleForWrite(bundle as Record<string, unknown>);
    const { data: ins, error } = await sb
      .from("human_learn_profile")
      .insert({
        scope,
        source_rows: donor.source_rows,
        source_from: donor.source_from,
        source_to: donor.source_to,
        bundle,
        lines: [
          ...((Array.isArray(donor.lines) ? donor.lines : []) as string[]).slice(0, 40),
          "通常録画の駅の遷移（外し・選び）を station に合流（2026-11-19）",
        ],
        read_count: 0,
        read_at: null,
      })
      .select("id,created_at")
      .single();
    if (error) console.error(scope, "書けない:", error.message);
    else console.log("書いた", scope, ins?.id, ins?.created_at);
  }
  if (!doWrite) console.log("\n（dry-run）書くときは --write");
})();
