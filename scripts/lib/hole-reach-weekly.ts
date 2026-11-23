// scripts/lib/hole-reach-weekly.ts — 地図の穴（自動で足した台帳の行）が統括に届いているかの週1回の一覧（純関数・作業員N2・2026-11-23・竹内さんの決定 KB 0f38f47f）
//   self-improve が週に1回（JST の月曜の回）、開いている「地図の穴:」の行を読み、統括に届いていない（未確認・届いていない・欄が無い）物を統括役に出す。
//   欄 work_items.conductor_reach が無い DB では、次の一手の頭の「［統括に届いているか: X］」を読む（found-gap-ledger が列の無い時に書く形）
export type HoleRow = { id: number; title: string; owner: string | null; stage: string; conductor_reach?: string | null; next_step?: string | null };
export type HoleReach = "未確認" | "届いている" | "届いていない";

/** 週に1回の回か（JST の月曜・既定。HOLE_REACH_WEEKDAY=0〜6 で曜日を変える） */
export function isHoleReachDay(nowMs: number, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  const want = Number(env.HOLE_REACH_WEEKDAY ?? "1");
  return new Date(nowMs + 9 * 3_600_000).getUTCDay() === (Number.isInteger(want) && want >= 0 && want <= 6 ? want : 1);
}

/** 行の「統括に届いているか」（列 → 次の一手の頭の印 → 未確認） */
export function reachOfRow(r: HoleRow): HoleReach {
  const c = String(r.conductor_reach ?? "").trim();
  if (c === "未確認" || c === "届いている" || c === "届いていない") return c;
  const m = /［統括に届いているか: (未確認|届いている|届いていない)］/.exec(String(r.next_step ?? ""));
  return (m?.[1] as HoleReach | undefined) ?? "未確認";
}

/** 統括に届いていない穴の一覧（開いている「地図の穴:」の行だけ・持ち主ごとに並べる） */
export function holesNotReached(rows: ReadonlyArray<HoleRow>): Array<HoleRow & { reach: HoleReach }> {
  return rows
    .filter((r) => r.title.startsWith("地図の穴:") && !["done", "dropped"].includes(r.stage))
    .map((r) => ({ ...r, reach: reachOfRow(r) }))
    .filter((r) => r.reach !== "届いている")
    .sort((a, b) => String(a.owner ?? "").localeCompare(String(b.owner ?? "")) || a.id - b.id);
}

/**
 * 2026-11-23 統括役の決め（案b・作業員A の弱い駅の台帳を地図の穴に一本化）: 申込までの地図の進みの根（route:progress_60d）で、駅の段の「弱い駅」を穴の理由にする（純関数）。
 *   線は A の weakStationsOf と同じ: n ≥ 10 で ①前の週の進み（quality_daily の route:station:<駅>:progress・7日前）より 5pt 以上下がった ②止まり＋離れが過半数。
 *   弱い駅は駅の鍵で1つの穴にまとめる（その駅の下の葉の穴は出さない＝同じ駅を2回足さない）
 */
export type StationNodeLite = { key: string; parent: string | null; depth: number; dim: string | null; val: string | null; n: number; ok: number; misses: number; value: number | null };
export function weakStationHolesOf(nodes: ReadonlyArray<StationNodeLite>, prev: ReadonlyMap<string, { n: number; value: number | null }>, o: { minN?: number; drop?: number } = {}): Array<{ key: string; station: string; n: number; misses: number; reasons: string[] }> {
  const minN = o.minN ?? 10, drop = o.drop ?? 5;
  const out: Array<{ key: string; station: string; n: number; misses: number; reasons: string[] }> = [];
  for (const s of nodes.filter((x) => x.dim === "station" && x.val)) {
    if (s.n < minN) continue;
    const kids = nodes.filter((x) => x.parent === s.key && x.dim === "miss");
    const stuckLeft = kids.filter((x) => x.val === "stuck" || x.val === "left").reduce((a, x) => a + x.n, 0);
    const reasons: string[] = [];
    const p = prev.get(String(s.val));
    if (p && p.n >= minN && p.value != null && s.value != null && p.value - s.value >= drop) reasons.push(`進みが前の週より下がった（${p.value}%→${s.value}%）`);
    if (stuckLeft * 2 > s.n) reasons.push(`止まり＋離れが過半数（${stuckLeft}/${s.n}）`);
    if (reasons.length) out.push({ key: s.key, station: String(s.val), n: s.n, misses: s.misses, reasons });
  }
  return out.sort((a, b) => b.misses - a.misses);
}

/** 1回に新しく足す穴の数の上限（統括役 11/23: 初めての夜は上位5行・翌晩から残り）。MAP_HOLES_MAX_NEW で変える（0＝上限なし） */
export function holesMaxNew(nowMs: number, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): number {
  const v = env.MAP_HOLES_MAX_NEW;
  if (v != null && v.trim() !== "" && Number.isFinite(Number(v))) return Math.max(0, Number(v));
  return new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10) <= "2026-11-24" ? 5 : 0;
}