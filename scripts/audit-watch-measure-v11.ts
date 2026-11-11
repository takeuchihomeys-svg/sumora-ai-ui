// scripts/audit-watch-measure-v11.ts — 見張りの物差しの誤り M1〜M3（LINE_WATCH_MEASURE_V11）の前後で判定が変わる番を全部並べる（直近 N 日・dry・読むだけ・書かない・送らない・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-watch-measure-v11.ts [--days=14]（営業時間 9〜22時は流さない）
import { createClient } from "@supabase/supabase-js";
import { evaluateLineWatchTurns } from "../app/lib/line-watch-eval-server";
import { isTestConversation } from "../app/lib/test-conversations";
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "14") || 14;
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const run = async (on: boolean) => { process.env.LINE_WATCH_MEASURE_V11 = on ? "on" : "off"; process.env.SHADOW_AUTO_GATE = "off"; return evaluateLineWatchTurns(sb, { dry: true, days: DAYS, backlogDays: DAYS, limit: 20000, reevalFinal: true, collect: true }); };
  const a = await run(false), b = await run(true);
  const before = new Map((a.rows ?? []).map((r) => [r.id, r.patch]));
  const agree = (v: unknown) => v === "same" || v === "same_meaning";
  let nA = 0, okA = 0, nB = 0, okB = 0;
  for (const r of b.rows ?? []) {
    if (isTestConversation(r.conversation_id)) continue;
    const p0 = before.get(r.id)!, v0 = p0.verdict, v1 = r.patch.verdict;
    if (v0 && v0 !== "na") { nA++; if (agree(v0)) okA++; }
    if (v1 && v1 !== "na") { nB++; if (agree(v1)) okB++; }
    if (v0 !== v1) console.log(`${r.id} | ${v0}(${(p0.verdict_detail as { reason?: string })?.reason}) → ${v1}(${(r.patch.verdict_detail as { reason?: string })?.reason})`);
  }
  console.log(`一致（na を除く）: off ${okA}/${nA}＝${Math.round((okA / nA) * 1000) / 10}% → on ${okB}/${nB}＝${Math.round((okB / nB) * 1000) / 10}%`);
})();
