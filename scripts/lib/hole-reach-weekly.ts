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
