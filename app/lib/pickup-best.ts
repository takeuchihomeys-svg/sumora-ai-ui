// app/lib/pickup-best.ts（純関数・依存なし・画面とサーバーで共用）
// 「🔍 画像で分析」の結果から、お客様ごとに**回（バッチ）をまたいで**一番条件に合う物件を1つ出す。
//
// 2026-09-24 竹内「1番オススメの物件全体の中で送る。今回は物件数多かったからか出ていなかった」:
//   実例: 同じお客様に 1分以内に3回に分かれて届いた（1件・10件・1件）。👑 は1回分ずつ計算していたので
//   10件の回に「エステムコート 100点」、1件の回に「ガーディアンズ 100点」と別々の吹き出しに埋もれ、全体の一番がどこにも無かった。
//   → 最新の回から windowHours（既定 6時間）以内の回を「1つの探し物」として、その中で一番を出す。
// 並び（pickBest と同じ考え＋回をまたぐ分）: 点 → 上限前の点（match_raw）→「合う」の数 → 判定（通す＞保留＞外す候補・2026-09-25）→ 🌟★/🌟 → 新しい回 → 順位が上
// 2026-09-24 竹内「前回の反証で出た点も直す」: 同点は「合う」の数が多い方を上に（判定できた希望1つで100点の物件が、5つ合って100点の物件より上に来ていた）
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
  /** 判定（pass / hold / drop）。2026-09-25 同じ点の時は保留・外す候補より通す物を上に */
  verdict?: string | null;
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
  /** 物件と資料が一致せず点を出さなかった件数（要確認）。2026-09-24 竹内「食い違いは点を出さず『要確認』」 */
  needs_check: number;
  not_analyzed: number;
  /** 対象にした回の数 */
  batches: number;
};

export const CUSTOMER_BEST_WINDOW_HOURS = 6;

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 「合う」（ok）の数。ok_count が無い古い結果は checks から数える */
export function okCountOf(obj: object | null | undefined): number {
  const a = obj as { ok_count?: unknown; checks?: unknown } | null | undefined;
  if (!a) return 0;
  const n = numOrNull(a.ok_count);
  if (n != null) return n;
  return Array.isArray(a.checks) ? a.checks.filter((c) => (c as { result?: unknown })?.result === "ok").length : 0;
}

/**
 * 判定の順（同じ点の時）: 通す → 判定なし → 保留 → 外す候補。
 * 2026-09-25 YUMA テスト（お客様C）: 画像の点が全件 100 で並んだ時、🌟★ を引き継いだ保留の物件（敷礼あり・利益が出ない）に 👑 が付いていた
 */
export function verdictOrder(r: Pick<BestCandidateRow, "verdict">): number {
  return r.verdict === "pass" ? 0 : r.verdict === "hold" ? 2 : r.verdict === "drop" ? 3 : 1;
}

const isNeedsCheck = (r: BestCandidateRow) => (r.image_analysis?.review as { status?: unknown } | undefined)?.status === "要確認";

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
    (m(z) - m(a)) || (raw(z) - raw(a)) || (okCountOf(z.image_analysis) - okCountOf(a.image_analysis)) || (verdictOrder(a) - verdictOrder(z)) || (z.recommended - a.recommended)
    || (Date.parse(z.created_at) - Date.parse(a.created_at)) || (a.rank - z.rank) || (a.id - z.id));
  const best = sorted[0];
  const tied = sorted.slice(1).filter((r) => m(r) === m(best));
  return {
    id: best.id, batch_id: best.batch_id, rank: best.rank, property_name: best.property_name, room_no: best.room_no ?? null,
    match: m(best),
    tied_ids: tied.map((r) => r.id), tied_names: tied.map((r) => r.property_name),
    scored: scored.length,
    unscored: inWindow.filter((r) => r.image_analysis && numOrNull(r.image_analysis.match) == null && !isNeedsCheck(r)).length,
    needs_check: inWindow.filter(isNeedsCheck).length,
    not_analyzed: inWindow.filter((r) => !r.image_analysis).length,
    batches: new Set(inWindow.map((r) => r.batch_id)).size,
  };
}
