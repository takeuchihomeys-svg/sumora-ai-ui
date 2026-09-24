// app/lib/pickup-review-order.ts（純関数・画面とサーバーで共用。サーバーの部品は import しない）
// 売上サポのピックアップ画面で、1回分の物件の並び順と「なぜその点・なぜ外す候補か」の札を決める。
//
// 2026-09-24 竹内（HONOKA さんの itandi の回・property_pickups id 50〜67）:
//   「並び順は物件オススメが一番上でスコアリング順にする」
//     → 🌟★（一番オススメ）→ 🌟 → 印なし、同じ印の中は点（score）の高い順、同点は元の順位（【N】）
//   「外す候補 20 と出てるが、なんで全部外す候補 20 でばらつきないのか。今回なんで外されているのか理由が分かれば大きい」
//     → 点の横に理由の札（減点・外す理由が先・何点引いたか）。材料が読めずに点が動かない時は「材料なし」も札で出す
//       （点が横並びの原因は『材料が無い』か『同じ理由が全件に当たった』のどちらか。画面で一目で分かるように）
import { BASE_SCORE, reasonJa, reasonPoints } from "./property-brain";

export type ReviewOrderRow = { id: number; rank: number; recommended: number; score: number | null };

/** 並びの比べ方: 🌟★ → 🌟 → 印なし、点の高い順（点なしは最後）、同点は順位 → id */
export function compareForReview(a: ReviewOrderRow, z: ReviewOrderRow): number {
  const rec = (z.recommended ?? 0) - (a.recommended ?? 0);
  if (rec) return rec;
  const sa = a.score, sz = z.score;
  if (sa != null && sz != null && sa !== sz) return sz - sa;
  if (sa == null && sz != null) return 1;
  if (sa != null && sz == null) return -1;
  return (a.rank - z.rank) || (a.id - z.id);
}

/** 1回分の物件を画面の並びにする（元の配列は変えない） */
export function sortForReview<T extends ReviewOrderRow>(items: ReadonlyArray<T>): T[] {
  return items.slice().sort(compareForReview);
}

/** 画面に出す短い言い方（REASON_JA より短く。無ければ REASON_JA） */
const CHIP_JA: Record<string, string> = {
  ALREADY_SENT: "送付済みの建物",
  RENT_OVER_130: "家賃が上限の3割超",
  RENT_OVER_110: "家賃が上限の1割超",
  RENT_SLIGHTLY_OVER: "家賃が上限を少し超過",
  RENT_ABOVE_USUAL: "いつもの家賃帯より高め",
  INITIAL_COST_NOT_ZERO: "敷金か礼金あり",
  INITIAL_COST_OVER_LIMIT: "敷礼が初期費用の上限超",
  FLOOR_PLAN_MISMATCH: "間取りが希望と違う",
  WALK_OVER: "徒歩が希望の1.5倍超",
  WALK_SLIGHTLY_OVER: "徒歩が希望を少し超過",
  BUILDING_AGE_OVER: "築年が希望超過",
  BUILDING_AGE_SLIGHTLY_OVER: "築年が希望を少し超過",
  PROFIT_NEGATIVE: "割引が AD より大きい",
  PET_NG: "ペット不可",
  ZERO_ZERO_MATCH: "敷礼0（希望に一致）",
  AD_COVERS_DISCOUNT: "AD で割引をまかなえる",
  // 2026-09-25 資料の表の募集の条件
  MOVE_IN_OK: "入居時期に間に合う",
  MOVE_IN_LATE: "入居が希望より遅い",
  MOVE_IN_UNKNOWN: "入居時期は要確認",
  CONTRACT_FIXED: "定期借家",
  FREE_RENT_MATCH: "フリーレント（希望に一致）",
};

/** 読めなかった材料（点が動かない理由）。コード → 札の言葉 */
const MISSING_JA: Record<string, string> = {
  RENT_UNKNOWN: "家賃", INITIAL_COST_UNKNOWN: "敷礼", AD_UNKNOWN: "AD", RENT_MAX_UNRELIABLE: "家賃上限",
};

export type ReasonChip = {
  code: string;
  label: string;
  /** 足し引きした点（0 は材料なし・知らせだけ） */
  points: number;
  /** drop＝外す理由・minus＝減点・plus＝加点・info＝知らせ（点なし） */
  tone: "drop" | "minus" | "plus" | "info";
};

export type ReasonView = {
  /** 外す・減点の理由（先に見せる）。外す理由（drop）が先頭 */
  minus: ReasonChip[];
  /** 加点 */
  plus: ReasonChip[];
  /** 読めなかった材料（「材料なし: 家賃・敷礼・AD」） */
  missing: string[];
  /** reason_codes に無い一文（同じ建物の省略 等）。reasons_ja のうちコードから作っていない物 */
  notes: string[];
  /** 50 ＋ 合計（上限前）。reason_codes が無い古い行は null */
  rawTotal: number | null;
};

/** 外す（drop）にするコード（judgeProperty の "drop" と同じ） */
const DROP_CODES = new Set(["ALREADY_SENT", "RENT_OVER_130"]);

/**
 * 1件の理由の見え方。reason_codes（判定のコード）から点の内訳を作る。
 * reason_codes が無い古い行は reasons_ja をそのまま知らせ（info）として返す。
 */
export function buildReasonView(row: { reason_codes?: string[] | null; reasons_ja?: string[] | null }): ReasonView {
  const codes = row.reason_codes ?? null;
  const ja = row.reasons_ja ?? [];
  const view: ReasonView = { minus: [], plus: [], missing: [], notes: [], rawTotal: null };
  if (!codes || codes.length === 0) {
    view.notes = ja.slice();
    return view;
  }
  const fromCodes = new Set<string>();
  let total = BASE_SCORE;
  for (const code of codes) {
    const p = reasonPoints(code);
    total += p;
    const label = CHIP_JA[code] ?? reasonJa(code);
    fromCodes.add(reasonJa(code));
    if (MISSING_JA[code]) { view.missing.push(MISSING_JA[code]); continue; }
    if (p < 0) view.minus.push({ code, label, points: p, tone: DROP_CODES.has(code) ? "drop" : "minus" });
    else if (p > 0) view.plus.push({ code, label, points: p, tone: "plus" });
    else view.minus.push({ code, label, points: 0, tone: "info" });
  }
  // 外す理由 → 減点の大きい順 → 知らせ
  const w = (c: ReasonChip) => (c.tone === "drop" ? 0 : c.tone === "minus" ? 1 : 2);
  view.minus.sort((a, z) => (w(a) - w(z)) || (a.points - z.points));
  view.plus.sort((a, z) => z.points - a.points);
  view.notes = ja.filter((s) => !fromCodes.has(s));
  view.rawTotal = total;
  return view;
}

/** 点の内訳の1行（「基準50 −30 送付済みの建物 ＋15 間取り一致 ＝ 35」）。コードが無ければ空 */
export function formatScoreBreakdown(v: ReasonView, score: number | null): string {
  if (v.rawTotal == null) return "";
  const parts = [...v.minus.filter((c) => c.points !== 0), ...v.plus].map((c) => `${c.points > 0 ? "＋" : "−"}${Math.abs(c.points)} ${c.label}`);
  const clamp = score != null && score !== v.rawTotal ? `（上限・下限で ${score}）` : "";
  return `基準${BASE_SCORE}${parts.length ? " " + parts.join(" ") : ""} ＝ ${v.rawTotal}${clamp}`;
}
