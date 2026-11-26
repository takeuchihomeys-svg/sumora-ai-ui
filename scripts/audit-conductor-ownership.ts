// scripts/audit-conductor-ownership.ts — 統括の受け持ち表を数える（台帳 #662・読むだけ・LLM なし・DB は --write の時だけ quality_daily に書く）
// 2026-11-26 作業員A: 部品ごとに ①持つ（digest.mk）②使う（mpr の先頭・USED_MARKERS）③反映する（目当ての AIX が2時間の内に出た）
//   JST 9〜22時は --days=1 に絞る（--force で外す）。本文は読まない（digest と AIX の種類・時刻だけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-conductor-ownership.ts [--days=7] [--write]
import { createClient } from "@supabase/supabase-js";
import { ownershipTable, ownershipLines, type OwnDecision, type OwnAix } from "../app/lib/conductor-ownership";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const h = new Date(Date.now() + 9 * 3_600_000).getUTCHours();
  const day = h >= 9 && h < 22 && !process.argv.includes("--force");
  const days = day ? 1 : Number(arg("days", "7"));
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const ds: OwnDecision[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await sb.from("brain_decision_logs").select("conversation_id,created_at,digest").gte("created_at", since).order("created_at").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ conversation_id: string; created_at: string; digest: Record<string, unknown> | null }>) ds.push({ conv: r.conversation_id, at: r.created_at, digest: r.digest ?? {} });
    if ((data ?? []).length < 1000) break;
  }
  const ax: OwnAix[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await sb.from("aix_usage_logs").select("conversation_id,created_at,aix_type").gte("created_at", since).order("created_at").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ conversation_id: string; created_at: string; aix_type: string | null }>) ax.push({ conv: r.conversation_id, at: r.created_at, type: String(r.aix_type ?? "") });
    if ((data ?? []).length < 1000) break;
  }
  const cs = ownershipTable(ds, ax);
  const marked = ds.filter((d) => typeof d.digest.mtk === "string").length;
  console.log(ownershipLines(cs, ds.length, marked).join("\n"));
  for (const c of cs) if (c.gaps.length) console.log(`  欠け ${c.name}: ${c.gaps.join("／")}`);
  if (process.argv.includes("--write")) {
    const jd = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
    const qd = cs.flatMap((c) => [
      { day: jd, metric: `own:${c.key}:hold`, scope: "all", value: c.hold, n: marked, source: "scripts/audit-conductor-ownership.ts（作業員A・#662）" },
      { day: jd, metric: `own:${c.key}:used`, scope: "all", value: pct(c.usedOk, c.usedOf), n: c.usedOf, detail: { head: c.head, gaps: c.gaps }, source: "scripts/audit-conductor-ownership.ts（作業員A・#662）" },
      { day: jd, metric: `own:${c.key}:reflect`, scope: "all", value: pct(c.reflectOk, c.reflectOf), n: c.reflectOf, source: "scripts/audit-conductor-ownership.ts（作業員A・#662）" },
    ]);
    const { error } = await sb.from("quality_daily").upsert(qd, { onConflict: "day,metric,scope" });
    if (error) throw new Error(error.message);
    console.log(`書いた: quality_daily ${qd.length}行（${jd}）`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
