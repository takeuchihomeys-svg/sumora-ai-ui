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
