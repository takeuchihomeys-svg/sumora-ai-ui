// app/lib/llm-spend-audit.ts — LLM の使った額の週の見張り（llm_usage_logs を読むだけ・LLM なし・$0）
//
// 2026-10-15 竹内さん（小さな直し 10/15）: 週1の見張り（/api/cron/reading-audit-weekly）に、直近7日の1日ごとの LLM の使用額
//   （模型ごと: Claude・DeepSeek・Jev）と前の週との差を足す。急に増えた時に印（alerts）を出す。
//   費用の計算は app/lib/llm-price.ts（Claude は公式の単価・DeepSeek は混雑時間の2倍込み）に合わせる＝scripts/audit-llm-unnamed.ts と同じ数え方。
//   env（production／local:*）を問わず全部数える（手元の試しも同じ口座の費用）。内訳に本番と手元を分けて出す。
//   線（実データ 9/24〜10/14 の揺れを見て決めた・memory/dept_line_reply.md 10/15）:
//     週の合計が前の週の LLM_SPEND_ALERT_RATIO 倍（既定 1.5）を超え、かつ差が LLM_SPEND_ALERT_MIN_USD（既定 $10）以上
//     1日の額が前の週の1日平均の LLM_SPEND_DAY_RATIO 倍（既定 3）を超え、かつ $LLM_SPEND_ALERT_MIN_USD 以上
//   LLM_SPEND_AUDIT=off で見張りから外す（戻す時は消すだけ）
import { claudeUsageUsd, claudePriceOf, altUsageUsd, altPriceOf } from "@/app/lib/llm-price";

export type SpendRow = {
  id?: number; created_at: string; model: string | null; env?: string | null;
  input_uncached?: number | null; cache_read?: number | null; cache_write?: number | null;
  cache_write_5m?: number | null; cache_write_1h?: number | null; output_tokens?: number | null;
};
export type Family = "claude" | "deepseek" | "jev" | "other";
export type FamilyUsd = Record<Family, number>;
export type LlmSpendReport = {
  days: number; since: string; prevSince: string;
  /** 直近の日ごと（JST・古い順） */
  daily: Array<{ day: string; calls: number; usd: number } & FamilyUsd>;
  week: { usd: number; calls: number; byFamily: FamilyUsd; byEnv: { production: number; local: number } };
  prevWeek: { usd: number; calls: number; byFamily: FamilyUsd; byEnv: { production: number; local: number } };
  diff: { usd: number; ratio: number | null; byFamily: FamilyUsd };
  /** 単価の無いモデル（0 で数えた・回数） */
  unpriced: Record<string, number>;
  alerts: string[];
};

const zero = (): FamilyUsd => ({ claude: 0, deepseek: 0, jev: 0, other: 0 });
export const familyOf = (model: string | null | undefined): Family => {
  const m = String(model ?? "");
  if (/claude/.test(m)) return "claude";
  if (/deepseek/.test(m)) return "deepseek";
  if (/^jev:|jev-/.test(m)) return "jev";
  return "other";
};
/** 1行 → $（Claude は llm-price の公式単価・DeepSeek は混雑時間の2倍込み・知らない模型は 0） */
export function rowUsd(r: SpendRow): number {
  return claudePriceOf(r.model) ? claudeUsageUsd(r) : altUsageUsd(r);
}
export const jstDay = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const r2 = (v: number) => Math.round(v * 100) / 100;
const envNum = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };

