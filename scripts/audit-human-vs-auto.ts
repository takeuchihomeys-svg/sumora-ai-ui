// scripts/audit-human-vs-auto.ts
// 2026-11-10 竹内「人が押してる動きと差がないように自動での動きの時に人の動きに足りていない部分見つかれば改善するかたち」
//
// 何をするか: 拡張の点検の記録（search_audits.steps・filled）から「人の操作」と「拡張の操作」の
//   リズムを比べ、自動（拡張）で足りていない所を挙げる。読み取りだけ（書き込みなし）。
//
// 見方（足りない＝自動が人より機械的な所）:
//   ① 間のばらつき  … 人の操作の間（steps の差）と拡張の間（ops の w）の散らばりを比べる
//        変動係数（標準偏差÷平均）が人の半分未満なら「等間隔すぎる」
//   ② 一息（長い休み） … 人の間にある「平均の2.5倍を超える間」の割合と、拡張の割合を比べる
//   ③ 最初の間      … 人が画面を開いてから最初に押すまでの間（考えてから動く）が自動に無いか
//   ④ 操作の重なり  … 拡張の ops に「前の操作と 0〜20ms しか空いていない」物が残っていないか
//   ⑤ 人の痕跡      … 案内モードの回（trigger=single/bulk_manual）で filled.human.n が 0 の割合
//
// 使い方:
//   npx tsx --env-file=.env.local scripts/audit-human-vs-auto.ts --days=7
//   npx tsx --env-file=.env.local scripts/audit-human-vs-auto.ts --days=7 --site=itandi --limit=200
//   npx tsx --env-file=.env.local scripts/audit-human-vs-auto.ts --days=7 --json
//
// ⚠ 営業時間（JST 9〜22時）に全件を読まない。既定は直近7日・1000行ずつ頁で読む。
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const argOf = (name: string, def: string | null = null): string | null => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  if (hit.includes("=")) return hit.split("=").slice(1).join("=");
  const i = args.indexOf(hit);
  return args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "true";
};
const DAYS = Math.max(1, Math.min(90, Number(argOf("days", "7")) || 7));
const SITE = argOf("site");
const LIMIT = Math.max(50, Math.min(5000, Number(argOf("limit", "1000")) || 1000));
const AS_JSON = args.includes("--json");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
);

type Step = { at?: number; k?: string; d?: string | null };
type Op = { t?: number; k?: string; p?: number; w?: number; by?: string };
type Row = {
  run_id: string;
  created_at: string | null;
  site: string | null;
  trigger: string | null;
  steps: Step[] | null;
  filled: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  ext_version: string | null;
};

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
};
const cv = (xs: number[]): number => {
  const m = mean(xs);
  return m > 0 ? stdev(xs) / m : 0;
};
/** 平均の k 倍を超える間（人の「一息」）の割合 */
const breathRate = (gaps: number[], k = 2.5): number => {
  if (gaps.length < 3) return 0;
  const m = mean(gaps);
  if (m <= 0) return 0;
  return gaps.filter((g) => g > m * k).length / gaps.length;
};
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const ms = (v: number): string => `${Math.round(v)}ms`;

/** steps の時刻（連続の差）→ 人の操作の間。飛びすぎた物（タブ切替・待ち）は除く */
function gapsFromSteps(steps: Step[] | null): number[] {
  const at = (steps ?? []).map((s) => Number(s.at)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i < at.length; i++) {
    const d = at[i] - at[i - 1];
    if (d > 0 && d < 60000) out.push(d); // 1分超は「待ち・別の事」なので操作の間に入れない
  }
  return out;
}

/** filled.ops → 実際の間。by を渡すとその主体（human/auto）の操作だけを取る */
function gapsFromOps(filled: Record<string, unknown> | null, by?: "human" | "auto"): number[] {
  const all = (filled && Array.isArray(filled.ops) ? filled.ops : []) as Op[];
  const ops = by ? all.filter((o) => (o.by === by || (!o.by && by === "auto"))) : all;
  const ts = ops.map((o) => Number(o.t)).filter((n) => Number.isFinite(n));
  if (ts.length >= 2) {
    const sorted = [...ts].sort((a, b) => a - b);
    const out: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const d = sorted[i] - sorted[i - 1];
      if (d > 0 && d < 60000) out.push(d);
    }
    return out;
  }
  return ops.map((o) => Number(o.w)).filter((n) => Number.isFinite(n) && n > 0 && n < 60000);
}

