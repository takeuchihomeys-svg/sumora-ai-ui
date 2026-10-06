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
import { overrideRulerKey } from "./search-override";
import { imageBonusOf, signedPoints, type ImageAnalysisForBonus } from "./pickup-image-bonus";
import { listingDealStatus } from "./listing-deal-status";
import { rankStarCandidates, STAR_FIT_RULE_TAG, type StarRankMode, type StarSituation } from "./recommend-star-rank";
import { starCandidateOfPickup, type StarPickupRow } from "./star-rank-pickup";

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
  /** 2026-09-27 判定の札（画像の加点で判定と同じ希望を二重に数えないため・pickup-image-bonus） */
  reason_codes?: string[] | null;
  /** 2026-10-01 資料の表（現況＝審査中・商談中を 👑 にしないため。無い行は見ない） */
  terms?: { buildingAge?: number | null; deposit?: number | null; keyMoney?: number | null; evidence?: { moveIn?: string | null; area?: string | null } | null } | null;
  /** 2026-10-06 🌟の並べ方（recommend-star-rank・合い方）の材料。無い行はその項目を比べないだけ */
  summary_text?: string | null;
  ad_yen?: number | null;
  equipment?: StarPickupRow["equipment"];
  /** 2026-09-27 案A: その回をメモの上書きで判定した印（property_pickups.search_override）。無い行＝登録の条件で判定 */
  search_override?: unknown;
};

/**
 * 2026-09-27 案A: 同じまとめ（窓）に「メモの上書きで判定した回」と「登録の条件で判定した回」が混ざった時の 👑 の決まり。
 *   点はそれぞれの回の条件で付けた物（1LDK で検索した回は 1LDK が満点・登録の 1K の回は 1K が満点）なので、物差しの違う点を1本の並びで比べない。
 *   → 点の付いた候補がある物差しのうち、一番新しく届いた回の物差しの物件だけから 👑 を選ぶ（スタッフの一番新しい指示＝今の探し物）。
 *   まとめを分ける案は取らない: まとめ ID・後から届いた回の足し込み（joinableGroupId）・画面の回の寄せ（groupPickupRounds）の3か所を割る必要があり、
 *   混ざるのは「上書きの検索の前後に同じお客様を普通に検索した」時だけ（まれ）なので、👑 の候補だけ絞る単純な方にした。
 *   物差しが1つだけ（ふつう）の時は何も変えない。
 */
export function sameRulerCandidates<T extends Pick<BestCandidateRow, "created_at" | "search_override">>(rows: ReadonlyArray<T>, hasPoint: (r: T) => boolean): T[] {
  const keys = new Set(rows.map((r) => overrideRulerKey(r.search_override)));
  if (keys.size <= 1) return rows.slice();
  let bestKey: string | null = null, bestAt = -Infinity;
  for (const r of rows) {
    if (!hasPoint(r)) continue;
    const t = Date.parse(r.created_at);
    if (Number.isFinite(t) && t > bestAt) { bestAt = t; bestKey = overrideRulerKey(r.search_override); }
  }
  if (bestKey == null) return rows.slice();
  return rows.filter((r) => overrideRulerKey(r.search_override) === bestKey);
}

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
  /** 2026-09-27 画像の加点（判定と同じ希望を外した分・分析待ち／要確認は null）と合計（判定の点＋加点） */
  bonus: number | null;
  total: number | null;
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
  /** 2026-10-06 どの決め方で 👑 を決めたか（fit＝合い方が主軸の🌟の並べ方・legacy＝合計の1位）と決まりの名前（bestRuleTag） */
  star_mode?: StarRankMode;
  rule?: string;
  /** 今までの決め方（合計の1位）なら 👑 になっていた行（同じなら id と同じ）。後で2つの決め方を比べるための記録 */
  legacy_id?: number | null;
  /** 合い方の決め方の理由（「束の中で一番広い」等） */
  star_reasons?: string[];
};

