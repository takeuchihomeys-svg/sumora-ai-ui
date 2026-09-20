// scripts/audit-signal-accuracy.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-signal-accuracy.ts
//
// 2026-09-20 竹内「ここなら申込になりそうなお客さんだと分析して、そこから申込の流れにいく形はどうか」:
//   brain_decision_logs.digest（JSONB）の sig＝purchase_signal_level の**履歴**で、
//   「peak/strong が出た会話が、その後 実際に申込に到達したか」を測る。
//   ※ digest は JSONB。String() すると [object Object] になる（最初これで壊れていると誤読した）。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const APPLIED = ["applying", "application_push", "screening", "closed_won"];

async function main() {
  const logs: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("brain_decision_logs")
      .select("conversation_id, created_at, digest, suggested_action, conversation_status, actual_aix_type, matched")
      .order("created_at", { ascending: true }).range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    logs.push(...(data as Array<Record<string, unknown>>));
    if (data.length < 1000) break;
  }
  const sigOf = (l: Record<string, unknown>) => {
    const d = l.digest as Record<string, unknown> | null;
    const s = d?.sig;
    return typeof s === "string" && s.trim() ? s.trim() : null;
  };
  const withSig = logs.filter((l) => sigOf(l));
  console.log(`=== brain_decision_logs ${logs.length}件 / 購買シグナルが残っている ${withSig.length}件 ===`);
  console.log(`  期間: ${String(logs[0]?.created_at ?? "").slice(0, 10)} 〜 ${String(logs[logs.length - 1]?.created_at ?? "").slice(0, 10)}\n`);

  const dist: Record<string, number> = {};
  for (const l of withSig) { const s = sigOf(l)!; dist[s] = (dist[s] ?? 0) + 1; }
  console.log(`--- 履歴に出たシグナルの分布 ---`);
  Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(10)} ${String(v).padStart(4)}回`));

  // 会話ごとに「一度でも出た最高のシグナル」→ 今の状態
  const rank: Record<string, number> = { none: 0, soft: 1, strong: 2, peak: 3 };
  const best = new Map<string, string>();
  for (const l of withSig) {
    const id = String(l.conversation_id); const s = sigOf(l)!;
    const cur = best.get(id);
    if (!cur || (rank[s] ?? -1) > (rank[cur] ?? -1)) best.set(id, s);
  }
  const ids = [...best.keys()];
  const statuses = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, status").in("id", ids.slice(i, i + 200));
    for (const c of data ?? []) statuses.set(String(c.id), String(c.status ?? ""));
  }
  console.log(`\n--- 会話ごとの「一度でも出た最高のシグナル」× 申込以降に到達したか（${ids.length}会話）---`);
  console.log(`  ${"最高シグナル".padEnd(12)} ${"会話数".padStart(6)} ${"申込以降".padStart(8)} ${"率".padStart(6)}`);
  for (const lv of ["peak", "strong", "soft", "none"]) {
    const rs = ids.filter((id) => best.get(id) === lv);
    if (!rs.length) continue;
    const ap = rs.filter((id) => APPLIED.includes(statuses.get(id) ?? "")).length;
    console.log(`  ${lv.padEnd(12)} ${String(rs.length).padStart(6)} ${String(ap).padStart(8)} ${`${((100 * ap) / rs.length).toFixed(0)}%`.padStart(6)}`);
  }
  const allAp = ids.filter((id) => APPLIED.includes(statuses.get(id) ?? "")).length;
  console.log(`  ${"（全体）".padEnd(12)} ${String(ids.length).padStart(6)} ${String(allAp).padStart(8)} ${`${((100 * allAp) / Math.max(ids.length, 1)).toFixed(0)}%`.padStart(6)}`);

  // peak が出てから申込まで何日か
  const gaps: number[] = [];
  for (const id of ids) {
    if (best.get(id) !== "peak") continue;
    if (!APPLIED.includes(statuses.get(id) ?? "")) continue;
    const first = withSig.find((l) => String(l.conversation_id) === id && sigOf(l) === "peak");
    if (!first) continue;
    const { data: ap } = await sb.from("aix_usage_logs")
      .select("created_at").eq("conversation_id", id).in("aix_type", ["application_push", "application_confirm"])
      .not("sent_at", "is", null).order("created_at", { ascending: true }).limit(1);
    if (!ap?.length) continue;
    gaps.push((Date.parse(String(ap[0].created_at)) - Date.parse(String(first.created_at))) / 86400_000);
  }
  if (gaps.length) {
    const g = gaps.sort((a, b) => a - b);
    console.log(`\n--- peak が出てから申込 AIX までの日数（${g.length}件）---`);
    console.log(`  最短 ${g[0].toFixed(1)}日 / 中央値 ${g[Math.floor(g.length / 2)].toFixed(1)}日 / 最長 ${g[g.length - 1].toFixed(1)}日`);
    console.log(`  peak より**後**に申込: ${g.filter((x) => x >= 0).length}件 / **前**（既に申込済み）: ${g.filter((x) => x < 0).length}件`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
