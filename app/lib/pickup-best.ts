// app/lib/pickup-best.ts（純関数・依存は純関数の image-wants.ts だけ・画面とサーバーで共用）
// 「🔍 画像で分析」の結果から、お客様ごとに**回（バッチ）をまたいで**一番条件に合う物件を1つ出す。
//
// 2026-09-24 竹内「1番オススメの物件全体の中で送る。今回は物件数多かったからか出ていなかった」:
//   実例: 同じお客様に 1分以内に3回に分かれて届いた（1件・10件・1件）。👑 は1回分ずつ計算していたので
//   10件の回に「エステムコート 100点」、1件の回に「ガーディアンズ 100点」と別々の吹き出しに埋もれ、全体の一番がどこにも無かった。
//   → 最新の回から windowHours（既定 6時間）以内の回を「1つの探し物」として、その中で一番を出す。
// 並び（pickBest と同じ考え＋回をまたぐ分）: 点 → 上限前の点（match_raw）→「合う」の数 → 判定（通す＞保留＞外す候補・2026-09-25）→ 🌟★/🌟 → 新しい回 → 順位が上
// 2026-09-24 竹内「前回の反証で出た点も直す」: 同点は「合う」の数が多い方を上に（判定できた希望1つで100点の物件が、5つ合って100点の物件より上に来ていた）
// ⚠ サーバーの部品（DeepSeek・DB）を import しない（画面 PickupReview.tsx からも使う）。image-wants.ts も純関数（import なし）
//
// 2026-09-25 竹内「画像で分析必要なお客さんなら画像で分析の点、画像で分析不要なお客さんは判定した点」:
//   👑 の決め方をお客様ごとに分ける（basis）。画面（詳細 API の best）と「完了」のまとめ（property_pickup_completions.best_id）は
//   どちらもこの pickCustomerBest を同じ basis で呼ぶ（別々に並べると 👑 が食い違う）。
//   | お客様                                          | basis | 並び                                                                          |
//   | 画像で分析が必要（imageAnalysisNeed=recommended） | image | 画像の点 → 上限前の点 →「合う」の数 → 判定 → 判定の点 → 🌟 → 新しい回 → 順位 |
//   |   └ 画像の点が1件も無い時                        | score | 判定の点で補う（下の段）                                                      |
//   | 画像で分析が不要（optional / none）               | score | 判定の点 → 判定 → 🌟★/🌟 → 新しい回 → 順位（外す候補は 👑 にしない）          |
//   |   └ 判定の点が1件も無い時（古い行）              | image | 画像の点があればそれ                                                          |
//   - 画像が要るお客様で、画像の点がある物件と無い物件が混ざる時は、点がある物件だけで決める
//     （画像でしか分からない希望を確かめていない物件は「一番条件に合う」と言えない・点の尺度も違うので1本の並びで混ぜない）
//   - 保留・外す候補は、同じ点の時に通す物件より先に 👑 にしない（前の決まり・verdictOrder）。判定の点で決める時は外す候補を候補にしない
import { imageAnalysisNeed, extractImageWants, dedupeWantsByTopic, type ImageWant, type ImageAnalysisNeed } from "./image-wants";

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
  /** 判定の点（property-brain の score）。2026-09-25 画像で分析が不要なお客様の 👑 はこの点で決める */
  score?: number | null;
  image_analysis?: { match?: unknown; match_raw?: unknown; [k: string]: unknown } | null;
};

