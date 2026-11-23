// app/lib/route-station-trust.ts — 申込までの地図の駅ごとの数（一致と進み）と、弱い駅の見つけ方（純関数・DB/LLM なし）
//
// 2026-11-23 作業員A（竹内さん 11/23「申込までの地図ちゃんと統括と連携させる 弱い部分あれば強化するように仕組みとする 細部までこだわって徹底的に強化していく」・台帳 #650）
//   ⚠ 同じ日の竹内さんの決定（KB 2d1c4c74）で向きを直した: 番の一手を決めるのはブレイン・地図は道筋（今どの駅・申込までの残り・分かれ道からの戻り方・中期と長期）。
//     1版の「駅ごとの信頼で地図の一手を統括に渡す（ROUTE_TO_BRIEF_BY_TRUST）」は取り下げた（地図は一手を上書きしない）。
//   物差し（毎朝の1枚・作業員N2 と P の名前）:
//     route:station:<駅>:map … 地図の次の一手の候補と竹内さん本人の一手の一致（R の routeAgreement の合う側・並べて見るだけ）
//     route:station:<駅>:progress … 竹内さん本人の一手の後に申込へ近づいた番の割合（advanced＋分かれ道から本線の駅に戻った番）
//   弱い駅（台帳に自動で足す）は進みで見る: n ≥ 10 で、前の週より進みが 5pt 以上下がった駅か、止まり＋離れが過半数の駅。
//   駅の名前は P の地図の木（route:next_match_60d）の葉と同じ（分かれ道があれば「分:<分かれ道>」・無ければ駅の id）
export const ROUTE_STATION_MIN_N = 10;
const ROUTE_GOOD = new Set(["aix_match", "promise_match", "reply_match", "reply_invite"]);
const MAIN_STATIONS = new Set(["inquiry", "hearing", "pickup", "proposing", "interested", "estimate", "viewing_arrange", "viewing_scheduled", "viewed", "apply_prep", "applying"]);

/** 地図の位置 → 駅の名前（P の地図の葉と同じ） */
export function stationKeyOf(loc: { node?: string | null; branch?: string | null } | null | undefined): string | null {
  if (!loc) return null;
  if (loc.branch) return `分:${loc.branch}`;
  return loc.node ? String(loc.node) : null;
}

/** R の audit-route-progress-takeuchi の番ごとの行（使う欄だけ） */
/** afterBranch: 番の後の分かれ道（R の json に欄がある時だけ・null＝分かれ道が閉じた）。欄が無い番は「本線に戻った」を数えない（後の駅だけでは分かれ道が閉じたか分からない） */
export type RouteStationRow = { node: string | null; branch: string | null; agree: string; outcome: string; after: string | null; afterBranch?: string | null;
  /** 番の時刻（ISO）と、R の json の detail（内覧の日「10/28(水)17:00」）。内覧予定の駅で内覧の日がまだ来ていないかを見る */
  at?: string | null; detail?: string | null };
/** 内覧の日（detail の M/D）が番の日（JST）以降か。読めなければ false（今まで通り止まりに数える） */
export function viewingNotYet(r: Pick<RouteStationRow, "at" | "detail">): boolean {
  const m = String(r.detail ?? "").match(/(\d{1,2})\/(\d{1,2})/);
  const t = Date.parse(String(r.at ?? ""));
  if (!m || !Number.isFinite(t)) return false;
  const j = new Date(t + 9 * 3600e3);
  const y = j.getUTCFullYear(), mo = Number(m[1]), d = Number(m[2]);
  const yy = mo < j.getUTCMonth() + 1 - 6 ? y + 1 : y; // 年をまたぐ（12月の番で1月の内覧）
  return Date.UTC(yy, mo - 1, d) >= Date.UTC(y, j.getUTCMonth(), j.getUTCDate());
}
export type StationStat = {
  station: string; n: number; map: number; mapRate: number | null;
  advanced: number; branch_return: number; engaged: number; stuck: number; back: number; left: number; progress: number; progressRate: number | null;
};
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

