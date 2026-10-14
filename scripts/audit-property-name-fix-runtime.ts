// scripts/audit-property-name-fix-runtime.ts — 本番の経路（その場で帳簿を引く loadLedgerFor）の物件名の直しが、全部の帳簿で直した時と同じかを確かめる（読むだけ・LLM なし・$0）
//
// 2026-10-14 物件名の化けの直し（property-name-fix.ts）。sent-image-record・/api/extract-vacancy-date は読んだ名前の語で帳簿を引く（ilike・各1000行まで）。
//   引いた行が足りないと「候補が1つ」を誤って決める恐れがある → 全部の帳簿（build-property-name-ledger.ts と同じ）の結果と比べ、食い違いを数える（0 が目標）
// 実行: npx tsx --env-file=.env.local scripts/audit-property-name-fix-runtime.ts [--n=150]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const N = Number((process.argv.find((a) => a.startsWith("--n=")) ?? "--n=150").split("=")[1]);

async function all<T>(t: string, cols: string, f?: (q: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let i = 0; ; i += 1000) { let q = sb.from(t).select(cols).range(i, i + 999); if (f) q = f(q); const { data, error } = await q; if (error) throw new Error(error.message); out.push(...((data ?? []) as T[])); if (!data || data.length < 1000) break; }
  return out;
}
async function main() {
  const fix = await import("../app/lib/property-name-fix");
  const { loadLedgerFor } = await import("../app/lib/property-name-ledger-server");
  type Src = import("../app/lib/property-name-fix").LedgerSource;
  const rows: Array<{ name: string | null; source: Src }> = [];
  for (const r of await all<{ property_name: string | null }>("property_pickups", "property_name")) rows.push({ name: r.property_name, source: "text" });
  for (const r of await all<{ property_names: string[] | null; line_message_id: string | null }>("aix_usage_logs", "property_names, line_message_id", (q) => q.not("property_names", "is", null))) { if (String(r.line_message_id ?? "").startsWith("bexam")) continue; for (const n of r.property_names ?? []) rows.push({ name: n, source: "staff" }); }
  for (const r of await all<{ property_name: string | null; source: string | null }>("sent_properties", "property_name, source")) rows.push({ name: r.property_name, source: r.source === "vision" ? "read" : "shared" });
  const full = fix.buildLedger(rows);
  const reads = [...new Set(rows.filter((r) => r.source === "read" && r.name).map((r) => r.name!.trim()))];
  // 直る物を先に（食い違いが出やすい）・残りは順に
  const fixedFirst = reads.filter((n) => fix.fixReadPropertyName(n, full, {}).status === "fixed");
  const sample = [...fixedFirst, ...reads.filter((n) => !fixedFirst.includes(n))].slice(0, N);
  let same = 0, diff = 0, ms = 0;
  for (const n of sample) {
    const a = fix.fixReadPropertyName(n, full, {});
    const t0 = Date.now();
    const b = fix.fixReadPropertyName(n, await loadLedgerFor(n), {});
    ms += Date.now() - t0;
    if (a.status === b.status && a.name === b.name) same++;
    else { diff++; console.log(`  ✗ ${n}: 全部 ${a.status} ${a.name} ／ 本番 ${b.status} ${b.name}`); }
  }
  console.log(`\n${sample.length}件（うち全部の帳簿で直る物 ${Math.min(fixedFirst.length, sample.length)}）: 同じ ${same}・食い違い ${diff}・本番の引き 平均 ${Math.round(ms / Math.max(1, sample.length))}ms`);
}
main().catch((e) => { console.error(e); process.exit(1); });
