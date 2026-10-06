// app/lib/pickup-detail-window.ts — 売上サポのお客様の詳細を「直近24時間の回」から読む決まり（純関数）
//
// 2026-10-06 ⑫ 竹内「お客さんの詳細をAIXツールで開くときもおもいので、詳細で開くときは24時間以内に限定して最初読み取るのはどうか、
//   今恐らくすべてを読み取ろうとしているからかなり重い」
//   測った（本番・yasuki）: 詳細は 286KB・約4秒。お客様のピックアップの行（最大300行）を画像の読み・分析・設備・資料の表の JSON ごと全部読み、
//   画面に出すのは直近3回だけだった。→ 先に軽い列（id・時刻・回・状態）だけ読んで出す回を決め、重い列はその回の行だけ読む。
//   24時間以内の回が無いお客様は一番新しい回だけ（何も出ないと困る）。もっと前は「▲ もっと前のピックアップを見る」で読む（今まで通り）
import { groupPickupRounds } from "./pickup-card-view";

export type LightPickupRow = { id: number; created_at: string; batch_id: string; status: string | null; site?: string | null };

export const DETAIL_FIRST_HOURS = 24;

/**
 * 出す回の行の id と、もっと前の回があるか・未確認の数（全部の行で数える）を返す。
 *   hours 以内に届いた行のある回（最大 maxRounds 回）。無ければ一番新しい1回
 */
export function chooseDetailRowIds(
  rows: ReadonlyArray<LightPickupRow>,
  roundOf: ReadonlyMap<string, string>,
  opts: { hours?: number; nowMs?: number; maxRounds?: number } = {},
): { ids: number[]; hasMore: boolean; pending: number; rounds: number } {
  const hours = opts.hours ?? DETAIL_FIRST_HOURS;
  const nowMs = opts.nowMs ?? Date.now();
  const maxRounds = opts.maxRounds ?? 3;
  const byBatch = new Map<string, { batch_id: string; created_at: string; site: string | null; round_id: string | null; ids: number[] }>();
  for (const r of rows) {
    const b = byBatch.get(r.batch_id) ?? { batch_id: r.batch_id, created_at: r.created_at, site: r.site ?? null, round_id: roundOf.get(r.batch_id) ?? null, ids: [] };
    if (r.created_at < b.created_at) b.created_at = r.created_at;
    b.ids.push(r.id);
    byBatch.set(r.batch_id, b);
  }
  const rounds = groupPickupRounds([...byBatch.values()]);
  const since = nowMs - hours * 3600_000;
  let chosen = rounds.filter((r) => Date.parse(r.last_at) >= since).slice(-maxRounds);
  if (!chosen.length && rounds.length) chosen = rounds.slice(-1);
  const ids = chosen.flatMap((r) => r.batches.flatMap((b) => b.ids));
  return { ids, hasMore: rounds.length > chosen.length, pending: rows.filter((r) => r.status === "pending").length, rounds: chosen.length };
}