export const CUSTOMER_BEST_WINDOW_HOURS = 6;

export type BestBasis = "image" | "score";

/**
 * 👑（一番オススメ）の決まり。
 * 2026-09-25 竹内「総合的に判定されたのみにする。ややこしいから」: 画像で分析が要るお客様でも画像の点で分けず、
 *   いつも総合の判定の点（judgeProperty の 50＋札の合計。画像の読み取りの結果も IMAGE_* の札で中に入っている）で決める。
 *   （旧: 画像で分析が必要（recommended）なら画像の点・それ以外は判定の点＝画像の点が並んだ時に判定の低い物が 👑 になり分かりにくかった）
 *   判定の点が1件も無い古い行だけの時は、pickCustomerBest が画像の点で補う（前の動き）
 */
export function bestBasisFor(_need?: Pick<ImageAnalysisNeed, "level"> | null): BestBasis {
  return "score";
}

/**
 * 2026-09-27 竹内「画像で分析の部分も上の部分にまとめる。まとめたうえで結果をだす。点数のと画像で分析がわかれていたらみにくい」:
 *   売上サポの「🔍 画像で分析」の吹き出しは別に一番（画像の点・🌟 を見ない・送信済みも入れる）を決めていて、上の 👑（判定の点）と食い違った
 *   （YUMA の回: 判定 162点・画像 86点で並んだ 705 と 703 → 👑 は🌟の 703・画像の吹き出しは順位の上の 705）。
 *   → 一番と並びの決め方を1つにした（compareOverall）: 判定の点 → 判定（通す＞保留＞外す候補）→ 画像で分析の点 → 上限前の点 →「合う」の数 → 🌟★/🌟 → 新しい回 → 順位 → id。
 *   画像の点は判定の点に足さない: 判定の点には資料の設備欄・間取り図の読み取り（EQUIP_*／IMAGE_*）が既に入っていて、足すと同じ希望を二重に数える。
 *   画面の吹き出しの 👑・並び・「完了」のまとめの順位と best_id が全部この1つを使う
 * 2026-09-27 竹内「ここは合わせる」（版 b）: 画像の点を判定の点に**足して**並べる＝合計（判定の点＋画像の加点・pickup-image-bonus）。
 *   画像の加点は 0〜100 の割合ではなく、判定に同じ設備の札が無い希望だけを判定の設備の札と同じ物差し（○ +3/+5・× −5/−10・+15〜−20）で足した物
 *   （判定の EQUIP_*／IMAGE_* にもう入っている希望は数えない＝二重に数えない）。分析待ち・要確認の物件は加点なし（判定の点のまま）。
 *   並び: 合計 → 判定（通す＞保留＞外す候補）→ 判定の点 → 画像で分析の点 → 上限前の点 →「合う」の数 → 🌟★/🌟 → 新しい回 → 順位 → id
 */
export const BEST_RULE_TAG = "score+imagebonus@2026-09-27b";
/** まとめ（property_pickup_completions.result.basis_rule）に残す決まりの名前。決まりが変わった前のまとめの best_id は使わない（並べ直す） */
export function bestRuleTag(basis: BestBasis, starMode: StarRankMode = "fit"): string {
  // 2026-10-06 🌟の並べ方（合い方が主軸）に切り替えた。決め方が違うまとめの best_id は使わない（並べ直す）
  return basis === "score" ? (starMode === "fit" ? STAR_FIT_RULE_TAG : BEST_RULE_TAG) : basis;
}

