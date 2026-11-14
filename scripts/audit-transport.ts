/**
 * 移動手段（transportation_id）が実際に選ばれたか・値は何か（2026-11-14）
 *   竹内さん「駅からの移動手段のところ 徒歩をプルダウンで選択するところできていなかった」
 * 実行: npx tsx --env-file=.env.local scripts/audit-transport.ts
 */
import { supabase as sb } from "../app/lib/supabase-server";

void (async () => {
  const { data, error } = await sb
    .from("search_audits")
    .select("created_at, mode, status, steps, filled, intended, checks")
    .eq("site", "realpro")
    .order("created_at", { ascending: false })
    .limit(8);
  if (error) { console.log("読めません:", error.message); return; }
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const steps = (r.steps ?? []) as Array<Record<string, unknown>>;
    const filled = r.filled as Record<string, unknown> | null;
    const intended = r.intended as Record<string, unknown> | null;
    const ops = (filled && Array.isArray(filled.ops)) ? (filled.ops as Array<Record<string, unknown>>) : [];
    const trans = ops.filter((o) => String(o.k ?? "").indexOf("transportation_id") >= 0);
    const walk = ops.filter((o) => String(o.k ?? "").indexOf("required_time") >= 0);
    console.log("─".repeat(70));
    console.log(`${String(r.created_at)} / ${String(r.mode)} / ${String(r.status)}`);
    console.log(`  intended.walk_minutes: ${String((intended ?? {}).walk_minutes)} / area_mode: ${String((intended ?? {}).area_mode)}`);
    console.log(`  ops の transportation_id: ${trans.length}件 ${trans.length ? JSON.stringify(trans).slice(0, 200) : "（押していない）"}`);
    console.log(`  ops の required_time: ${walk.length}件 ${walk.length ? JSON.stringify(walk).slice(0, 160) : "（入れていない）"}`);
    if (filled) {
      const form = (filled.form && typeof filled.form === "object") ? filled.form as Record<string, unknown> : null;
      if (form) {
        const keys = Object.keys(form).filter((k) => /transport|required|walk/i.test(k));
        for (const k of keys) console.log(`  filled.form.${k}: ${JSON.stringify(form[k])}`);
      }
    }
    const g = steps.filter((s) => /gate|search|transport|learn/i.test(String(s.k ?? "")));
    for (const s of g.slice(-5)) console.log(`    step ${String(s.k)}: ${String(s.p ?? "").slice(0, 150)}`);
  }
})();
