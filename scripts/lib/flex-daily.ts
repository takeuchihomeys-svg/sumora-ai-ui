// scripts/lib/flex-daily.ts — 土台「臨機応変」の本番の毎日の数（純関数・作業員N2・2026-11-22・台帳 #512・#158）
//
// scripts/audit-off-pattern.ts --days=30 --out=<json> の groups（竹内さん本人の番「竹内:」）から:
//   growth:flex:off_rate  … 型外の番（場面の網に当たらない・場面が空・その他・語とブレインの場面の食い違い）÷ 竹内さん本人の番（%）
//   growth:flex:off_match … 型外の番の下書きとスタッフの一致（%）。普段の番の一致（growth:flex:normal_match）と比べて低いほど、決まりに無理に当てている
// 台本は DB を読む（30日・見張りの番＋その時刻の送信）ので、毎朝の1枚の夜の回（JST 22〜9時）だけ流す
export type OffGroup = { n: number; match: number };
export type OffPatternJson = { days: number; n: number; groups: Record<string, OffGroup> };

const OFF_KEYS = ["scene_empty", "scene_other", "brain_other", "word_brain_mismatch"] as const;

export function flexMetricsOf(j: OffPatternJson, pre = "竹内:"): { turns: number; off: number; offRate: number | null; offMatch: number | null; normalMatch: number | null } {
  const g = (k: string): OffGroup => j.groups?.[pre + k] ?? { n: 0, match: 0 };
  const normal = g("normal");
  const off = OFF_KEYS.reduce((a, k) => ({ n: a.n + g(k).n, match: a.match + g(k).match }), { n: 0, match: 0 });
  const turns = normal.n + off.n;
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return { turns, off: off.n, offRate: pct(off.n, turns), offMatch: pct(off.match, off.n), normalMatch: pct(normal.match, normal.n) };
}

/**
 * 土台「信頼」の本番の毎日の数（台帳 #514・#55 の B1・2026-11-22 作業員N2）: scripts/audit-promise-kept.ts --days=30 --out=<json> の rows から
 *   growth:trust:promise_kept … 判定のある約束（期限内・遅れ・期限切れ）のうち期限内に果たした割合（%）。竹内さん本人の約束だけの割合も（scope=takeuchi）
 */
export type PromiseKeptRow = { state: string; writer?: string | null };
export function trustMetricsOf(rows: ReadonlyArray<PromiseKeptRow>): { judged: number; inTime: number; rate: number | null; tkJudged: number; tkRate: number | null; overdue: number } {
  const judgedOf = (rs: ReadonlyArray<PromiseKeptRow>) => rs.filter((r) => r.state === "in_time" || r.state === "late" || r.state === "overdue");
  const all = judgedOf(rows), tk = judgedOf(rows.filter((r) => r.writer === "takeuchi"));
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const inTime = all.filter((r) => r.state === "in_time").length;
  return { judged: all.length, inTime, rate: pct(inTime, all.length), tkJudged: tk.length, tkRate: pct(tk.filter((r) => r.state === "in_time").length, tk.length), overdue: all.filter((r) => r.state === "overdue").length };
}

/**
 * 申込までの地図の駅ごとの一致（作業員R の scripts/audit-route-progress-takeuchi.ts --json の行・作業員P の地図 route:sg_match・2026-11-23 作業員N2）
 *   地図の駅（作り直し・node）と判断の記録の段（digest.sg・digestNode）が同じ番の割合（%）。sg の時代（11/03 05:42Z 以降）の番だけ
 *   （それより前は cp の5段しか無く、駅のままだと数え方で外れる＝R・M の #620）。同じの決め方は台本の sameSt と同じ（記録が pickup の時は hearing・pickup・proposing を同じに数える）
 *   route:sg_match（全体）・route:sg_match:<駅の id>（駅ごと・n は番の数）。scope は takeuchi（竹内さん本人の番）
 */
export const ROUTE_SG_FROM = "2026-11-03T05:42";
export type RouteProgressRow = { at: string; node: string | null; digestNode: string | null };
export function routeSgMatchRowsOf(rows: ReadonlyArray<RouteProgressRow>): Array<{ metric: string; value: number | null; n: number }> {
  const same = (x: RouteProgressRow) => x.node === x.digestNode || (x.digestNode === "pickup" && ["hearing", "pickup", "proposing"].includes(x.node ?? ""));
  const sg = rows.filter((x) => x.node && x.digestNode && x.at >= ROUTE_SG_FROM);
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const out = [{ metric: "route:sg_match", value: pct(sg.filter(same).length, sg.length), n: sg.length }];
  const by = new Map<string, RouteProgressRow[]>();
  for (const x of sg) by.set(x.node!, [...(by.get(x.node!) ?? []), x]);
  for (const [k, xs] of [...by].sort((a, b) => b[1].length - a[1].length)) out.push({ metric: `route:sg_match:${k}`, value: pct(xs.filter(same).length, xs.length), n: xs.length });
  return out;
}

/**
 * 土台「つなぎ」の本番の数（作業員H の scripts/tsunagi-census.ts --json の by.全体.全体・2026-11-23 作業員N2）: 竹内さん本人の送信の
 *   foundation:link:tsunagi_rate … つなぎ（申込・内覧・見積・物件を送ってもらう・質問・次の連絡・続ける）の入った通の割合（%）
 *   foundation:link:kind:<型> … 型ごとの割合（%・none を含む）。n は通の数。scope は takeuchi
 */
export type TsunagiCensusJson = { days?: number; n?: number; by?: Record<string, Record<string, Record<string, number>>> };
export function tsunagiRowsOf(j: TsunagiCensusJson): Array<{ metric: string; value: number | null; n: number }> {
  const c = j.by?.["全体"]?.["全体"];
  if (!c || !c.n) return [];
  const pct = (a: number) => Math.round((a / c.n) * 1000) / 10;
  const kinds = Object.keys(c).filter((k) => k !== "n");
  return [{ metric: "foundation:link:tsunagi_rate", value: pct(c.n - (c.none ?? 0)), n: c.n }, ...kinds.map((k) => ({ metric: `foundation:link:kind:${k}`, value: pct(c[k] ?? 0), n: c.n }))];
}