type OverallRow = { id: number; rank: number; recommended?: number | null; score?: number | null; verdict?: string | null; created_at?: string | null; reason_codes?: ReadonlyArray<string> | null; image_analysis?: { match?: unknown; match_raw?: unknown; review?: unknown; [k: string]: unknown } | null };
/** 画像で分析の点（要確認＝物件と資料が合わない時は点として使わない） */
export function imageMatchOf(r: Pick<OverallRow, "image_analysis">): number | null {
  const a = r.image_analysis;
  if (!a || (a.review as { status?: unknown } | undefined)?.status === "要確認") return null;
  return typeof a.match === "number" && Number.isFinite(a.match) ? a.match : null;
}
/** 画像の加点（分析待ち・要確認は null） */
export function imageBonusPoints(r: Pick<OverallRow, "reason_codes" | "image_analysis">): number | null {
  return imageBonusOf({ reason_codes: r.reason_codes, image_analysis: r.image_analysis as ImageAnalysisForBonus })?.points ?? null;
}
/** 合計（判定の点＋画像の加点）。判定の点が無ければ null・分析待ち／要確認は判定の点のまま */
export function overallPoints(r: Pick<OverallRow, "score" | "reason_codes" | "image_analysis">): number | null {
  if (typeof r.score !== "number" || !Number.isFinite(r.score)) return null;
  return r.score + (imageBonusPoints(r) ?? 0);
}
/** 1本の並び（合計 → 判定 → 判定の点 → 画像の点 → 上限前の点 →「合う」の数 → 🌟 → 新しい回 → 順位 → id）。点の無い物は後ろ */
export function compareOverall(a: OverallRow, z: OverallRow): number {
  const sa = overallPoints(a), sz = overallPoints(z);
  if (sa != null && sz != null && sa !== sz) return sz - sa;
  if (sa == null && sz != null) return 1;
  if (sa != null && sz == null) return -1;
  const v = verdictOrder(a) - verdictOrder(z);
  if (v) return v;
  // 合計が同じなら判定の点が高い方（画像で足した分より判定の札の方が確か）
  const ja = typeof a.score === "number" ? a.score : null, jz = typeof z.score === "number" ? z.score : null;
  if (ja != null && jz != null && ja !== jz) return jz - ja;
  const ma = imageMatchOf(a), mz = imageMatchOf(z);
  if (ma != null && mz != null && ma !== mz) return mz - ma;
  if (ma == null && mz != null) return 1;
  if (ma != null && mz == null) return -1;
  if (ma != null && mz != null) {
    const raw = (r: OverallRow) => { const x = r.image_analysis?.match_raw; return typeof x === "number" ? x : (imageMatchOf(r) ?? 0); };
    const d = (raw(z) - raw(a)) || (okCountOf(z.image_analysis) - okCountOf(a.image_analysis));
    if (d) return d;
  }
  const ta = a.created_at ? Date.parse(a.created_at) : NaN, tz = z.created_at ? Date.parse(z.created_at) : NaN;
  return ((z.recommended ?? 0) - (a.recommended ?? 0))
    || (Number.isFinite(ta) && Number.isFinite(tz) ? tz - ta : 0)
    || (a.rank - z.rank) || (a.id - z.id);
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
export function roundBestId(rows: ReadonlyArray<BestCandidateRow>, basis: BestBasis, globalBestId?: number | null, starMode?: StarRankMode, situation?: StarSituation | null): number | null {
  if (globalBestId != null && rows.some((r) => r.id === globalBestId && r.status === "pending")) return globalBestId;
  return pickCustomerBest(rows, { basis, windowHours: 24 * 365, starMode, situation })?.id ?? null;
}

/**
 * 👑 の点の出し方（画面の文言）。画像＝「85点」／判定だけ（分析待ち・要確認）＝「判定 163点」／
 * 2026-09-27 画像を足した時＝「合計 169点（判定 163・画像 +6）」（並びに使った合計を先に・内訳を後ろに）
 */
export function bestPointLabel(b: Pick<CustomerBest, "basis" | "match" | "score"> & { bonus?: number | null }): string {
  if (b.basis === "image" && b.match != null) return `${b.match}点`;
  if (b.score != null) return b.bonus != null ? `合計 ${b.score + b.bonus}点（判定 ${b.score}・画像 ${signedPoints(b.bonus)}）` : `判定 ${b.score}点`;
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
export function verdictOrder(r: { verdict?: string | null }): number {
  return r.verdict === "pass" ? 0 : r.verdict === "hold" ? 2 : r.verdict === "drop" ? 3 : 1;
}

const isNeedsCheck = (r: BestCandidateRow) => (r.image_analysis?.review as { status?: unknown } | undefined)?.status === "要確認";

/**
 * 全体の一番（点が1件も無ければ null）。rows はお客様1人分（何回分でもよい）。
 *   basis: お客様の決まり（bestBasisFor）。省略は image（前の動き）
 *   preferId: 「完了」のまとめで決めた 👑（best_id）。今も候補に残っていれば（未送信・同じ基準で点がある）それを一番にする
 */
export function pickCustomerBest(rows: ReadonlyArray<BestCandidateRow>, opts?: { windowHours?: number; basis?: BestBasis; preferId?: number | null; starMode?: StarRankMode; situation?: StarSituation | null }): CustomerBest | null {
  if (!rows.length) return null;
  const windowMs = (opts?.windowHours ?? CUSTOMER_BEST_WINDOW_HOURS) * 3600_000;
  const latest = Math.max(...rows.map((r) => Date.parse(r.created_at)).filter((n) => Number.isFinite(n)));
  if (!Number.isFinite(latest)) return null;
  const m = (r: BestCandidateRow) => numOrNull(r.image_analysis?.match);
  const sc = (r: BestCandidateRow) => numOrNull(r.score);
  // 2026-09-27 案A: 物差し（メモの上書き／登録の条件）が混ざる時は、一番新しい回の物差しの物件だけ（sameRulerCandidates）
  // 2026-10-01 竹内（チンシャン: 👑 の都島岡本マンションが資料の現況で商談中）「申込中・商談中の物件は送らない」:
  //   資料の現況が審査中・商談中の行は 👑 にしない（143回中20回の 👑 が申込・商談・審査中だった）。資料の表（terms）が無い行は今まで通り
  const inWindow = sameRulerCandidates(rows.filter((r) => r.status === "pending" && latest - Date.parse(r.created_at) <= windowMs
      && listingDealStatus({ evidenceMoveIn: r.terms?.evidence?.moveIn ?? null }) == null),
    (r) => m(r) != null || (sc(r) != null && r.verdict !== "drop"));
  const raw = (r: BestCandidateRow) => numOrNull(r.image_analysis?.match_raw) ?? m(r) ?? 0;
  const imageScored = inWindow.filter((r) => m(r) != null);
  // 判定の点で決める時は外す候補を候補にしない（外す候補が 👑 だと「外すのか一番なのか」が食い違う）
  const scoreScored = inWindow.filter((r) => sc(r) != null && r.verdict !== "drop");
  // 2026-09-25 竹内「総合的に判定されたのみにする」: 省略時も総合の判定の点（bestBasisFor と同じ）
  const want: BestBasis = opts?.basis ?? "score";
  // お客様の決まりの点が1件も無ければ、もう片方の点で補う
  const basis: BestBasis | null = want === "image"
    ? (imageScored.length ? "image" : scoreScored.length ? "score" : null)
    : (scoreScored.length ? "score" : imageScored.length ? "image" : null);
  if (!basis) return null;
  const cands = basis === "image" ? imageScored : scoreScored;
  // 2026-09-27 版 b: 判定の点で決める時の「同じ点」は合計（判定の点＋画像の加点）で見る
  const primary = (r: BestCandidateRow): number => (basis === "image" ? m(r) : overallPoints(r)) as number;
  // 同じ点の後: 🌟★/🌟 → 新しい回 → 元の順位 → id
  const tail = (a: BestCandidateRow, z: BestCandidateRow) =>
    (z.recommended - a.recommended) || (Date.parse(z.created_at) - Date.parse(a.created_at)) || (a.rank - z.rank) || (a.id - z.id);
  const sorted = cands.slice().sort(basis === "image"
    ? (a, z) => (primary(z) - primary(a)) || (raw(z) - raw(a)) || (okCountOf(z.image_analysis) - okCountOf(a.image_analysis)) || (verdictOrder(a) - verdictOrder(z))
      || ((sc(z) ?? -1) - (sc(a) ?? -1)) || tail(a, z)
    // 2026-09-27 判定の点で決める時は1本の並び（compareOverall・画面の並び／まとめの順位と同じ）
    : compareOverall);
  // 2026-10-06 竹内さん（A: 今切り替える）: 判定の点で決める時は🌟の並べ方（recommend-star-rank＝合い方が主軸・AD は 1.5ヶ月の線・
  //   刺さる物が無ければ低い AD でも合う物＝内覧を組むのが優先）で 👑 を決める。戻す時は STAR_RANK_MODE=off（starMode: "legacy"）。
  //   候補: 外す候補は前から除いてある。保留は「通す（判定なし含む）」が1件でもあれば候補にしない（recommend-star-rank は保留を呼ぶ側で外す前提）。
  //   同じ合い方の点は AD → 初期費用面（敷礼0・フリーレント・敷礼の月数）で分け（2026-10-06d starTieBreak）、それでも同じなら今までの並び（compareOverall）の順
  const starMode: StarRankMode = opts?.starMode ?? "fit";
  const legacyFirst = sorted[0];
  let fitOrder: Array<{ id: number; fit: number; reasons: string[] }> | null = null;
  if (basis === "score" && starMode === "fit") {
    const open = sorted.filter((r) => r.verdict !== "hold");
    const pool = open.length ? open : sorted;
    // 2026-10-06b お客様の状況（敷礼0・2階以上を言っている時の足し点・star-rank-pickup.starSituationFromConditions）。無ければ足さない
    fitOrder = rankStarCandidates(pool.map((r) => starCandidateOfPickup(r, overallPoints(r) ?? 0)), undefined, opts?.situation ?? null).map((x) => ({ id: Number(x.key), fit: x.fit, reasons: x.reasons }));
  }
  const fitOf = (id: number) => fitOrder?.find((x) => x.id === id) ?? null;
  const fitFirst = fitOrder?.length ? sorted.find((r) => r.id === fitOrder![0].id) ?? null : null;
  const preferred = opts?.preferId != null ? sorted.find((r) => r.id === opts.preferId) ?? null : null;
  const best = preferred ?? fitFirst ?? legacyFirst;
  const tied = fitOrder
    ? sorted.filter((r) => r.id !== best.id && fitOf(r.id) != null && fitOf(r.id)!.fit === fitOf(best.id)?.fit)
    : sorted.filter((r) => r.id !== best.id && primary(r) === primary(best));
  return {
    id: best.id, batch_id: best.batch_id, rank: best.rank, property_name: best.property_name, room_no: best.room_no ?? null,
    match: m(best), score: sc(best), bonus: imageBonusPoints(best), total: overallPoints(best), basis,
    tied_ids: tied.map((r) => r.id), tied_names: tied.map((r) => r.property_name),
    scored: imageScored.length,
    unscored: inWindow.filter((r) => r.image_analysis && m(r) == null && !isNeedsCheck(r)).length,
    needs_check: inWindow.filter(isNeedsCheck).length,
    not_analyzed: inWindow.filter((r) => !r.image_analysis).length,
    batches: new Set(inWindow.map((r) => r.batch_id)).size,
    star_mode: fitOrder ? "fit" : "legacy",
    rule: bestRuleTag(basis, fitOrder ? "fit" : "legacy"),
    legacy_id: legacyFirst?.id ?? null,
    star_reasons: fitOf(best.id)?.reasons ?? [],
  };
}
