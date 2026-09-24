// app/lib/pickup-best.ts（純関数・依存なし・画面とサーバーで共用）
// 「🔍 画像で分析」の結果から、お客様ごとに**回（バッチ）をまたいで**一番条件に合う物件を1つ出す。
//
// 2026-09-24 竹内「1番オススメの物件全体の中で送る。今回は物件数多かったからか出ていなかった」:
//   実例: 同じお客様に 1分以内に3回に分かれて届いた（1件・10件・1件）。👑 は1回分ずつ計算していたので
//   10件の回に「エステムコート 100点」、1件の回に「ガーディアンズ 100点」と別々の吹き出しに埋もれ、全体の一番がどこにも無かった。
//   → 最新の回から windowHours（既定 6時間）以内の回を「1つの探し物」として、その中で一番を出す。
// 並び（pickBest と同じ考え＋回をまたぐ分）: 点 → 上限前の点（match_raw）→ 🌟★/🌟 → 新しい回 → 順位が上
// ⚠ サーバーの部品（DeepSeek・DB）を import しない（画面 PickupReview.tsx からも使う）

export type BestCandidateRow = {
  id: number;
  batch_id: string;
  created_at: string;
  rank: number;
  status: string;
  recommended: number;
  property_name: string;
  room_no?: string | null;
  image_analysis?: { match?: unknown; match_raw?: unknown; [k: string]: unknown } | null;
};

export type CustomerBest = {
  id: number;
  batch_id: string;
  rank: number;
  property_name: string;
  room_no: string | null;
  match: number;
  /** 同じ点の他の物件（id） */
  tied_ids: number[];
  tied_names: string[];
  /** 対象の中で点が付いた件数／分析したが点が付かなかった件数（資料から読めず）／まだ分析していない件数 */
  scored: number;
  unscored: number;
  not_analyzed: number;
  /** 対象にした回の数 */
  batches: number;
};

export const CUSTOMER_BEST_WINDOW_HOURS = 6;

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 全体の一番（点が1件も無ければ null）。rows はお客様1人分（何回分でもよい） */
export function pickCustomerBest(rows: ReadonlyArray<BestCandidateRow>, opts?: { windowHours?: number }): CustomerBest | null {
  if (!rows.length) return null;
  const windowMs = (opts?.windowHours ?? CUSTOMER_BEST_WINDOW_HOURS) * 3600_000;
  const latest = Math.max(...rows.map((r) => Date.parse(r.created_at)).filter((n) => Number.isFinite(n)));
  if (!Number.isFinite(latest)) return null;
  const inWindow = rows.filter((r) => r.status === "pending" && latest - Date.parse(r.created_at) <= windowMs);
  const scored = inWindow.filter((r) => numOrNull(r.image_analysis?.match) != null);
  if (!scored.length) return null;
  const m = (r: BestCandidateRow) => numOrNull(r.image_analysis?.match) as number;
  const raw = (r: BestCandidateRow) => numOrNull(r.image_analysis?.match_raw) ?? m(r);
  const sorted = scored.slice().sort((a, z) =>
    (m(z) - m(a)) || (raw(z) - raw(a)) || (z.recommended - a.recommended)
    || (Date.parse(z.created_at) - Date.parse(a.created_at)) || (a.rank - z.rank) || (a.id - z.id));
  const best = sorted[0];
  const tied = sorted.slice(1).filter((r) => m(r) === m(best));
  return {
    id: best.id, batch_id: best.batch_id, rank: best.rank, property_name: best.property_name, room_no: best.room_no ?? null,
    match: m(best),
    tied_ids: tied.map((r) => r.id), tied_names: tied.map((r) => r.property_name),
    scored: scored.length,
    unscored: inWindow.filter((r) => r.image_analysis && numOrNull(r.image_analysis.match) == null).length,
    not_analyzed: inWindow.filter((r) => !r.image_analysis).length,
    batches: new Set(inWindow.map((r) => r.batch_id)).size,
  };
}