/** 駅ごとの一致と進み（分かれ道の番は、後の駅が本線の駅なら「本線に戻った」・進んだ番と重ねない） */
export function stationStatsOf(rows: ReadonlyArray<RouteStationRow>): StationStat[] {
  const by = new Map<string, StationStat>();
  for (const r of rows) {
    const k = stationKeyOf(r); if (!k) continue;
    const s = by.get(k) ?? { station: k, n: 0, map: 0, mapRate: null, advanced: 0, branch_return: 0, engaged: 0, stuck: 0, back: 0, left: 0, progress: 0, progressRate: null };
    s.n++;
    if (ROUTE_GOOD.has(r.agree)) s.map++;
    if (r.outcome === "advanced") s.advanced++;
    else if (r.branch && r.afterBranch === null && r.after && MAIN_STATIONS.has(r.after)) s.branch_return++;
    else if (r.outcome === "engaged") s.engaged++;
    // N2 の照らし①: 内覧予定の駅で内覧の日がまだ来ていない番は「止まった」でなく内覧の日待ち（続く）に数える（日が過ぎても動かない番だけ止まり）
    else if (r.outcome === "stuck" && r.node === "viewing_scheduled" && !r.branch && viewingNotYet(r)) s.engaged++;
    else if (r.outcome === "stuck") s.stuck++;
    else if (r.outcome === "back") s.back++;
    else if (r.outcome === "left") s.left++;
    by.set(k, s);
  }
  return [...by.values()].map((s) => ({ ...s, mapRate: pct(s.map, s.n), progress: s.advanced + s.branch_return, progressRate: pct(s.advanced + s.branch_return, s.n) })).sort((a, b) => b.n - a.n);
}

/** 毎朝の1枚の行（route:station:<駅>:map・:progress・n が minN 未満の駅も出す＝並べて見る） */
export function stationMetricRowsOf(stats: ReadonlyArray<StationStat>): Array<{ metric: string; value: number | null; n: number }> {
  return stats.flatMap((s) => [
    { metric: `route:station:${s.station}:map`, value: s.mapRate, n: s.n },
    { metric: `route:station:${s.station}:progress`, value: s.progressRate, n: s.n },
  ]);
}

export type WeakStation = { station: string; reasons: string[]; n: number; progressRate: number | null };
/** 弱い駅: n ≥ minN で ①前の週より進みが drop pt 以上下がった ②止まり＋離れが過半数 */
export function weakStationsOf(now: ReadonlyArray<StationStat>, prev: ReadonlyArray<{ station: string; n: number; progressRate: number | null }> = [], o: { minN?: number; drop?: number } = {}): WeakStation[] {
  const minN = o.minN ?? ROUTE_STATION_MIN_N, drop = o.drop ?? 5;
  const pm = new Map(prev.map((p) => [p.station, p]));
  const out: WeakStation[] = [];
  for (const s of now) {
    if (s.n < minN) continue;
    const reasons: string[] = [];
    const p = pm.get(s.station);
    if (p && p.n >= minN && p.progressRate != null && s.progressRate != null && p.progressRate - s.progressRate >= drop) reasons.push(`進みが前の週より下がった（${p.progressRate}%→${s.progressRate}%）`);
    if ((s.stuck + s.left) * 2 > s.n) reasons.push(`止まり＋離れが過半数（${s.stuck + s.left}/${s.n}）`);
    if (reasons.length) out.push({ station: s.station, reasons, n: s.n, progressRate: s.progressRate });
  }
  return out.sort((a, b) => (a.progressRate ?? 0) - (b.progressRate ?? 0));
}

/** 台帳の行の題（同じ駅の行は題の頭で見分ける） */
export const stationGapPrefix = (station: string) => `申込までの地図の駅 ${station}:`;
/** 足す行（同じ駅の行が開いていれば足さない・持ち主の案つき） */
export function stationGapsToAdd(weak: ReadonlyArray<WeakStation>, openTitles: ReadonlyArray<string>, ownerOf: (station: string) => string = () => "作業員A"): Array<{ station: string; title: string; owner: string; next: string }> {
  return weak.filter((w) => !openTitles.some((t) => t.startsWith(stationGapPrefix(w.station))))
    .map((w) => ({ station: w.station, title: `${stationGapPrefix(w.station)} ${w.reasons.join("・")}（n=${w.n}・竹内さん本人の一手の後の進み）`, owner: ownerOf(w.station),
      next: "駅の中の状態（ROUTE_SUBSTATE）とお客様の番の型で割り、止まった・離れた番の竹内さん本人の一手と地図の道筋（残りの駅・戻り方）を読む。過半数の形だけ既定 off で直す" }));
}
