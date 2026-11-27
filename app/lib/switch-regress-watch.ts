// app/lib/switch-regress-watch.ts — on にしたスイッチの悪化の見張り（#813・純関数・LLM なし・2026-11-27 作業員A）
//
// 竹内さんの決定 11/03（KB 4652ef03・P1 ②）「スイッチは YUMA → 一部の会話 → 全部の順で広げ、一致率・エラーが悪くなったら自動で切る」。
//   段階のスイッチ（<NAME>_STAGE=pct:N|all）は rollout-watch.ts（作業員1・夜の cron・rollout_overrides で1段戻す）が既に見張っている。
//   ここはそれ以外の「env で on にしただけ」のスイッチ（brain_switch_versions に on で出た物）を、on にした日の前後で本番の物差し（quality_daily）で比べる。
// 物差し: 返信の一致（reply_match）・AIX の最初の一手の一致（aix_first_match）・そのまま送れた割合（L の #811・名前は L の物を足す）。scope は takeuchi と all。
// 判定（rollout-watch と同じ線）: 前後7日を番の数で重み付けして合わせ、どちらかが 20番に足りなければ「分からない」（今朝の返信の一致 5番で 0% のような日を判定にしない）。
//   下がった＝5pt 以上下がり、かつ片側の比率の差の検定で z ≥ 1.64（揺れでは無い）。それ以外は「変わらない」。
// 下がった時にする事: 知らせて台帳に積むだけ（自動で off にはしない）。
//   理由: env で on にしたスイッチは rollout_overrides を読まない（stageOnNow を通らない）＝自動で切るには env を書き換えるしか無く、
//   rollout-watch も「env（統括役の決定）は書き換えない」としている。自動で切るなら、そのスイッチを段階（stageOn）で読む形に移すのが先（竹内さんに聞く）。
import { ROLLOUT_MIN_N, ROLLOUT_DROP_PT } from "./rollout-watch";

export type QualityRow = { day: string; metric: string; scope: string; value: number | string | null; n: number | null; source?: string | null };
export type SwitchVersion = { switches: string; first_seen_at: string };
export const WATCH_METRICS = ["reply_match", "aix_first_match"] as const; // L の #811（そのまま送れた割合）の metric 名が決まったら足す
export const WATCH_SCOPES = ["takeuchi", "all"] as const;
export const REGRESS_WINDOW_DAYS = 7;
export const REGRESS_Z = 1.64; // 片側 95%

const ymd = (iso: string) => new Date(Date.parse(iso) + 9 * 36e5).toISOString().slice(0, 10); // JST の日
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const onSet = (sw: string) => new Set(String(sw ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => /=on$/i.test(l)).map((l) => l.replace(/=on$/i, "")));

/** 版の並び（古い順に直す）から、スイッチごとに最後に on になった日（JST）。今 on でない物は入れない */
export function switchOnDays(versions: readonly SwitchVersion[]): Map<string, string> {
  const asc = [...versions].sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at));
  const out = new Map<string, string>();
  let prev = new Set<string>();
  for (const v of asc) {
    const cur = onSet(v.switches);
    for (const k of cur) if (!prev.has(k)) out.set(k, ymd(v.first_seen_at));
    for (const k of prev) if (!cur.has(k)) out.delete(k);
    prev = cur;
  }
  return out;
}

export type Side = { n: number; match: number; days: number };
/** 同じ日・同じ物差しに出所が2つある時（line-watch-eval と self-improve）は番の多い方 */
function dayRows(rows: readonly QualityRow[], metric: string, scope: string): Map<string, { value: number; n: number }> {
  const m = new Map<string, { value: number; n: number }>();
  for (const r of rows) {
    if (r.metric !== metric || r.scope !== scope || r.value == null || !r.n) continue;
    const v = Number(r.value), n = Number(r.n);
    if (!Number.isFinite(v)) continue;
    const old = m.get(r.day);
    if (!old || n > old.n) m.set(r.day, { value: v, n });
  }
  return m;
}
function sideOf(m: Map<string, { value: number; n: number }>, from: string, toExcl: string): Side {
  let n = 0, match = 0, days = 0;
  for (const [d, x] of m) if (d >= from && d < toExcl) { n += x.n; match += (x.value / 100) * x.n; days++; }
  return { n, match: Math.round(match * 10) / 10, days };
}
const pct = (s: Side) => (s.n ? (100 * s.match) / s.n : 0);
/** 比率の差の z（前 − 後）。どちらかが 0 番なら 0 */
export function zDrop(before: Side, after: Side): number {
  if (!before.n || !after.n) return 0;
  const p = (before.match + after.match) / (before.n + after.n);
  const se = Math.sqrt(p * (1 - p) * (1 / before.n + 1 / after.n));
  return se ? (before.match / before.n - after.match / after.n) / se : 0;
}

