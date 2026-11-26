/**
 * 束を作るときの sceneMeta（土台点検・反映状態・場面手順）を揃える。
 *
 * human-learn-profile の buildNow は search_audits 等で場面手順まで作るが、
 * cron / shot-learn の軽い再生成では最低限 foundation_audit + bundle_reflect を渡し、
 * 営業時間（JST 9〜22）は重い audit を避けて直前束から foundation_audit を継ぐ。
 *
 * ★ 2026-11-27 修正:
 *   旧は「昼間(light)のみ直前束をコピー・夜間(cron)はコピーすらしない」構造だったため、
 *   1) 夜間 22:20 の cron 束では scene_flows が空になる
 *   2) 昼間は直前束がずっとコピーされ続け scene_flows が凍結する
 *   → 軽量な computeLightSceneFlows（直近3日・上限120/200件・サイト分離）を追加し、
 *     夜間 cron・scene_flows 欠損・2時間以上古い場合は実データから更新し、失敗時のみ直前束で保険する。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { jstHourNow } from "@/app/lib/batch-daytime-guard";
import type { FoundationForSupervisor } from "@/app/lib/learn-foundation-audit";
import type { SceneFlow } from "@/app/lib/learn-flow-steps";
import { LEARN_PERIODS, sinceIso } from "@/app/lib/learn-periods";

export type LearnBundleSceneMeta = {
  scene_flows?: SceneFlow[] | null;
  scene_missing?: number;
  scene_missing_names?: string;
  stopped_scene?: string | null;
  bundle_reflect?: { read_count?: number; read_at?: string | null; auto_after?: boolean } | null;
  foundation_audit?: FoundationForSupervisor | null;
};

const SCENE_REFRESH_MAX_AGE_MS = 2 * 3600_000;

async function copySceneFieldsFromPrevBundle(
  sb: SupabaseClient,
  scope: string,
): Promise<Pick<LearnBundleSceneMeta, "scene_flows" | "scene_missing" | "scene_missing_names" | "stopped_scene" | "foundation_audit"> & { createdAtMs?: number }> {
  const out: Pick<LearnBundleSceneMeta, "scene_flows" | "scene_missing" | "scene_missing_names" | "stopped_scene" | "foundation_audit"> & { createdAtMs?: number } = {};
  try {
    const { data: prev } = await sb
      .from("human_learn_profile")
      .select("created_at,bundle")
      .eq("scope", scope)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prev?.created_at) {
      const ms = Date.parse(String(prev.created_at));
      if (Number.isFinite(ms)) out.createdAtMs = ms;
    }
    const b = (prev?.bundle ?? null) as Record<string, unknown> | null;
    if (!b || typeof b !== "object") return out;
    if (b.foundation_audit && typeof b.foundation_audit === "object") {
      out.foundation_audit = b.foundation_audit as FoundationForSupervisor;
    }
    if (Array.isArray(b.scene_flows) && b.scene_flows.length) {
      out.scene_flows = b.scene_flows as SceneFlow[];
      if (typeof b.scene_missing === "number") out.scene_missing = b.scene_missing;
      if (typeof b.scene_missing_names === "string") out.scene_missing_names = b.scene_missing_names;
      if (typeof b.stopped_scene === "string") out.stopped_scene = b.stopped_scene;
    }
  } catch (e) {
    console.warn("[learn-bundle-scene-meta] 直前束を読めません:", e instanceof Error ? e.message : String(e));
  }
  return out;
}

/** 直近データから軽量に scene_flows / scene_missing / stopped_scene を組み立てる（サイト分離） */
async function computeLightSceneFlows(
  sb: SupabaseClient,
  scopeNorm: string,
): Promise<Pick<LearnBundleSceneMeta, "scene_flows" | "scene_missing" | "scene_missing_names" | "stopped_scene">> {
  try {
    const { learnSceneFlows, findWeakScenes, lastSceneOf, SCENE_JA } = await import("@/app/lib/learn-flow-steps");
    const since = sinceIso(LEARN_PERIODS.materialsMs);
    type Op = { k?: string | null; t?: number | null; by?: string | null };

    let fq = sb
      .from("search_audits")
      .select("status, site, filled")
      .gte("created_at", since)
      .not("filled", "is", null)
      .order("created_at", { ascending: false })
      .limit(120);
    if (scopeNorm !== "all") fq = fq.eq("site", scopeNorm);
    const fr = await fq;

    let sceneFlows: SceneFlow[] | null = null;
    let stoppedScene: string | null = null;
    const stopAt: Record<string, number> = {};

    if (!fr.error && Array.isArray(fr.data)) {
      const runs: Op[][] = [];
      for (const r of fr.data as Array<{ status?: string | null; filled?: { ops?: Op[] } | null }>) {
        const ops = Array.isArray(r.filled?.ops) ? r.filled!.ops! : [];
        if (ops.length >= 2) runs.push(ops);
        if (String(r.status ?? "") !== "finished" && ops.length >= 2) {
          const lastSc = lastSceneOf(ops);
          if (lastSc) stopAt[SCENE_JA[lastSc]] = (stopAt[SCENE_JA[lastSc]] ?? 0) + 1;
        }
      }
      if (runs.length) sceneFlows = learnSceneFlows(runs);
      const topStop = Object.entries(stopAt).sort((a, b) => b[1] - a[1])[0];
      if (topStop) stoppedScene = topStop[0];
    }

    let mq = sb
      .from("human_motion_learn")
      .select("site, field_order, point_fields, shot_ops")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200);
    if (scopeNorm !== "all") mq = mq.eq("site", scopeNorm);
    const mr = await mq;

    if (!mr.error && Array.isArray(mr.data)) {
      const runs2: Array<Array<{ k: string; t: null; by: string }>> = [];
      for (const r of mr.data as Array<{ field_order?: unknown; point_fields?: unknown; shot_ops?: unknown }>) {
        const order = Array.isArray(r.field_order) ? (r.field_order as unknown[]).map((x) => String(x ?? "")).filter(Boolean) : [];
        const pf = (r.point_fields && typeof r.point_fields === "object" && !Array.isArray(r.point_fields))
          ? Object.keys(r.point_fields as Record<string, unknown>).filter(Boolean) : [];
        const ops = Array.isArray(r.shot_ops) ? (r.shot_ops as Array<{ f?: unknown; k?: unknown; by?: unknown }>) : [];
        const fromOps = ops
          .filter((o) => o && typeof o.f === "string" && String(o.f) && o.k !== "diag")
          .filter((o) => o.by === undefined || o.by === null || o.by === "human")
          .map((o) => ({ k: "click:" + String(o.f), t: null as null, by: "human" }));
        const names = fromOps.length >= 2 ? fromOps.map((x) => x.k) : (order.length ? order : pf).map((n) => "click:" + n);
        if (names.length >= 2) runs2.push(names.slice(0, 40).map((k) => ({ k, t: null, by: "human" })));
      }
      if (runs2.length) {
        const flows2 = learnSceneFlows(runs2 as never);
        const byScene = new Map<string, SceneFlow>();
        for (const f of (sceneFlows ?? [])) byScene.set(f.scene, { ...f });
        const hasStationTransit = (steps: string[]) =>
          scopeNorm !== "itandi" && scopeNorm !== "reins"
          && (steps || []).some((s) => /駅の設定へ進む|沿線の設定へ戻る|one_station|one_line|route_id/.test(String(s)));
        for (const f of flows2) {
          const cur = byScene.get(f.scene);
          if (!cur) { byScene.set(f.scene, f); continue; }
          cur.runs += f.runs;
          cur.ops += f.ops;
          cur.raw_ops = (cur.raw_ops ?? 0) + (f.raw_ops ?? 0);
          if (!cur.steps.length || (f.scene === "station" && hasStationTransit(f.steps) && (!hasStationTransit(cur.steps) || f.steps.length > cur.steps.length))) {
            cur.steps = f.steps;
          }
        }
        sceneFlows = [...byScene.values()].sort((a, b) => b.ops - a.ops);
      }
    }

    if (!sceneFlows?.length) return {};
    const weak = findWeakScenes(sceneFlows).filter((w) => w.kind === "no_example");
    return {
      scene_flows: sceneFlows,
      scene_missing: weak.length,
      scene_missing_names: weak.map((w) => SCENE_JA[w.scene]).join("・"),
      stopped_scene: stoppedScene,
    };
  } catch (e) {
    console.warn("[learn-bundle-scene-meta] 軽量場面手順を作れません:", e instanceof Error ? e.message : String(e));
    return {};
  }
}

