// scripts/audit-material-missing-keys.ts — material_missing の自由な名前を決まった鍵（app/lib/material-missing-key.ts）に寄せた結果を読む（読み取りだけ・LLM なし）
// 2026-11-11 作業員1（統括役の A1）。実行: npx tsx --env-file=.env.local scripts/audit-material-missing-keys.ts [--days=14] [--show=<鍵>] [--all]
import { createClient } from "@supabase/supabase-js";
import { materialMissingKey, tallyMaterialKeys, MATERIAL_KEY_JA } from "../app/lib/material-missing-key";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=").slice(1).join("=");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");

async function main() {
  const days = Number(arg("days", "14"));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows: Array<{ label: string; count: number }> = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("brain_unknowns").select("label,count").eq("kind", "material_missing").gte("last_at", since).order("id").range(p * 1000, p * 1000 + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as typeof rows));
    if ((data ?? []).length < 1000) break;
  }
  const total = rows.reduce((a, r) => a + (r.count ?? 1), 0);
  console.log(`直近${days}日 material_missing: 名前 ${rows.length} 種類・${total} 回\n`);
  for (const t of tallyMaterialKeys(rows)) console.log(`${String(t.n).padStart(4)}回 ${String(t.labels).padStart(3)}種 ${t.side.padEnd(9)} ${t.key}（${MATERIAL_KEY_JA[t.key]}）`);
  const show = arg("show");
  const all = process.argv.includes("--all");
  if (show || all) {
    for (const r of rows.sort((a, b) => b.count - a.count)) {
      const k = materialMissingKey(r.label);
      if (all || k === show) console.log(`  ${k.padEnd(24)} ${r.count}\t${r.label}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
