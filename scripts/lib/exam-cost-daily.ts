// scripts/lib/exam-cost-daily.ts — 晩ごとの試験の費用（llm_usage_logs の名札で数える・統括役の決め 11/28）の純な部品
// 2026-11-28 作業員L: exam_runs.cost_usd は 11/15 より前の行が無く、その後も 84% の行で空だった（11月 1,326行中 1,116行）＝試験の費用の正は llm_usage_logs の名札。
//   元は DB の関数 exam_cost_by_night（migrate-schema・晩＝JST の日付を12時で切る・単価は app/lib/llm-price.ts の ALT_PRICES と同じ）。
//   分け: 係の試験（script:brain-exam-main-*）・手元の試験（ほかの script:brain-exam*・係を通らない）・ほか（試験の中の本番の道・名札なし・手元の台本）
export type CostRow = { night: string; cat: "main" | "own" | "other" | string; route: string | null; n: number; usd: number };
export type NightCost = { night: string; main: number; own: number; other: number; total: number; n: { main: number; own: number; other: number }; ownRoutes: Array<{ route: string; n: number; usd: number }> };
export const NIGHT_CAP_USD = 10;
export const OWN_WARN_USD = 1;
const r2 = (x: number) => Math.round(x * 100) / 100;

export function nightCostsOf(rows: readonly CostRow[]): NightCost[] {
  const by = new Map<string, NightCost>();
  for (const r of rows) {
    const k = String(r.night).slice(0, 10);
    const c = by.get(k) ?? { night: k, main: 0, own: 0, other: 0, total: 0, n: { main: 0, own: 0, other: 0 }, ownRoutes: [] };
    const cat = r.cat === "main" || r.cat === "own" ? r.cat : "other";
    const usd = Number(r.usd) || 0, n = Number(r.n) || 0;
    c[cat] += usd; c.n[cat] += n; c.total += usd;
    if (cat === "own" && r.route) c.ownRoutes.push({ route: r.route.replace(/^script:/, ""), n, usd: r2(usd) });
    by.set(k, c);
  }
  return [...by.values()].map((c) => ({ ...c, main: r2(c.main), own: r2(c.own), other: r2(c.other), total: r2(c.total), ownRoutes: c.ownRoutes.sort((a, b) => b.usd - a.usd) })).sort((a, b) => a.night.localeCompare(b.night));
}

/** quality_daily の行（day＝晩・scope all・exam_cost:<分け>） */
export function qualityRowsOf(c: NightCost, source: string) {
  const base = { day: c.night, scope: "all", source };
  return [
    { ...base, metric: "exam_cost:main", value: c.main, n: c.n.main, detail: {} },
    { ...base, metric: "exam_cost:own", value: c.own, n: c.n.own, detail: { routes: c.ownRoutes.slice(0, 15) } },
    { ...base, metric: "exam_cost:other", value: c.other, n: c.n.other, detail: {} },
    { ...base, metric: "exam_cost:total", value: c.total, n: c.n.main + c.n.own + c.n.other, detail: { cap: NIGHT_CAP_USD } },
  ];
}

/** 朝の1枚の行（quality_daily の一番新しい晩の exam_cost:*）。手元の試験が $1 を超えたら名札ごとに ⚠ */
export function examCostMorningLines(rows: ReadonlyArray<{ day: string; metric: string; value: number | null; detail?: unknown }>): string[] {
  if (!rows.length) return [];
  const day = rows[0].day;
  const v = (m: string) => Number(rows.find((r) => r.metric === `exam_cost:${m}`)?.value ?? 0);
  const total = v("total");
  const out = [`- 試験の費用（llm_usage_logs の名札・${day} の晩）: 係の試験 $${v("main").toFixed(2)}・手元の試験 $${v("own").toFixed(2)}・ほか $${v("other").toFixed(2)}・計 $${total.toFixed(2)}／夜の上限 $${NIGHT_CAP_USD} の ${Math.round((total / NIGHT_CAP_USD) * 100)}%${total > NIGHT_CAP_USD ? "（⚠ 上限を超えた）" : ""}`];
  if (v("own") > OWN_WARN_USD) {
    const routes = ((rows.find((r) => r.metric === "exam_cost:own")?.detail as { routes?: Array<{ route: string; n: number; usd: number }> } | undefined)?.routes ?? []).filter((x) => x.usd >= 0.1).slice(0, 8);
    out.push(`  - ⚠ 係の外の試験 $${v("own").toFixed(2)}（$${OWN_WARN_USD} 超え）: ${routes.map((x) => `${x.route} $${x.usd.toFixed(2)}（${x.n}件）`).join("・") || "名札の内訳なし"}`);
  }
  return out;
}