/** 純関数: 直近 days 日と、その前の days 日を比べる（rows は 2×days 日分） */
export function summarizeLlmSpend(rows: SpendRow[], opts: { days?: number; now?: number } = {}): LlmSpendReport {
  const days = opts.days ?? 7;
  const now = opts.now ?? Date.now();
  const sinceMs = now - days * 86400_000, prevMs = now - 2 * days * 86400_000;
  const mk = () => ({ usd: 0, calls: 0, byFamily: zero(), byEnv: { production: 0, local: 0 } });
  const week = mk(), prevWeek = mk();
  const dayMap = new Map<string, { calls: number; usd: number } & FamilyUsd>();
  const unpriced: Record<string, number> = {};
  for (const r of rows) {
    const t = new Date(r.created_at).getTime();
    if (!Number.isFinite(t) || t < prevMs || t > now) continue;
    const fam = familyOf(r.model);
    const priced = !!(claudePriceOf(r.model) || altPriceOf(r.model));
    if (!priced) unpriced[String(r.model)] = (unpriced[String(r.model)] ?? 0) + 1;
    const usd = priced ? rowUsd(r) : 0;
    const b = t >= sinceMs ? week : prevWeek;
    b.usd += usd; b.calls++; b.byFamily[fam] += usd;
    b.byEnv[r.env === "production" ? "production" : "local"] += usd;
    if (t >= sinceMs) {
      const d = jstDay(r.created_at);
      const x = dayMap.get(d) ?? { calls: 0, usd: 0, ...zero() };
      x.calls++; x.usd += usd; x[fam] += usd; dayMap.set(d, x);
    }
  }
  const round = (b: ReturnType<typeof mk>) => ({ usd: r2(b.usd), calls: b.calls, byFamily: { claude: r2(b.byFamily.claude), deepseek: r2(b.byFamily.deepseek), jev: r2(b.byFamily.jev), other: r2(b.byFamily.other) }, byEnv: { production: r2(b.byEnv.production), local: r2(b.byEnv.local) } });
  const W = round(week), P = round(prevWeek);
  const daily = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, x]) => ({ day, calls: x.calls, usd: r2(x.usd), claude: r2(x.claude), deepseek: r2(x.deepseek), jev: r2(x.jev), other: r2(x.other) }));
  const diff = { usd: r2(W.usd - P.usd), ratio: P.usd > 0 ? Math.round((W.usd / P.usd) * 100) / 100 : null, byFamily: zero() };
  for (const k of Object.keys(diff.byFamily) as Family[]) diff.byFamily[k] = r2(W.byFamily[k] - P.byFamily[k]);

  const alerts: string[] = [];
  const ratio = envNum("LLM_SPEND_ALERT_RATIO", 1.5), minUsd = envNum("LLM_SPEND_ALERT_MIN_USD", 10), dayRatio = envNum("LLM_SPEND_DAY_RATIO", 3);
  if (W.usd - P.usd >= minUsd && (P.usd === 0 || W.usd / P.usd > ratio)) alerts.push(`LLM の使用額が前の週の ${diff.ratio ?? "∞"}倍（$${P.usd}→$${W.usd}）`);
  for (const k of ["claude", "deepseek"] as const) {
    const a = W.byFamily[k], p = P.byFamily[k];
    if (a - p >= minUsd && (p === 0 || a / p > ratio)) alerts.push(`${k === "claude" ? "Claude" : "DeepSeek"} の使用額が前の週の ${p ? Math.round((a / p) * 100) / 100 : "∞"}倍（$${p}→$${a}）`);
  }
  const prevDayAvg = P.usd / days;
  for (const d of daily) if (d.usd >= minUsd && prevDayAvg > 0 && d.usd > prevDayAvg * dayRatio) alerts.push(`${d.day} の LLM 使用額 $${d.usd}（前の週の1日平均 $${r2(prevDayAvg)} の ${Math.round((d.usd / prevDayAvg) * 10) / 10}倍）`);
  return { days, since: new Date(sinceMs).toISOString(), prevSince: new Date(prevMs).toISOString(), daily, week: W, prevWeek: P, diff, unpriced, alerts };
}

/** サーバー: llm_usage_logs の 2×days 日分を id の順にページで読む（必要な列だけ） */
export async function fetchLlmSpend(opts: { days?: number; now?: number } = {}): Promise<LlmSpendReport> {
  const { supabase } = await import("@/app/lib/supabase");
  const days = opts.days ?? 7;
  const now = opts.now ?? Date.now();
  const prevIso = new Date(now - 2 * days * 86400_000).toISOString();
  const rows: SpendRow[] = [];
  let lastId = 0;
  for (let p = 0; p < 400; p++) {
    let q = supabase.from("llm_usage_logs")
      .select("id, created_at, model, env, input_uncached, cache_read, cache_write, cache_write_5m, cache_write_1h, output_tokens")
      .order("id", { ascending: true }).limit(1000);
    q = lastId ? q.gt("id", lastId) : q.gte("created_at", prevIso);
    const { data, error } = await q;
    if (error) throw new Error(`llm_usage_logs: ${error.message}`);
    const d = (data ?? []) as unknown as SpendRow[];
    // id の順＝書いた順（BIGSERIAL）。最初のページだけ日付で始め、以降は id で続ける（途中の古い行は summarize で落とす）
    rows.push(...d);
    if (d.length < 1000) break;
    lastId = Number(d[d.length - 1].id);
  }
  return summarizeLlmSpend(rows, { days, now });
}
