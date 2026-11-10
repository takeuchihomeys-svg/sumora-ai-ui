// scripts/learn-human-gaps.ts
// 2026-11-10 竹内さん「スタッフが今まで通り選択していく動きを参考に動き学ぶことできるのかな？」→「進める」
//
// 何をするか（読むだけ・書き込みなし）:
//   スタッフモード（案内）で**人が実際に押した操作の間隔**を search_audits.filled.ops から集め、
//   分布（中央値・ばらつき・裾）を測って「自動の待ちをどう合わせるか」を数字で出す。
//
// 使い方:
//   npx tsx --env-file=.env.local scripts/learn-human-gaps.ts --days=90
//   npx tsx --env-file=.env.local scripts/learn-human-gaps.ts --days=90 --json
//
// ⚠ 営業時間中は全件を読まない（既定 90日・500行ずつ頁で読む）。
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const argOf = (name: string, def: string | null = null): string | null => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  if (hit.includes("=")) return hit.split("=").slice(1).join("=");
  const i = args.indexOf(hit);
  return args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "true";
};
const DAYS = Math.max(1, Math.min(180, Number(argOf("days", "90")) || 90));
const AS_JSON = args.includes("--json");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
);

type Op = { t?: number; k?: string; by?: string };

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function main(): Promise<void> {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const rows: Array<{ filled: Record<string, unknown> | null; trigger: string | null }> = [];
  for (let from = 0; from < 6000; from += 500) {
    const r = await sb.from("search_audits")
      .select("filled,trigger")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(from, from + 499);
    if (r.error) { console.error("読めません:", r.error.message); process.exit(1); }
    rows.push(...((r.data ?? []) as typeof rows));
    if (!r.data || r.data.length < 500) break;
  }

  // 人の操作の間（案内モードの回だけ・by=human の時刻の差）
  const humanGaps: number[] = [];
  // 拡張の操作の間（比較用）
  const autoGaps: number[] = [];
  let humanRuns = 0;
  for (const row of rows) {
    const isHumanRun = row.trigger === "single" || row.trigger === "bulk_manual";
    const f = row.filled;
    const ops = (f && Array.isArray(f.ops) ? f.ops : []) as Op[];
    if (!ops.length) continue;
    const pick = (by: string) => ops.filter((o) => o.by === by).map((o) => Number(o.t)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    const push = (target: number[], ts: number[]) => {
      for (let i = 1; i < ts.length; i++) {
        const d = ts[i] - ts[i - 1];
        if (d > 0 && d < 60000) target.push(d);
      }
    };
    if (isHumanRun) {
      const h = pick("human");
      if (h.length >= 2) { humanRuns++; push(humanGaps, h); }
    } else {
      push(autoGaps, pick("auto"));
    }
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const sd = (xs: number[]) => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
  };
  const logFit = (xs: number[]) => {
    const l = xs.filter((x) => x > 0).map((x) => Math.log(x));
    if (l.length < 2) return { median: 0, sigma: 0 };
    const m = l.reduce((a, b) => a + b, 0) / l.length;
    const s = Math.sqrt(l.reduce((a, b) => a + (b - m) * (b - m), 0) / (l.length - 1));
    return { median: Math.round(Math.exp(m)), sigma: +s.toFixed(3) };
  };
  const bucketsOf = (xs: number[]) => {
    const b = { under300: 0, "300-600": 0, "600-1000": 0, "1-2s": 0, "2-4s": 0, "4-8s": 0, over8s: 0 };
    for (const g of xs) {
      if (g < 300) b.under300++;
      else if (g < 600) b["300-600"]++;
      else if (g < 1000) b["600-1000"]++;
      else if (g < 2000) b["1-2s"]++;
      else if (g < 4000) b["2-4s"]++;
      else if (g < 8000) b["4-8s"]++;
      else b.over8s++;
    }
    return b;
  };

  const hs = [...humanGaps].sort((a, b) => a - b);
  const as = [...autoGaps].sort((a, b) => a - b);
  const hMean = mean(hs), aMean = mean(as);
  const out = {
    days: DAYS,
    rows: rows.length,
    human_runs: humanRuns,
    human: {
      n: hs.length,
      mean: Math.round(hMean),
      sd: Math.round(sd(hs)),
      cv: hMean ? +(sd(hs) / hMean).toFixed(2) : 0,
      p10: quantile(hs, 0.1), p25: quantile(hs, 0.25), median: quantile(hs, 0.5),
      p75: quantile(hs, 0.75), p90: quantile(hs, 0.9), p95: quantile(hs, 0.95), max: hs[hs.length - 1] ?? 0,
      logNormal: logFit(hs),
      buckets: bucketsOf(hs),
    },
    auto: {
      n: as.length, mean: Math.round(aMean), cv: aMean ? +(sd(as) / aMean).toFixed(2) : 0,
      median: quantile(as, 0.5), logNormal: logFit(as), buckets: bucketsOf(as),
    },
  };

  if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); return; }

  console.log(`\nスタッフの操作の間（直近 ${DAYS} 日・${rows.length} 回・人が動いた回 ${humanRuns}）`);
  console.log(`\n■ 人（${hs.length} 個）`);
  console.log(`  平均 ${hMean.toFixed(0)}ms・中央値 ${out.human.median}ms・ばらつき ${out.human.cv}`);
  console.log(`  p10 ${out.human.p10} / p25 ${out.human.p25} / p75 ${out.human.p75} / p90 ${out.human.p90} / p95 ${out.human.p95} / 最大 ${out.human.max}`);
  console.log(`  対数正規の当てはめ: 中央値 ${out.human.logNormal.median}ms・σ ${out.human.logNormal.sigma}`);
  console.log(`  分布: ${JSON.stringify(out.human.buckets)}`);
  console.log(`\n■ 自動（${as.length} 個・比較）`);
  console.log(`  平均 ${aMean.toFixed(0)}ms・中央値 ${out.autos ? "" : ""}${out.auto.median}ms・ばらつき ${out.auto.cv}`);
  console.log(`  対数正規: 中央値 ${out.auto.logNormal.median}ms・σ ${out.auto.logNormal.sigma}`);
  console.log(`  分布: ${JSON.stringify(out.auto.buckets)}`);

  console.log(`\n■ どう合わせるか（提案）`);
  if (hs.length < 100) {
    console.log("  材料が少ない（人の操作 100個未満）。もっと案内モードで検索すると精度が上がる");
  } else {
    console.log(`  自動の「押す間」の中央値を ${out.human.logNormal.median}ms・σ ${out.human.logNormal.sigma} に寄せる`);
    console.log(`  （いまの自動は中央値 ${out.auto.logNormal.median}ms・σ ${out.auto.logNormal.sigma}）`);
    const longRate = (out.human.buckets["4-8s"] + out.human.buckets.over8s) / hs.length;
    console.log(`  「一息」（4秒超）の割合 ${pct(longRate)} を自動にも入れる（いまは ${pct((out.auto.buckets["4-8s"] + out.auto.buckets.over8s) / Math.max(1, as.length))}）`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
