/**
 * 束の材料（human_motion_learn）を読む: 新しい順に上限まで＋上限の外に落ちる「読んだ写真・通常録画」は別枠で必ず読む。
 *
 * ★ 2026-11-20 竹内さん「画像学習した後の書類はどうなったのか」「画像多すぎたらそこでデータくっているのではないか」:
 *   実測: 自動モードの写真が1日 2,000〜3,800行入り、新しい順 10,000行の上限が 11/17 07時で切れていた。
 *   読んだ写真 5,870枚のうち 4,684枚（通常 4,160）が上限の外で、拡張が読む束（source_rows=10000）に入っていなかった。
 *   上限は 3000→6000→10000 と3回上げて同じ形で落ちている → 数を上げずに「学んだ物は上限と別枠」にする。
 */

type Page<T> = PromiseLike<{ data: T[] | null; error: { message?: string | null } | null }>;

export type KeepReadResult<T> = {
  rows: T[];
  error: string | null;
  /** 新しい順が上限に当たったか */
  capped: boolean;
  /** 上限の外から別枠で足した行数 */
  kept: number;
  /** 別枠が読めなかった理由（束は作る・fail-open） */
  keptError: string | null;
};

/**
 * 束を作る時に読む列（写真そのもの shot_b64 は読まない。表に入った写真は1行最大 2.9MB）。
 *   /api/human-learn-profile・/api/cron/human-learn-brain の列の和。
 */
export const BUNDLE_MOTION_COLS = [
  "id", "created_at", "site", "mode", "ext_version", "install_id", "ops",
  "moves_n", "move_speed_px_s", "move_curve", "move_ms", "move_dist", "gap_ms",
  "points_n", "point_x", "point_y", "point_fields",
  "scrolls_n", "scroll_dy", "kinds", "fields", "field_order", "shot_ops", "shot_learn",
  "opens", "open_kinds",
  "shot_taken", "shot_key", "shot_w", "shot_h",
] as const;

/** 上限の外で必ず残す行（読んだ写真・人の手本）の条件。PostgREST の or 句 */
export const KEEP_OUTSIDE_CAP_OR = "shot_learn.not.is.null,mode.eq.normal";

export async function readRowsKeepingLearned<T extends { created_at?: string | null }>(o: {
  newest: (from: number, to: number) => Page<T>;
  /** edgeIso より古い（lt）行のうち、残す物だけを新しい順で返す */
  olderKept: (edgeIso: string, from: number, to: number) => Page<T>;
  maxRows: number;
  maxKept?: number;
  pageSize?: number;
}): Promise<KeepReadResult<T>> {
  const size = Math.max(1, o.pageSize ?? 1000);
  const maxKept = Math.max(0, o.maxKept ?? 20_000);
  const rows: T[] = [];
  let capped = false;
  for (let i = 0; i < o.maxRows; i += size) {
    const r = await o.newest(i, i + size - 1);
    if (r.error) return { rows, error: String(r.error.message ?? "select_failed"), capped: false, kept: 0, keptError: null };
    const got = r.data ?? [];
    rows.push(...got);
    if (got.length < size) break;
    if (rows.length >= o.maxRows) capped = true;
  }
  if (!capped || maxKept === 0) return { rows, error: null, capped, kept: 0, keptError: null };
  const edge = rows.length ? String(rows[rows.length - 1].created_at ?? "") : "";
  if (!edge) return { rows, error: null, capped, kept: 0, keptError: "edge_missing" };
  let kept = 0;
  for (let i = 0; i < maxKept; i += size) {
    const r = await o.olderKept(edge, i, i + size - 1);
    if (r.error) return { rows, error: null, capped, kept, keptError: String(r.error.message ?? "kept_failed").slice(0, 160) };
    const got = r.data ?? [];
    rows.push(...got);
    kept += got.length;
    if (got.length < size) break;
  }
  return { rows, error: null, capped, kept, keptError: null };
}
