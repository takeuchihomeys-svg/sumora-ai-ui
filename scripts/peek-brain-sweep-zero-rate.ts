// brain-sweep（5分毎）のうち「対象0件」だった回の割合を cron_run_logs で数える（読み取りのみ）
// 目的: 温め（brain-warm）は対象0件の回でしか走らない設計なので、営業時間内に 0件でない回がどれだけあるか（＝温めの窓を取り逃す回）を事実で見る
// 実行: npx tsx --env-file=.env.local scripts/peek-brain-sweep-zero-rate.ts [--days=2]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const days = Number(arg("days") ?? "2");
const jstHour = (s: string) => new Date(new Date(s).getTime() + 9 * 3600_000).getUTCHours();

async function main() {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data, error } = await sb.from("cron_run_logs").select("started_at, ok, result_json").eq("cron_name", "brain-sweep").gte("started_at", since).order("started_at", { ascending: true }).limit(2000);
  if (error) { console.log(error.message); process.exit(1); }
  const rows = (data ?? []) as Array<{ started_at: string; ok: boolean | null; result_json: Record<string, unknown> | null }>;
  let zero = 0, nonZero = 0, nonZeroNoSuccess = 0;
  const byHour = new Map<number, { zero: number; non: number }>();
  for (const r of rows) {
    const h = jstHour(r.started_at);
    if (h < 9 || h >= 22) continue;
    const rj = r.result_json ?? {};
    const total = Number(rj.total ?? 0);
    const processed = Number(rj.processed ?? 0);
    const b = byHour.get(h) ?? { zero: 0, non: 0 };
    if (total === 0) { zero++; b.zero++; } else { nonZero++; b.non++; if (processed === 0) nonZeroNoSuccess++; }
    byHour.set(h, b);
  }
  console.log(`=== brain-sweep ${days}日分・営業時間 9〜22 JST: 0件 ${zero}回 / 対象あり ${nonZero}回（うち成功0 ${nonZeroNoSuccess}回） ===`);
  for (const [h, b] of [...byHour.entries()].sort((a, c) => a[0] - c[0])) console.log(`  ${String(h).padStart(2, "0")}時: 0件 ${b.zero} / 対象あり ${b.non}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
