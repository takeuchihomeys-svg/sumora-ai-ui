// scripts/audit-watch-aix-mapping.ts — 見張りの採点 v8「本来の AIX」の前後（直近 N 日・DB は読むだけ＝evaluateLineWatchTurns の dry・書かない・送らない・LLM なし）
//   前＝LINE_WATCH_AIX_MAPPING=off（v7 と同じ判定）／後＝既定 on。保存済みの判定（DB の verdict）も並べる。
// 実行: npx tsx --env-file=.env.local scripts/audit-watch-aix-mapping.ts [--days=14]
import { createClient } from "@supabase/supabase-js";
import { evaluateLineWatchTurns, type EvalResult } from "../app/lib/line-watch-eval-server";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "14")) || 14;
const KEYS = ["same", "same_meaning", "partial", "different"] as const;
const line = (label: string, v: Record<string, number>) => {
  const n = KEYS.reduce((a, k) => a + (v[k] ?? 0), 0);
  return `${label}: 比べた ${n}番 ・ ${KEYS.map((k) => `${k} ${v[k] ?? 0}（${n ? (((v[k] ?? 0) / n) * 100).toFixed(1) : "-"}%）`).join(" ・ ")} ・ na ${v.na ?? 0}`;
};

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const run = async (mapping: boolean): Promise<EvalResult> => {
    process.env.LINE_WATCH_AIX_MAPPING = mapping ? "on" : "off";
    return evaluateLineWatchTurns(sb, { dry: true, days: DAYS, backlogDays: DAYS, limit: 20_000 });
  };
  const before = await run(false);
  const after = await run(true);
  // 保存済み（毎晩の cron が書いた判定・版はまちまち）
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const stored: Record<string, number> = {};
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("verdict").gte("customer_turn_at", since).order("id").range(f, f + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ verdict: string | null }>) if (r.verdict) stored[r.verdict] = (stored[r.verdict] ?? 0) + 1;
    if (!data || data.length < 1000) break;
  }
  console.log(`# 見張りの採点 直近 ${DAYS}日（読んだ番 ${after.read}・判定 ${after.judged}・保留 ${after.pending}）`);
  console.log(line("保存済み（DB）", stored));
  console.log(line("前（v7 と同じ・当てはめ off）", before.verdicts));
  console.log(line("後（v8・当てはめ on）", after.verdicts));
  const agree = (v: Record<string, number>) => { const n = KEYS.reduce((a, k) => a + (v[k] ?? 0), 0); return n ? (((v.same ?? 0) + (v.same_meaning ?? 0)) / n * 100).toFixed(1) : "-"; };
  console.log(`一致（same+same_meaning）: 前 ${agree(before.verdicts)}% → 後 ${agree(after.verdicts)}%`);
  console.log(`本来の AIX で一致に直した: 手打ち ${after.mapping.hand}・押し間違い ${after.mapping.mis_press}・当てたがブレインと違った ${after.mapping.unmatched}`);
  console.log(`元の理由（直した番）: 前の理由の数 aix_other ${before.reasons.aix_other ?? 0}・aix_but_text ${before.reasons.aix_but_text ?? 0}`);
  if (after.errors.length) console.log("errors:", after.errors.slice(0, 5));
})().catch((e) => { console.error(e); process.exit(1); });
