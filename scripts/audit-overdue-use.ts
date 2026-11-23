// scripts/audit-overdue-use.ts — 統括の材料に渡した期日超えの約束が使われたか（判断の記録の digest の op を数える・読むだけ・LLM なし）
// 2026-11-23 作業員L（台帳 #659・竹内さん #662 の「使う」の段）。作業員A の統括の受け持ち表の「使う・反映する」の列に渡す数:
//   conductor_use:overdue_promises:given（渡した番）・conductor_use:overdue_promises:use_rate（その番の一手が約束を果たす一手だった %）
// 実行: npx tsx --env-file=.env.local scripts/audit-overdue-use.ts [--days=7] [--metrics=<出力>]（判断の記録を日付で絞って digest の op だけ読む）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { overdueUseSummary } from "../app/lib/conductor-overdue-promises";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const days = Number(arg("days", "7")) || 7;
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const ops: unknown[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await sb.from("brain_decision_logs").select("digest->op").gte("created_at", new Date(Date.now() - days * 864e5).toISOString()).not("digest->op", "is", null).range(from, from + 999);
    if (error) throw new Error(error.message);
    ops.push(...((data ?? []) as Array<{ op: unknown }>).map((r) => r.op));
    if ((data ?? []).length < 1000) break;
  }
  const s = overdueUseSummary(ops);
  console.log(`統括の材料の期日超えの約束（${days}日）: 渡した番 ${s.given}・その番の一手が約束を果たす一手 ${s.fulfil}（${s.useRate ?? "—"}%）`);
  for (const [k, c] of Object.entries(s.byKind)) console.log(`  ${k}: 渡した ${c.given}・果たす一手 ${c.fulfil}`);
  if (!s.given) console.log("（op の記録がまだ無い＝この版が本番に入った後の番から残る）");
  if (arg("metrics", "")) writeFileSync(arg("metrics", ""), JSON.stringify([
    { metric: "conductor_use:overdue_promises:given", scope: "all", value: s.given, n: s.given, detail: { days } },
    { metric: "conductor_use:overdue_promises:use_rate", scope: "all", value: s.useRate, n: s.given, detail: { fulfil: s.fulfil, by_kind: s.byKind } },
  ], null, 1));
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
