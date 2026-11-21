// scripts/check-count-verified.ts — 穴の型④「数え方の誤りで低く見える」の点検と、照らした日の記録（読むだけ＋記録・LLM なし・費用0・作業員N2・2026-11-21・台帳 #505）
//
// 統括役 11/21 の5つの型の④。決めは scripts/lib/count-verified.ts。
//   点検: 直近14日に quality_daily を書いた (metric, source) と、土台の表（metric のある行の物差しの台本）から数えの単位を作り、
//         quality_daily の metric='count_verified:<単位>' の記録（照らした日）と台本の最後のコミットの日を比べる。軽い読み（quality_daily の metric・source だけ）
//   記録: 実物1件で照らしたら --record で1行（会話は id の頭8字だけ・お客様の本文は書かない）
//     npx tsx --env-file=.env.local scripts/check-count-verified.ts --record --unit=scripts/check-windows.ts --ok --metric=core:window_miss:timeline.customer --conv=2cb0feb7 --note="..." [--by=作業員N2]
//     ズレがあった時は --ok の代わりに --off（数え方を直すまで穴のまま）
// 実行: npx tsx --env-file=.env.local scripts/check-count-verified.ts [--json] [--write]
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unitsOf, unverifiedOf, VERIFY_METRIC, verifyMetricOf, UNVERIFIED_JA, countGapsForLedger, type Unverified } from "./lib/count-verified";
import { FOUNDATION_N } from "./lib/foundation-table";
import { otherTables, inOriginMain } from "./check-foundation";
import { addFoundGaps } from "./lib/found-gap-ledger";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const jstDay = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);

/** 台本の最後のコミットの日（手元の git・無ければ origin/main・分からなければ null） */
export function lastChangeOf(script: string): string | null {
  for (const ref of ["HEAD", "origin/main"]) {
    try { const out = execFileSync("git", ["log", "-1", "--format=%cs", ref, "--", script], { encoding: "utf8", timeout: 15_000 }).trim(); if (out) return out; } catch { /* 次へ */ }
  }
  return null;
}

export async function checkCountVerified(sb: SupabaseClient, nowMs = Date.now()): Promise<{ units: number; unverified: Unverified[] }> {
  const since = jstDay(nowMs - 14 * 86_400_000);
  const rows: Array<{ metric: string; source: string | null }> = [];
  for (let i = 0; i < 20_000; i += 1000) {
    const { data, error } = await sb.from("quality_daily").select("metric, source").gte("day", since).not("metric", "like", `${VERIFY_METRIC}:%`).range(i, i + 999);
    if (error) throw new Error(`quality_daily: ${error.message}`);
    rows.push(...((data ?? []) as typeof rows));
    if ((data ?? []).length < 1000) break;
  }
  const uniq = [...new Map(rows.map((r) => [`${r.metric}|${r.source}`, r])).values()];
  const extra = [...FOUNDATION_N, ...otherTables()].filter((r) => r.metric).flatMap((r) => r.measures.filter((m) => existsSync(m) || inOriginMain(m)).map((m) => ({ script: m, owner: r.owner, metric: r.metric })));
  const units = unitsOf(uniq, extra);
  const { data: vs0, error } = await sb.from("quality_daily").select("metric, day, value").like("metric", `${VERIFY_METRIC}:%`).limit(5000);
  const vs = ((vs0 ?? []) as Array<{ metric: string; day: string; value: number | null }>).map((v) => ({ scope: v.metric.slice(VERIFY_METRIC.length + 1), day: v.day, value: v.value }));
  if (error) throw new Error(`quality_daily(count_verified): ${error.message}`);
  const cache = new Map<string, string | null>();
  const lc = (s: string) => { if (!cache.has(s)) cache.set(s, lastChangeOf(s)); return cache.get(s) ?? null; };
  return { units: units.length, unverified: unverifiedOf(units, vs, lc, jstDay(nowMs)) };
}

if (process.argv[1]?.endsWith("check-count-verified.ts")) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  if (process.argv.includes("--record")) {
    const unit = arg("unit"), ok = process.argv.includes("--ok"), off = process.argv.includes("--off");
    if (!unit || ok === off) throw new Error("--record には --unit= と --ok か --off のどちらか1つが要る");
    const conv = arg("conv").slice(0, 8); // お客様の会話は頭8字だけ
    const row = { day: jstDay(Date.now()), metric: verifyMetricOf(unit), scope: "all", value: ok ? 1 : 0, n: Number(arg("n", "1")) || 1, source: "scripts/check-count-verified.ts --record", detail: { metric: arg("metric") || null, conv: conv || null, note: arg("note").slice(0, 300) || null, by: arg("by") || null } };
    const { error } = await sb.from("quality_daily").upsert(row, { onConflict: "day,metric,scope" });
    if (error) throw new Error(error.message);
    console.log(`記録した: ${unit}｜${ok ? "合った" : "ズレ"}｜${row.day}`);
    return;
  }
  const r = await checkCountVerified(sb);
  if (process.argv.includes("--json")) { console.log(JSON.stringify(r)); return; }
  console.log(`数え方を実物で照らしていない（数えの単位 ${r.units}・穴 ${r.unverified.length}）`);
  for (const u of r.unverified) console.log(`- ${UNVERIFIED_JA[u.kind]}｜${u.key}｜${u.owner}｜照らした日 ${u.lastVerified ?? "—"}・台本の最後の変更 ${u.lastChange ?? "—"}｜数 ${u.metrics.slice(0, 4).join("・")}${u.metrics.length > 4 ? ` ほか${u.metrics.length - 4}` : ""}`);
  if (process.argv.includes("--write")) {
    const added = await addFoundGaps(sb, countGapsForLedger(r.unverified), "check-count-verified");
    console.log(`台帳に足した ${added.length}行${added.length ? `（#${added.join("・#")}）` : ""}`);
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