export type CustomerBest = {
  id: number;
  batch_id: string;
  rank: number;
  property_name: string;
  room_no: string | null;
  /** 画像で分析の点（無い物件は null） */
  match: number | null;
  /** 判定の点（無い物件は null） */
  score: number | null;
  /** 何で 👑 を決めたか（image＝画像で分析の点／score＝判定の点）。お客様の決まりの点が無くて補った時は実際に使った方 */
  basis: BestBasis;
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

export type BestBasis = "image" | "score";

/** お客様の決まり: 画像で分析が必要（recommended）なら画像の点、それ以外は判定の点 */
export function bestBasisFor(need: Pick<ImageAnalysisNeed, "level"> | null | undefined): BestBasis {
  return need?.level === "recommended" ? "image" : "score";
}

type CondLike = { preferences?: string | null; ng_points?: string | null; other_requests?: string | null; additional_conditions?: string | null } | null;

/**
 * お客様が画像で分析が必要か（画面の「🔍 画像で分析 推奨」と同じ判定）。
 * 分析済みの回に保存した希望（会話・訴求込み）があればそれ、無ければ条件欄だけで軽く判定（決定論・DeepSeek は呼ばない）。
 * 詳細 API（画面の 👑）と「完了」のまとめ（pickup-complete-server の best_id）が同じ物を使う
 */
export function customerImageNeed(
  rows: ReadonlyArray<{ image_analysis?: { wants?: unknown; [k: string]: unknown } | null }>,
  cond: CondLike,
): ImageAnalysisNeed & { from: "analysis" | "conditions" } {
  const saved = rows.map((r) => r.image_analysis?.wants).find((w): w is ImageWant[] => Array.isArray(w) && w.length > 0) ?? null;
  const wants = saved ?? dedupeWantsByTopic(extractImageWants({ conditions: cond }));
  return { ...imageAnalysisNeed(wants), from: saved ? "analysis" : "conditions" };
}

/**
 * 1回（まとめの回）の「一番オススメ」の id（純関数・画面のカードの 👑 と並びの先頭）。
 * 2026-09-25 竹内（野口さんの回: 162点に🌟★・164点に🌟）: 🌟★ は DeepSeek が回ごとに選んだ印で点と連動していなかった。
 *   → 一番オススメは 👑 と同じ決まり（pickCustomerBest・画像で分析が要るお客様は画像の点・要らないお客様は判定の点）に1つにまとめる。
 *   DeepSeek の🌟★／🌟 は点が並んだ時の順番（pickCustomerBest の tail）にだけ使う。
 *   全体の 👑（詳細 API の best）がこの回の物件ならそれ（完了のまとめの best_id を含む）、無ければ同じ決まりでこの回の中の一番
 */
export function roundBestId(rows: ReadonlyArray<BestCandidateRow>, basis: BestBasis, globalBestId?: number | null): number | null {
  if (globalBestId != null && rows.some((r) => r.id === globalBestId && r.status === "pending")) return globalBestId;
  return pickCustomerBest(rows, { basis, windowHours: 24 * 365 })?.id ?? null;
}

/** 👑 の点の出し方（画面の文言）。画像＝「85点」／判定＝「判定 72点」 */
export function bestPointLabel(b: Pick<CustomerBest, "basis" | "match" | "score">): string {
  if (b.basis === "image" && b.match != null) return `${b.match}点`;
  if (b.score != null) return `判定 ${b.score}点`;
  return b.match != null ? `${b.match}点` : "点なし";
}

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

/**
 * 全体の一番（点が1件も無ければ null）。rows はお客様1人分（何回分でもよい）。
 *   basis: お客様の決まり（bestBasisFor）。省略は image（前の動き）
 *   preferId: 「完了」のまとめで決めた 👑（best_id）。今も候補に残っていれば（未送信・同じ基準で点がある）それを一番にする
 */
export function pickCustomerBest(rows: ReadonlyArray<BestCandidateRow>, opts?: { windowHours?: number; basis?: BestBasis; preferId?: number | null }): CustomerBest | null {
  if (!rows.length) return null;
  const windowMs = (opts?.windowHours ?? CUSTOMER_BEST_WINDOW_HOURS) * 3600_000;
  const latest = Math.max(...rows.map((r) => Date.parse(r.created_at)).filter((n) => Number.isFinite(n)));
  if (!Number.isFinite(latest)) return null;
  const inWindow = rows.filter((r) => r.status === "pending" && latest - Date.parse(r.created_at) <= windowMs);
  const m = (r: BestCandidateRow) => numOrNull(r.image_analysis?.match);
  const sc = (r: BestCandidateRow) => numOrNull(r.score);
  const raw = (r: BestCandidateRow) => numOrNull(r.image_analysis?.match_raw) ?? m(r) ?? 0;
  const imageScored = inWindow.filter((r) => m(r) != null);
  // 判定の点で決める時は外す候補を候補にしない（外す候補が 👑 だと「外すのか一番なのか」が食い違う）
  const scoreScored = inWindow.filter((r) => sc(r) != null && r.verdict !== "drop");
  const want: BestBasis = opts?.basis ?? "image";
  // お客様の決まりの点が1件も無ければ、もう片方の点で補う
  const basis: BestBasis | null = want === "image"
    ? (imageScored.length ? "image" : scoreScored.length ? "score" : null)
    : (scoreScored.length ? "score" : imageScored.length ? "image" : null);
  if (!basis) return null;
  const cands = basis === "image" ? imageScored : scoreScored;
  const primary = (r: BestCandidateRow): number => (basis === "image" ? m(r) : sc(r)) as number;
  // 同じ点の後: 🌟★/🌟 → 新しい回 → 元の順位 → id
  const tail = (a: BestCandidateRow, z: BestCandidateRow) =>
    (z.recommended - a.recommended) || (Date.parse(z.created_at) - Date.parse(a.created_at)) || (a.rank - z.rank) || (a.id - z.id);
  const sorted = cands.slice().sort(basis === "image"
    ? (a, z) => (primary(z) - primary(a)) || (raw(z) - raw(a)) || (okCountOf(z.image_analysis) - okCountOf(a.image_analysis)) || (verdictOrder(a) - verdictOrder(z))
      || ((sc(z) ?? -1) - (sc(a) ?? -1)) || tail(a, z)
    : (a, z) => (primary(z) - primary(a)) || (verdictOrder(a) - verdictOrder(z)) || tail(a, z));
  const preferred = opts?.preferId != null ? sorted.find((r) => r.id === opts.preferId) ?? null : null;
  const best = preferred ?? sorted[0];
  const tied = sorted.filter((r) => r.id !== best.id && primary(r) === primary(best));
  return {
    id: best.id, batch_id: best.batch_id, rank: best.rank, property_name: best.property_name, room_no: best.room_no ?? null,
    match: m(best), score: sc(best), basis,
    tied_ids: tied.map((r) => r.id), tied_names: tied.map((r) => r.property_name),
    scored: imageScored.length,
    unscored: inWindow.filter((r) => r.image_analysis && m(r) == null && !isNeedsCheck(r)).length,
    needs_check: inWindow.filter(isNeedsCheck).length,
    not_analyzed: inWindow.filter((r) => !r.image_analysis).length,
    batches: new Set(inWindow.map((r) => r.batch_id)).size,
  };
}
