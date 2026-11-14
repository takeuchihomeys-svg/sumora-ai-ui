/**
 * 直近の brain_aix 回の steps を全部見る（どの段で何が起きたか）2026-11-14
 * 実行: npx tsx --env-file=.env.local scripts/audit-run-steps.ts
 */
import { supabase as sb } from "../app/lib/supabase-server";

void (async () => {
  const { data, error } = await sb
    .from("search_audits")
    .select("run_id, created_at, mode, status, steps, error, intended, filled, checks")
    .eq("site", "realpro")
    .gte("created_at", new Date(Date.now() - 8 * 3600_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(4);
  if (error) { console.log("読めません:", error.message); return; }
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const steps = r.steps as Array<Record<string, unknown>> | null;
    const kinds = new Set((steps ?? []).map((s) => String(s.k ?? "")));
    console.log("─".repeat(75));
    console.log(`${String(r.created_at)} / ${String(r.mode)} / ${String(r.status)} / steps=${(steps ?? []).length}`);
    if (!Array.isArray(steps)) { console.log("  steps 無し"); continue; }
    // 面白い所だけ: 地域・検索・エラー・段の名前
    for (const s of steps) {
      const k = String(s.k ?? "");
      const p = s.p === undefined || s.p === null ? "" : String(s.p);
      if (/area|ward|town|modal|search|station|gate|learn|fail|error|pref|city|確定|retry/i.test(k) || /区|検索|確定|町/.test(p)) {
        console.log(`  ${String(s.d ?? "").padStart(10)}  ${k}${p ? ": " + p.slice(0, 150) : ""}`);
      }
    }
    if (r.error) console.log("  error:", String(r.error).slice(0, 200));
    const fl = r.filled as Record<string, unknown> | null;
    if (fl) console.log("  filled:", JSON.stringify(fl).slice(0, 300));
    void kinds;
  }
})();