async function main(): Promise<void> {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let from = 0; from < LIMIT; from += 500) {
    let q = sb.from("search_audits")
      .select("run_id, created_at, site, trigger, steps, filled, result, ext_version")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(from, from + 499);
    if (SITE) q = q.eq("site", SITE);
    const r = await q;
    if (r.error) {
      console.error("読めません:", r.error.message);
      process.exit(1);
    }
    rows.push(...((r.data ?? []) as Row[]));
    if (!r.data || r.data.length < 500) break;
  }
  if (rows.length > LIMIT) rows.length = LIMIT;

  // 人の回（案内モード＝trigger が single / bulk_manual。スタッフが押した回）
  const humanish = rows.filter((r) => r.trigger === "single" || r.trigger === "bulk_manual");
  const autos = rows.filter((r) => r.trigger !== "single" && r.trigger !== "bulk_manual");

  // 人の間: ①人が押した時刻（filled.ops の by=human・案内モードで拡張が記録）②steps の時刻 の両方を使う
  const humanGaps = [
    ...humanish.flatMap((r) => gapsFromOps(r.filled, "human")),
    ...humanish.flatMap((r) => gapsFromSteps(r.steps)),
  ];
  // 自動の間: 拡張が押した時刻（filled.ops の by=auto・無ければ steps）
  const autoGaps = autos.flatMap((r) => {
    const gaps = gapsFromOps(r.filled, "auto");
    return gaps.length ? gaps : gapsFromSteps(r.steps);
  });

  const humanN = (r: Row): number | null => {
    const f = r.filled as Record<string, unknown> | null;
    const h = f && typeof f.human === "object" && f.human ? (f.human as Record<string, unknown>) : null;
    return h && typeof h.n === "number" ? h.n : null;
  };
  const humanTrace = humanish.map((r) => humanN(r)).filter((n): n is number => n != null);
  const zeroHuman = humanTrace.filter((n) => n === 0).length;

  // 操作の重なり（拡張の ops で 0〜20ms しか空いていない所）
  let tightOps = 0;
  let tightTotal = 0;
  for (const r of rows) {
    const f = r.filled as Record<string, unknown> | null;
    const ops = (f && Array.isArray(f.ops) ? f.ops : []) as Op[];
    const ts = ops.map((o) => Number(o.t)).filter((n) => Number.isFinite(n));
    for (let i = 1; i < ts.length; i++) {
      tightTotal++;
      if (ts[i] - ts[i - 1] <= 20) tightOps++;
    }
  }

  const hCv = cv(humanGaps), aCv = cv(autoGaps);
  const hBreath = breathRate(humanGaps), aBreath = breathRate(autoGaps);
  const hFirst = mean(humanish.map((r) => {
    const at = (r.steps ?? []).map((s) => Number(s.at)).filter((n) => Number.isFinite(n));
    return at.length >= 2 ? at[1] - at[0] : 0;
  }).filter((x) => x > 0));

  // 足りていない所（自動が人より機械的）
  const findings: Array<{ key: string; ja: string; hint: string }> = [];
  if (humanGaps.length >= 10 && autoGaps.length >= 10) {
    if (aCv < hCv * 0.5) {
      findings.push({ key: "gap_variance", ja: `間のばらつきが人の半分未満（人 CV=${hCv.toFixed(2)} / 自動 CV=${aCv.toFixed(2)}）`, hint: "自動の待ちを対数正規にして、一様乱数や固定値を使わない" });
    }
    if (aBreath < hBreath * 0.5) {
      findings.push({ key: "breath", ja: `「一息」（平均の2.5倍超の間）が人の半分未満（人 ${pct(hBreath)} / 自動 ${pct(aBreath)}）`, hint: "低確率で長めの間（例 8%で+400〜1100ms）を入れる" });
    }
  }
  if (tightTotal > 0 && tightOps / tightTotal > 0.02) {
    findings.push({ key: "tight_ops", ja: `20ms 以内に続く操作が ${pct(tightOps / tightTotal)}（${tightOps}/${tightTotal}）`, hint: "1件ずつ人の間を空ける（まとめて押さない）" });
  }
  if (humanTrace.length > 0 && zeroHuman / humanTrace.length > 0.3) {
    findings.push({ key: "no_human", ja: `案内モードなのに人の操作が0回の回が ${pct(zeroHuman / humanTrace.length)}（${zeroHuman}/${humanTrace.length}）`, hint: "案内が止まっている疑い（人に押してもらえていない・光が見えていない）" });
  }

  const out = {
    days: DAYS,
    site: SITE,
    rows: rows.length,
    human_runs: humanish.length,
    auto_runs: autos.length,
    with_steps: rows.filter((r) => Array.isArray(r.steps) && r.steps.length >= 2).length,
    with_ops: rows.filter((r) => {
      const f = r.filled as Record<string, unknown> | null;
      return !!(f && Array.isArray(f.ops) && f.ops.length >= 2);
    }).length,
    with_human_ops: rows.filter((r) => {
      const f = r.filled as Record<string, unknown> | null;
      const ops = (f && Array.isArray(f.ops) ? f.ops : []) as Op[];
      return ops.filter((o) => o.by === "human").length >= 2;
    }).length,
    with_human: humanTrace.length,
    triggers: rows.reduce<Record<string, number>>((acc, r) => {
      const k = String(r.trigger ?? "(なし)");
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
    gaps: {
      human: { n: humanGaps.length, mean: Math.round(mean(humanGaps)), cv: +hCv.toFixed(3), breath: +hBreath.toFixed(3), first_ms: Math.round(hFirst) },
      auto: { n: autoGaps.length, mean: Math.round(mean(autoGaps)), cv: +aCv.toFixed(3), breath: +aBreath.toFixed(3) },
    },
    human_zero_rate: humanTrace.length ? +(zeroHuman / humanTrace.length).toFixed(3) : null,
    tight_ops: { n: tightOps, total: tightTotal },
    findings,
    enough_data: humanGaps.length >= 10 || autoGaps.length >= 10,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`\n人と自動の動きの比べ — 直近 ${DAYS} 日・${rows.length} 回（人 ${humanish.length} / 自動 ${autos.length}）`);
  console.log(`\n■ 操作の間`);
  console.log(`  人  : ${humanGaps.length} 個・平均 ${ms(mean(humanGaps))}・ばらつき(CV) ${hCv.toFixed(2)}・一息 ${pct(hBreath)}・最初の間 ${ms(hFirst)}`);
  console.log(`  自動: ${autoGaps.length} 個・平均 ${ms(mean(autoGaps))}・ばらつき(CV) ${aCv.toFixed(2)}・一息 ${pct(aBreath)}`);
  console.log(`\n■ 20ms 以内に続く操作: ${tightOps}/${tightTotal}`);
  if (out.human_zero_rate != null) console.log(`■ 案内モードで人の操作が0回: ${pct(out.human_zero_rate)}`);
  console.log(`\n■ 足りていない所`);
  if (!out.enough_data) {
    console.log("  判定できません（材料が足りない）");
    console.log(`  ・操作の記録（steps）が2件以上ある回: ${out.with_steps}/${rows.length}`);
    console.log(`  ・拡張の操作（filled.ops）が2件以上ある回: ${out.with_ops}/${rows.length}`);
    console.log(`  ・人の操作の時刻（filled.ops の by=human）が2件以上ある回: ${out.with_human_ops}/${rows.length}`);
    console.log(`  ・人の操作（filled.human）が入っている回: ${out.with_human}/${rows.length}`);
    console.log(`  ・trigger の内訳: ${Object.entries(out.triggers).map(([k, v]) => `${k}=${v}`).join(" / ")}`);
    console.log("  ※ v2.5.93 の拡張に替えた後、案内モードで数回検索すると材料がそろいます");
  } else if (!findings.length) {
    console.log("  なし（人の動きとの差が小さい）");
  }
  for (const f of findings) console.log(`  ⚠ ${f.ja}\n     → ${f.hint}`);
  console.log("");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
