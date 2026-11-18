/**
 * 束を作るときの sceneMeta（土台点検・反映状態・場面手順）を揃える。
 *
 * human-learn-profile の buildNow は search_audits 等で場面手順まで作るが、
 * cron / shot-learn の軽い再生成では最低限 foundation_audit + bundle_reflect を渡し、
 * 営業時間（JST 9〜22）は重い audit を避けて直前束から場面メタを継ぐ。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { jstHourNow } from "@/app/lib/batch-daytime-guard";
import type { FoundationForSupervisor } from "@/app/lib/learn-foundation-audit";
import type { SceneFlow } from "@/app/lib/learn-flow-steps";

export type LearnBundleSceneMeta = {
  scene_flows?: SceneFlow[] | null;
  scene_missing?: number;
  scene_missing_names?: string;
  stopped_scene?: string | null;
  bundle_reflect?: { read_count?: number; read_at?: string | null; auto_after?: boolean } | null;
  foundation_audit?: FoundationForSupervisor | null;
};

async function copySceneFieldsFromPrevBundle(
  sb: SupabaseClient,
  scope: string,
): Promise<Pick<LearnBundleSceneMeta, "scene_flows" | "scene_missing" | "scene_missing_names" | "stopped_scene" | "foundation_audit">> {
  const out: Pick<LearnBundleSceneMeta, "scene_flows" | "scene_missing" | "scene_missing_names" | "stopped_scene" | "foundation_audit"> = {};
  try {
    const { data: prev } = await sb
      .from("human_learn_profile")
      .select("bundle")
      .eq("scope", scope)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
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

  let copied = light ? await copySceneFieldsFromPrevBundle(sb, scopeNorm) : {};
  let foundation_audit = copied.foundation_audit ?? null;

  if (!foundation_audit) {
    try {
      const { auditLearnFoundations, compactFoundationForSupervisor } = await import("@/app/lib/learn-foundation-audit");
      const fa = await auditLearnFoundations(sb, { site: faSite });
      foundation_audit = compactFoundationForSupervisor(fa);
    } catch (e) {
      console.warn("[learn-bundle-scene-meta] 土台点検を読めません:", e instanceof Error ? e.message : String(e));
      if (!foundation_audit) {
        const retry = await copySceneFieldsFromPrevBundle(sb, scopeNorm);
        foundation_audit = retry.foundation_audit ?? null;
        if (!copied.scene_flows?.length && retry.scene_flows?.length) copied = { ...copied, ...retry };
      }
    }
  }

  return {
    bundle_reflect,
    foundation_audit,
    ...(copied.scene_flows?.length
      ? {
          scene_flows: copied.scene_flows,
          scene_missing: copied.scene_missing,
          scene_missing_names: copied.scene_missing_names,
          stopped_scene: copied.stopped_scene ?? null,
        }
      : {}),
  };
}