export type MetricVerdict = { metric: string; scope: string; verdict: "down" | "keep" | "unknown"; before: Side; after: Side; dropPt: number | null; z: number | null; why: string };
/** 1つの物差しを on にした日の前後で比べる。on にした日そのものは混ざるので入れない */
export function compareAround(o: { rows: readonly QualityRow[]; metric: string; scope: string; onDay: string; todayYmd: string; windowDays?: number; minN?: number; dropPt?: number }): MetricVerdict {
  const w = o.windowDays ?? REGRESS_WINDOW_DAYS, minN = o.minN ?? ROLLOUT_MIN_N, line = o.dropPt ?? ROLLOUT_DROP_PT;
  const m = dayRows(o.rows, o.metric, o.scope);
  const before = sideOf(m, addDays(o.onDay, -w), o.onDay);
  const afterEnd = addDays(o.onDay, w + 1) < o.todayYmd ? addDays(o.onDay, w + 1) : o.todayYmd;
  const after = sideOf(m, addDays(o.onDay, 1), afterEnd);
  const base = { metric: o.metric, scope: o.scope, before, after };
  if (before.n < minN || after.n < minN) return { ...base, verdict: "unknown", dropPt: null, z: null, why: `番が少ない（前 ${before.n}番・後 ${after.n}番・各 ${minN} 番から）` };
  const drop = Math.round((pct(before) - pct(after)) * 10) / 10, z = Math.round(zDrop(before, after) * 100) / 100;
  const desc = `前 ${pct(before).toFixed(1)}%（${before.n}番）→ 後 ${pct(after).toFixed(1)}%（${after.n}番）`;
  if (drop >= line && z >= REGRESS_Z) return { ...base, verdict: "down", dropPt: drop, z, why: `${desc}・${drop}pt 下がった（線 ${line}pt・z ${z}）` };
  return { ...base, verdict: "keep", dropPt: drop, z, why: `${desc}・差 ${drop}pt（z ${z}${drop >= line ? "・揺れの内" : ""}）` };
}

export type SwitchVerdict = { name: string; onDay: string; verdict: "down" | "keep" | "unknown"; metrics: MetricVerdict[]; action: "notify_ledger" | "none" };
/** スイッチ1つ: どれか1つの物差しが下がった＝down（知らせて台帳に積む）・全部分からない＝unknown・それ以外 keep */
export function decideSwitchRegress(o: { name: string; onDay: string; rows: readonly QualityRow[]; todayYmd: string; metrics?: readonly string[]; scopes?: readonly string[] }): SwitchVerdict {
  const ms: MetricVerdict[] = [];
  for (const metric of o.metrics ?? WATCH_METRICS) for (const scope of o.scopes ?? WATCH_SCOPES) ms.push(compareAround({ rows: o.rows, metric, scope, onDay: o.onDay, todayYmd: o.todayYmd }));
  const verdict = ms.some((x) => x.verdict === "down") ? "down" : ms.every((x) => x.verdict === "unknown") ? "unknown" : "keep";
  return { name: o.name, onDay: o.onDay, verdict, metrics: ms, action: verdict === "down" ? "notify_ledger" : "none" };
}

/** on にしてから windowDays 日たっていない・前に windowDays 日の物差しが無い物も入れる（unknown になる）。古すぎる on（60日より前）は見ない */
export function switchesToWatch(onDays: ReadonlyMap<string, string>, todayYmd: string, maxAgeDays = 60): Array<{ name: string; onDay: string }> {
  return [...onDays].filter(([, d]) => d >= addDays(todayYmd, -maxAgeDays)).map(([name, onDay]) => ({ name, onDay })).sort((a, b) => b.onDay.localeCompare(a.onDay));
}

/** 同じ日に on にしたスイッチは前後比べで分けられない（本番 11/15 に 41本が一度に on）＝日ごとの束で1つの判定にする */
export function groupByOnDay(items: ReadonlyArray<{ name: string; onDay: string }>): Array<{ name: string; onDay: string; members: string[] }> {
  const m = new Map<string, string[]>();
  for (const x of items) m.set(x.onDay, [...(m.get(x.onDay) ?? []), x.name]);
  return [...m].map(([onDay, members]) => ({ onDay, members: members.sort(), name: members.length === 1 ? members[0] : `${onDay} の束（${members.length}本）` })).sort((a, b) => b.onDay.localeCompare(a.onDay));
}

const JA: Record<string, string> = { reply_match: "返信の一致", aix_first_match: "AIX の一手の一致" };
/** 朝の1枚への1行（案）。下がった物を先に・名前と下がった物差しまで */
export function regressMorningLine(vs: readonly SwitchVerdict[]): string {
  if (!vs.length) return "スイッチの悪化の見張り: 見る物なし";
  const down = vs.filter((v) => v.verdict === "down"), unk = vs.filter((v) => v.verdict === "unknown"), keep = vs.filter((v) => v.verdict === "keep");
  const downTxt = down.slice(0, 3).map((v) => { const m = v.metrics.find((x) => x.verdict === "down")!; return `${v.name}（${v.onDay} on・${JA[m.metric] ?? m.metric}/${m.scope} ${pct(m.before).toFixed(0)}→${pct(m.after).toFixed(0)}%）`; }).join("・");
  return `スイッチの悪化の見張り（on の前後${REGRESS_WINDOW_DAYS}日）: 下がった ${down.length}${down.length ? `＝${downTxt}→知らせて台帳へ（自動では切らない）` : ""}・分からない ${unk.length}（番が少ない）・変わらない ${keep.length}`;
}
