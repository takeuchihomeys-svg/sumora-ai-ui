/**
 * 最新の記録を「写真の有無に関係なく」見る（2026-11-14）
 *   竹内さん「今新しく通常で一連の流れをおこなった。データベースからできていない部分学習するようにする」
 * 実行: npx tsx --env-file=.env.local scripts/audit-latest-rows.ts
 */
import { supabase as sb } from "../app/lib/supabase-server";

void (async () => {
  const { data, error } = await sb
    .from("human_motion_learn")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(8);
  if (error) { console.log("読めません:", error.message); return; }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  console.log(`${rows.length}行\n`);
  for (const r of rows) {
    const ops = Array.isArray(r.shot_ops) ? (r.shot_ops as unknown[]) : [];
    const pf = (r.point_fields && typeof r.point_fields === "object") ? Object.keys(r.point_fields as object) : [];
    console.log("─".repeat(70));
    console.log(`時刻: ${String(r.created_at)}`);
    console.log(`  版: ${String(r.ext_version)} / mode: ${String(r.mode)} / site: ${String(r.site)}`);
    console.log(`  ops(数): ${String(r.ops)} / points_n: ${String(r.points_n)} / moves_n: ${String(r.moves_n)}`);
    console.log(`  shot_ops: ${ops.length}件 / point_fields: ${pf.length}件 / field_order: ${Array.isArray(r.field_order) ? (r.field_order as unknown[]).length : 0}件`);
    console.log(`  shot_taken: ${String(r.shot_taken)} / shot_key: ${String(r.shot_key)}`);
    console.log(`  gap_ms: ${String(r.gap_ms)} / shot_learn: ${r.shot_learn ? "あり" : "無し"}`);
    if (pf.length) console.log(`  押した欄: ${pf.slice(0, 10).join(", ")}${pf.length > 10 ? " …" : ""}`);
    if (ops.length) {
      const names = (ops as Array<Record<string, unknown>>).map((o) => `${String(o.k ?? "")}:${String(o.f ?? "")}`);
      console.log(`  操作: ${names.slice(0, 12).join(" → ")}`);
    }
  }
})();
