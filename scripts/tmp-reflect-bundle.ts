/**
 * 手元で束を作り直す（本番 fresh=1 は使わない・solid 落ち防止）
 */
import { createClient } from "@supabase/supabase-js";
import { fetchBundleReflectHint } from "../app/lib/bundle-reflect";
import { buildHumanLearnBundle, compactBundle, type MotionRow } from "../app/lib/human-learn-brain";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

async function main() {
  const since = new Date(Date.now() - 3 * 86400_000).toISOString();
  const rows: MotionRow[] = [];
  const SELECT = [
    "created_at", "site", "mode", "ext_version", "ops",
    "moves_n", "move_speed_px_s", "move_curve", "move_ms", "move_dist",
    "points_n", "point_x", "point_y", "point_fields",
    "scrolls_n", "scroll_dy", "kinds", "fields", "field_order", "shot_ops", "shot_learn",
    "shot_taken", "shot_key", "shot_w", "shot_h",
  ].join(", ");
  for (let i = 0; i < 20_000; i += 1000) {
    const { data, error } = await sb
      .from("human_motion_learn")
      .select(SELECT)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(i, i + 999);
    if (error) {
      console.error("読取失敗", error.message);
      process.exitCode = 1;
      return;
    }
    rows.push(...((data ?? []) as unknown as MotionRow[]));
    if (!data || data.length < 1000) break;
  }
  console.log("rows", rows.length);
  const hint0 = await fetchBundleReflectHint(sb, { scope: "all" });
  const all = compactBundle(buildHumanLearnBundle(rows, Date.now(), null, null, { bundle_reflect: hint0 }));
  const learned = (all as { shots?: { learned?: Record<string, unknown[]> } }).shots?.learned || {};
  let solid = 0, allPos = 0;
  for (const list of Object.values(learned)) {
    for (const f of (Array.isArray(list) ? list : []) as Array<{ x?: number; n?: number }>) {
      if (typeof f?.x === "number") {
        allPos++;
        if ((Number(f.n) || 0) >= 3) solid++;
      }
    }
  }
  console.log("before insert: screen_all", allPos, "solid", solid);
  const { inheritLinkFoundations } = await import("../app/lib/learn-bundle-preserve");
  const b = all as unknown as Record<string, unknown>;
  const pr = await inheritLinkFoundations(sb, b, "all", { lookback: 20, minSolid: 30 });
  if (!pr.safe_to_write) {
    console.error("消す書き込み拒否", pr.why);
    process.exitCode = 1;
    return;
  }
  const inserts: Array<Record<string, unknown>> = [{
    scope: "all",
    source_rows: all.source.rows,
    source_from: all.source.from,
    source_to: all.source.to,
    bundle: b,
    lines: all.lines,
  }];
  const { prepareBundleForWrite } = await import("../app/lib/bundle-write-prepare");
  prepareBundleForWrite(b, "all");
  const { error: werr } = await sb.from("human_learn_profile").insert(inserts);
  if (werr) {
    console.error("書込失敗", werr.message);
    process.exitCode = 1;
    return;
  }
  console.log("reflect ok solid=", solid, "all=", allPos, "rows=", all.source.rows);
}
main();
