/**
 * 連携土台の復元: solid=96 を最新へ戻し、駅遷移＋foundation を載せる
 * npx tsx --env-file=.env.local scripts/tmp-restore-link-bundle.ts
 */
import { createClient } from "@supabase/supabase-js";
import { auditLearnFoundations, compactFoundationForSupervisor } from "../app/lib/learn-foundation-audit";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

const STATION_TRANSIT_STEPS = [
  "click:駅の設定へ進む",
  "click:one_station",
  "click:沿線の設定へ戻る",
  "change:transportation_id",
  "change:required_time",
];

function solidOf(bundle: Record<string, unknown>) {
  const learned = (bundle.shots as { learned?: Record<string, Array<{ x?: number; n?: number }>> } | undefined)?.learned;
  let solid = 0, xy = 0;
  if (learned) {
    for (const list of Object.values(learned)) {
      for (const f of Array.isArray(list) ? list : []) {
        if (typeof f?.x === "number") {
          xy++;
          if ((Number(f.n) || 0) >= 3) solid++;
        }
      }
    }
  }
  return { solid, xy };
}

async function main() {
  const { data: rows } = await sb
    .from("human_learn_profile")
    .select("id,created_at,scope,bundle,source_rows,source_from,source_to,lines")
    .eq("scope", "all")
    .order("created_at", { ascending: false })
    .limit(30);
  let donor: (typeof rows extends (infer T)[] | null ? T : never) | null = null;
  for (const r of rows || []) {
    const s = solidOf((r.bundle || {}) as Record<string, unknown>);
    if (s.solid >= 30) {
      donor = r;
      break;
    }
  }
  if (!donor) {
    console.error("solid≥30 の束が無い");
    process.exit(1);
  }
  console.log("donor", donor.created_at, solidOf(donor.bundle as Record<string, unknown>));

  const bundle = JSON.parse(JSON.stringify(donor.bundle)) as Record<string, unknown>;
  // 駅遷移を必ず載せる（録画正本SEQ）
  const flows = Array.isArray(bundle.scene_flows)
    ? [...(bundle.scene_flows as Array<Record<string, unknown>>)]
    : [];
  const ix = flows.findIndex((x) => x.scene === "station");
  if (ix >= 0) {
    flows[ix] = { ...flows[ix], steps: STATION_TRANSIT_STEPS };
  } else {
    flows.push({ scene: "station", steps: STATION_TRANSIT_STEPS, runs: 1, ops: STATION_TRANSIT_STEPS.length });
  }
  bundle.scene_flows = flows;
  bundle.link_restored_at = new Date().toISOString();
  bundle.link_restore_note = "統括Pro: solid引き継ぎ＋駅遷移SEQ＋foundation再点検";

  const fa = compactFoundationForSupervisor(await auditLearnFoundations(sb, { daysOps: 2, daysAudit: 3 }));
  // foundation は「最新束」を見るので、先に solid 復元した束を書いてから再点検する想定。
  // ここでは donor の fa があれば残し、無ければいまの監査圧縮を載せる。
  if (!bundle.foundation_audit) bundle.foundation_audit = fa;

  // supervisor 根拠に連携メモを足せるよう generated_at を更新
  bundle.generated_at = new Date().toISOString();

  for (const scope of ["all", "realpro"] as const) {
    const { data: ins, error } = await sb
      .from("human_learn_profile")
      .insert({
        scope,
        source_rows: donor.source_rows,
        source_from: donor.source_from,
        source_to: donor.source_to,
        bundle,
        lines: donor.lines,
        read_count: 0,
        read_at: null,
      })
      .select("created_at,id")
      .single();
    if (error) {
      console.error(scope, error.message);
      process.exitCode = 1;
      return;
    }
    console.log("restored", scope, ins?.created_at, String(ins?.id || "").slice(0, 8));
  }

  const { data: verify } = await sb
    .from("human_learn_profile")
    .select("created_at,bundle,read_count")
    .eq("scope", "all")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const vb = (verify?.bundle || {}) as Record<string, unknown>;
  const vs = solidOf(vb);
  const st = (Array.isArray(vb.scene_flows) ? (vb.scene_flows as Array<{ scene?: string; steps?: string[] }>) : [])
    .find((x) => x.scene === "station");
  console.log("verify solid", vs.solid, "xy", vs.xy, "fa", !!vb.foundation_audit, "station", (st?.steps || []).join("→"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
