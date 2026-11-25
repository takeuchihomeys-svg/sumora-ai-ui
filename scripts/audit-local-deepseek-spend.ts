// scripts/audit-local-deepseek-spend.ts — 手元（env=local:*）の DeepSeek の費用を日ごと・晩の内外・種類で分け、晩の費用の関所（audit-night-cost）が数える額と比べる（読むだけ・LLM なし）
// 2026-11-26 作業員L（統括役の頼み: audit-route-plan の「試験 DeepSeek $375（今月）」が晩の上限 $10/日と合わない）
//   種類: ①晩の試験（route=script:brain-exam-*・JST 22〜8時）②昼の試験（同じ route・8〜22時）③手で回した台本（その他の script:*＝再生・ラベル付け・解剖 等）
//         ④試験ではない手元の呼び出し（route が script: でない＝手元の開発サーバ・作業員の確かめ）。関所が数えるのは ① だけ（audit-night-cost の route=script:brain-exam-*・晩の窓）
//   単価は app/lib/llm-price の altUsageUsd（DeepSeek の倍の時間は2倍）。出すのは額と回数だけ
// 実行: npx tsx --env-file=.env.local scripts/audit-local-deepseek-spend.ts [--since=2026-11-01]
import { createClient } from "@supabase/supabase-js";
import { altUsageUsd } from "../app/lib/llm-price";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type R = { id: number; created_at: string; route: string | null; model: string; input_uncached: number | null; cache_read: number | null; output_tokens: number | null };
export type SpendKind = "night_exam" | "day_exam" | "hand_script" | "local_call";
export function spendKindOf(route: string | null, createdAt: string): SpendKind {
  const r = String(route ?? "");
  const h = (new Date(Date.parse(createdAt) + 9 * 3_600_000).getUTCHours());
  const night = h >= 22 || h < 8;
  if (r.startsWith("script:brain-exam-")) return night ? "night_exam" : "day_exam";
  if (r.startsWith("script:")) return "hand_script";
  return "local_call";
}
/** 晩の日付（22時〜翌8時は始まった日・8〜22時はその日） */
export function nightDayOf(createdAt: string): string {
  const j = new Date(Date.parse(createdAt) + 9 * 3_600_000);
  if (j.getUTCHours() < 8) j.setUTCDate(j.getUTCDate() - 1);
  return j.toISOString().slice(0, 10);
}

if (require.main === module) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const since = arg("since", "2026-11-01");
  const by = new Map<string, Record<SpendKind, { usd: number; n: number }>>();
  const top = new Map<string, number>();
  let lastId = 0;
  for (let page = 0; page < 400; page++) {
    const { data, error } = await sb.from("llm_usage_logs").select("id, created_at, route, model, input_uncached, cache_read, output_tokens")
      .gte("created_at", `${since}T00:00:00+09:00`).like("env", "local:%").ilike("model", "deepseek%").gt("id", lastId).order("id").limit(1000);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as R[];
    for (const r of rows) {
      const usd = altUsageUsd(r as never);
      const k = spendKindOf(r.route, r.created_at), d = nightDayOf(r.created_at);
      const e = by.get(d) ?? { night_exam: { usd: 0, n: 0 }, day_exam: { usd: 0, n: 0 }, hand_script: { usd: 0, n: 0 }, local_call: { usd: 0, n: 0 } };
      e[k].usd += usd; e[k].n++;
      by.set(d, e);
      if (k !== "night_exam") { const name = `${k}｜${String(r.route ?? "（route なし）").replace(/^script:brain-exam-.*/, "script:brain-exam-*").slice(0, 40)}`; top.set(name, (top.get(name) ?? 0) + usd); }
      lastId = r.id;
    }
    if (rows.length < 1000) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const f = (x: { usd: number; n: number }) => `$${x.usd.toFixed(2)}（${x.n}）`;
  console.log(`# 手元の DeepSeek の費用（${since} から・晩の日付ごと）\n`);
  console.log("| 晩 | ①晩の試験（関所が数える） | ②昼の試験 | ③手で回した台本 | ④試験でない手元の呼び出し | 合計 |\n|---|---|---|---|---|---|");
  const tot = { night_exam: 0, day_exam: 0, hand_script: 0, local_call: 0 };
  for (const [d, e] of [...by].sort()) {
    const sum = e.night_exam.usd + e.day_exam.usd + e.hand_script.usd + e.local_call.usd;
    (Object.keys(tot) as SpendKind[]).forEach((k) => { tot[k] += e[k].usd; });
    console.log(`| ${d} | ${f(e.night_exam)} | ${f(e.day_exam)} | ${f(e.hand_script)} | ${f(e.local_call)} | $${sum.toFixed(2)} |`);
  }
  const all = tot.night_exam + tot.day_exam + tot.hand_script + tot.local_call;
  console.log(`\n合計 $${all.toFixed(2)}: ①晩の試験 $${tot.night_exam.toFixed(2)}・②昼の試験 $${tot.day_exam.toFixed(2)}・③手で回した台本 $${tot.hand_script.toFixed(2)}・④手元の呼び出し $${tot.local_call.toFixed(2)}（関所の外 $${(all - tot.night_exam).toFixed(2)}）`);
  console.log("\n## 関所の外で多い物（上位12）");
  for (const [k, v] of [...top].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`- ${k}: $${v.toFixed(2)}`);
})().catch((e) => { console.error(e); process.exit(1); });