/**
 * @param forceFullAudit true なら営業時間でも auditLearnFoundations を回す（profile の fresh 用）
 */
export async function fetchLearnBundleSceneMeta(
  sb: SupabaseClient,
  scope: string,
  opt: { forceFullAudit?: boolean } = {},
): Promise<LearnBundleSceneMeta> {
  const scopeNorm = scope && scope !== "all" ? scope : "all";
  const faSite = scopeNorm === "itandi" || scopeNorm === "realpro" ? scopeNorm : "all";

  let bundle_reflect: LearnBundleSceneMeta["bundle_reflect"] = null;
  try {
    const { fetchBundleReflectHint } = await import("@/app/lib/bundle-reflect");
    const h = await fetchBundleReflectHint(sb, { scope: scopeNorm });
    bundle_reflect = { read_count: h.read_count, read_at: h.read_at, auto_after: h.auto_after };
  } catch (e) {
    console.warn("[learn-bundle-scene-meta] 反映状態を読めません:", e instanceof Error ? e.message : String(e));
  }

  const daytime = jstHourNow() >= 9 && jstHourNow() < 22;
  const light = daytime && !opt.forceFullAudit;

  let copied = await copySceneFieldsFromPrevBundle(sb, scopeNorm);
  let foundation_audit = light ? (copied.foundation_audit ?? null) : null;

  if (!foundation_audit) {
    try {
      const { auditLearnFoundations, compactFoundationForSupervisor } = await import("@/app/lib/learn-foundation-audit");
      const fa = await auditLearnFoundations(sb, { site: faSite });
      foundation_audit = compactFoundationForSupervisor(fa);
    } catch (e) {
      console.warn("[learn-bundle-scene-meta] 土台点検を読めません:", e instanceof Error ? e.message : String(e));
      if (!foundation_audit) {
        foundation_audit = copied.foundation_audit ?? null;
      }
    }
  }

  // 夜間・forced・前回 scene_flows 欠損・または2時間以上経過時は軽量実測で scene_flows を更新
  const sceneAgeMs = copied.createdAtMs ? Math.max(0, Date.now() - copied.createdAtMs) : Number.POSITIVE_INFINITY;
  let scenePart: Pick<LearnBundleSceneMeta, "scene_flows" | "scene_missing" | "scene_missing_names" | "stopped_scene"> = {};
  if (!light || !copied.scene_flows?.length || sceneAgeMs >= SCENE_REFRESH_MAX_AGE_MS) {
    scenePart = await computeLightSceneFlows(sb, scopeNorm);
  }
  const finalSceneFlows = scenePart.scene_flows?.length ? scenePart : copied;
  // 直近3日に駅の設定→station_id[] が出なかったリアプロ系では、直前束の駅遷移 steps を保って後退を防ぐ
  if (scopeNorm !== "itandi" && scopeNorm !== "reins" && finalSceneFlows.scene_flows?.length && copied.scene_flows?.length) {
    const isTransit = (steps: string[]) => (steps || []).some((s) => /駅の設定へ進む|沿線の設定へ戻る|one_station|one_line|route_id/.test(String(s)));
    const curSt = finalSceneFlows.scene_flows.find((f) => f && f.scene === "station");
    const prevSt = copied.scene_flows.find((f) => f && f.scene === "station");
    if (curSt && prevSt && !isTransit(curSt.steps) && isTransit(prevSt.steps)) {
      curSt.steps = prevSt.steps;
    }
  }

  return {
    bundle_reflect,
    foundation_audit,
    ...(finalSceneFlows.scene_flows?.length
      ? {
          scene_flows: finalSceneFlows.scene_flows,
          scene_missing: finalSceneFlows.scene_missing,
          scene_missing_names: finalSceneFlows.scene_missing_names,
          stopped_scene: finalSceneFlows.stopped_scene ?? null,
        }
      : {}),
  };
}
