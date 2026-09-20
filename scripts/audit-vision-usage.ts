// scripts/audit-vision-usage.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-vision-usage.ts [--days=14]
//
// 2026-09-20 竹内「AIXの見積書や、物件オススメの画像読み取りの部分 deepseek V4.1 に置き換えても
//   問題ないかテストして調査おねがい。他にも AIX で画像読み取る部分置き換えできるか確認する」
//
// まず**どこにどれだけ使っているか**を実データで出す（設計知見「材料やルールを足す前に測る」）。
//   ・route="aix:vision" の呼び出しを action 別に集計
//   ・費用は Sonnet5（入力$3/M・出力$15/M）で計算し、DeepSeek-V4.1-Flash に替えた時の額と比べる
// 読み取りのみ。
export {};
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=14").split("=")[1]);
// Sonnet5 / DeepSeek-V4.1-Flash（ピーク）の $/M
const SONNET = { in: 3, out: 15 }, DS = { in: 0.30, out: 1.20 };

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Array<Record<string, unknown>> = [];
  for (let page = 0; ; page++) {
    const { data, error } = await sb.from("llm_usage_logs")
      .select("route, action, model, input_uncached, cache_read, output_tokens, duration_ms, created_at")
      .gte("created_at", since).order("id", { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    rows.push(...(data as Array<Record<string, unknown>>));
    if (data.length < 1000) break;
    if (page > 40) break;
  }
  const vision = rows.filter((r) => String(r.route ?? "").includes("vision"));
  console.log(`=== 直近${DAYS}日の LLM 呼び出し ${rows.length}件 / そのうち画像（vision）${vision.length}件 ===\n`);

  type Agg = { n: number; inTok: number; outTok: number; ms: number };
  const byAction = new Map<string, Agg>();
  for (const r of vision) {
    const k = String(r.action ?? "（不明）");
    const a = byAction.get(k) ?? { n: 0, inTok: 0, outTok: 0, ms: 0 };
    a.n++; a.inTok += Number(r.input_uncached ?? 0) + Number(r.cache_read ?? 0);
    a.outTok += Number(r.output_tokens ?? 0); a.ms += Number(r.duration_ms ?? 0);
    byAction.set(k, a);
  }
  const list = [...byAction.entries()].map(([action, a]) => {
    const cS = (a.inTok * SONNET.in + a.outTok * SONNET.out) / 1e6;
    const cD = (a.inTok * DS.in + a.outTok * DS.out) / 1e6;
    return { action, ...a, cS, cD };
  }).sort((x, y) => y.cS - x.cS);

  console.log(`  ${"AIX の種類".padEnd(26)} ${"回数".padStart(5)} ${"入力".padStart(8)} ${"出力".padStart(7)} ${"平均秒".padStart(6)} ${"今(Sonnet5)".padStart(11)} ${"DeepSeekなら".padStart(12)}`);
  let tS = 0, tD = 0, tN = 0;
  for (const x of list) {
    tS += x.cS; tD += x.cD; tN += x.n;
    console.log(`  ${x.action.slice(0, 26).padEnd(26)} ${String(x.n).padStart(5)} ${String(x.inTok).padStart(8)} ${String(x.outTok).padStart(7)} ${(x.ms / x.n / 1000).toFixed(1).padStart(6)} ${("$" + x.cS.toFixed(3)).padStart(11)} ${("$" + x.cD.toFixed(3)).padStart(12)}`);
  }
  const perMonth = (c: number) => (c / DAYS) * 30;
  console.log(`  ${"".padEnd(26)} ${String(tN).padStart(5)} ${"".padStart(8)} ${"".padStart(7)} ${"".padStart(6)} ${("$" + tS.toFixed(3)).padStart(11)} ${("$" + tD.toFixed(3)).padStart(12)}`);
  console.log(`\n  月あたり: 今 **$${perMonth(tS).toFixed(2)}** → DeepSeek なら **$${perMonth(tD).toFixed(2)}**（差 $${(perMonth(tS) - perMonth(tD)).toFixed(2)}／${Math.round((1 - tD / Math.max(tS, 1e-9)) * 100)}%減）`);

  // 画像以外も含めた全体の中での位置づけ
  const allS = rows.reduce((s, r) => s + ((Number(r.input_uncached ?? 0) + Number(r.cache_read ?? 0)) * SONNET.in + Number(r.output_tokens ?? 0) * SONNET.out) / 1e6, 0);
  console.log(`  （参考）全 LLM 呼び出しの費用に占める画像の割合: ${Math.round((100 * tS) / Math.max(allS, 1e-9))}%`);
}
main().catch((e) => { console.error(e); process.exit(1); });
