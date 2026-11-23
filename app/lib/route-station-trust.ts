// app/lib/route-station-trust.ts — 申込までの地図の「駅ごとの信頼」（純関数・DB/LLM なし）
//
// 2026-11-23 作業員A（竹内さん 11/23「申込までの地図ちゃんと統括と連携させる 弱い部分あれば強化するように仕組みとする 細部までこだわって徹底的に強化していく」・台帳 #650）:
//   地図の次の一手とブレインの最終の道が違った番 188（60日）で、竹内さん本人の一手に近いのはブレイン 113・地図 25＝地図をそのまま統括に渡すと引っぱる。
//   → 統括（ROUTE_TO_BRIEF の指示書）には「その駅で地図が竹内さん本人に近い所」だけ渡す。駅ごとに 地図の一致 と ブレインの一致 を比べ、
//     地図が上回る・n が足りる駅だけ渡す（下回る駅は参考の印だけ）。地図が直って駅の一致が上がれば、その駅は自動で統括に届く。
//   駅の名前は P の地図の木（route:next_match_60d）の葉と同じ（分かれ道があれば「分:<分かれ道>」・無ければ駅の id）。
//   スイッチ ROUTE_TO_BRIEF_BY_TRUST（既定 off＝今の ROUTE_TO_BRIEF のまま）。駅ごとの数は毎朝の数（#653）が作る。
type Env = Record<string, string | undefined>;
export const ROUTE_TRUST_MIN_N = 10;

export function routeToBriefByTrustOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.ROUTE_TO_BRIEF_BY_TRUST ?? "").trim().toLowerCase() === "on";
}

/** 地図の位置 → 駅の名前（P の地図の葉と同じ） */
export function stationKeyOf(loc: { node?: string | null; branch?: string | null } | null | undefined): string | null {
  if (!loc) return null;
  if (loc.branch) return `分:${loc.branch}`;
  return loc.node ? String(loc.node) : null;
}

export type StationTurn = { station: string; mapMatch: boolean; brainMatch: boolean };
export type StationStat = { station: string; n: number; map: number; brain: number; mapRate: number; brainRate: number };

/** 番ごとの「地図の次の一手が竹内さん本人に合ったか」「ブレインの最終の道が合ったか」から駅ごとの数 */
export function stationStatsOf(turns: ReadonlyArray<StationTurn>): StationStat[] {
  const by = new Map<string, { n: number; map: number; brain: number }>();
  for (const t of turns) { const o = by.get(t.station) ?? { n: 0, map: 0, brain: 0 }; o.n++; if (t.mapMatch) o.map++; if (t.brainMatch) o.brain++; by.set(t.station, o); }
  return [...by].map(([station, o]) => ({ station, ...o, mapRate: Math.round((o.map / o.n) * 1000) / 10, brainRate: Math.round((o.brain / o.n) * 1000) / 10 })).sort((a, b) => b.n - a.n);
}

/** 統括に地図の次の一手を渡してよい駅（n ≥ minN かつ 地図の一致がブレインの一致を上回る） */
export function trustedStationsOf(stats: ReadonlyArray<StationStat>, o: { minN?: number } = {}): Set<string> {
  const minN = o.minN ?? ROUTE_TRUST_MIN_N;
  return new Set(stats.filter((s) => s.n >= minN && s.map > s.brain).map((s) => s.station));
}

/** この番の駅に地図の次の一手を統括へ渡すか（off の時は今まで通り true＝ROUTE_TO_BRIEF の判断のまま） */
export function routeTrustAllows(station: string | null, trusted: ReadonlySet<string> | null | undefined, env?: Env): { allow: boolean; mark: "trusted" | "reference" | "off" } {
  if (!routeToBriefByTrustOn(env)) return { allow: true, mark: "off" };
  if (station && trusted?.has(station)) return { allow: true, mark: "trusted" };
  return { allow: false, mark: "reference" };
}

export type WeakStation = { station: string; reasons: string[]; n: number; mapRate: number; brainRate: number };
/**
 * 弱い駅（毎朝の自己改善）: n ≥ minN の駅のうち ①前の週より地図の一致が drop pt 以上下がった ②地図がブレインに負けている
 * （①②のどちらか）。前の週の数が無い駅は②だけで見る
 */
export function weakStationsOf(now: ReadonlyArray<StationStat>, prev: ReadonlyArray<StationStat> = [], o: { minN?: number; drop?: number } = {}): WeakStation[] {
  const minN = o.minN ?? ROUTE_TRUST_MIN_N, drop = o.drop ?? 5;
  const pm = new Map(prev.map((p) => [p.station, p]));
  const out: WeakStation[] = [];
  for (const s of now) {
    if (s.n < minN) continue;
    const reasons: string[] = [];
    const p = pm.get(s.station);
    if (p && p.n >= minN && p.mapRate - s.mapRate >= drop) reasons.push(`地図の一致が前の週より下がった（${p.mapRate}%→${s.mapRate}%）`);
    if (s.map < s.brain) reasons.push(`地図がブレインに負けている（地図 ${s.mapRate}%・ブレイン ${s.brainRate}%）`);
    if (reasons.length) out.push({ station: s.station, reasons, n: s.n, mapRate: s.mapRate, brainRate: s.brainRate });
  }
  return out.sort((a, b) => (a.mapRate - a.brainRate) - (b.mapRate - b.brainRate));
}

/** 台帳の行の題（同じ駅の行は題の頭「申込までの地図の駅 <駅>:」で見分ける） */
export const stationGapPrefix = (station: string) => `申込までの地図の駅 ${station}:`;
/** 足す行（同じ駅の行が開いていれば足さない・持ち主の案つき） */
export function stationGapsToAdd(weak: ReadonlyArray<WeakStation>, openTitles: ReadonlyArray<string>, ownerOf: (station: string) => string = () => "作業員A"): Array<{ station: string; title: string; owner: string }> {
  return weak.filter((w) => !openTitles.some((t) => t.startsWith(stationGapPrefix(w.station))))
    .map((w) => ({ station: w.station, title: `${stationGapPrefix(w.station)} ${w.reasons.join("・")}（n=${w.n}）`, owner: ownerOf(w.station) }));
}
