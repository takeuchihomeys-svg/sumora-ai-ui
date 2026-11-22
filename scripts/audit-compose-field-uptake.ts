// scripts/audit-compose-field-uptake.ts — 統括が渡した欄ごとに、書き手に届いた割合・下書きに入った割合を本番の番で数える（読むだけ・LLM なし・費用0・軽い読み）
//
// 2026-11-21 作業員L（台帳 #466）。読む物: line_watch_turns（直近 --hours 時間・最大 --max 行）の materials.reply.compose_plan.carried と draft_last。
//   carried は WATCH_COMPOSE_PLAN=on の番に、generate-reply が書き手の注記を作った時に残す（compose-sentence-plan.handoffCarried・値の語だけ・文は写さない）。
//   carried の無い古い行（11/21 より前・WATCH_COMPOSE_PLAN が off の時）は数えない。
// 実行: npx tsx --env-file=.env.local scripts/audit-compose-field-uptake.ts [--hours=24] [--max=200]
import { createClient } from "@supabase/supabase-js";
import { tallyFieldUptake, formatFieldUptake, type TurnRec } from "./lib/field-uptake";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const hours = Number(arg("hours", "24")) || 24, max = Math.min(Number(arg("max", "200")) || 200, 500);
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const since = new Date(Date.now() - hours * 36e5).toISOString();
  const { data, error } = await sb.from("line_watch_turns").select("materials, draft_last").gte("created_at", since).order("created_at", { ascending: false }).limit(max);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ materials: { reply?: { compose_plan?: { carried?: TurnRec["carried"] } } } | null; draft_last: string | null }>;
  const turns: TurnRec[] = rows.map((r) => ({ carried: r.materials?.reply?.compose_plan?.carried ?? null, draft: r.draft_last })).filter((t) => t.carried?.length);
  console.log(`line_watch_turns ${rows.length}行のうち carried のある番 ${turns.length}（${hours}時間）`);
  if (!turns.length) { console.log("carried の記録がまだ無い（WATCH_COMPOSE_PLAN=on と、この記録を足したコミットの後の番から数えられる）"); return; }
  console.log(formatFieldUptake(tallyFieldUptake(turns), turns.length));
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
