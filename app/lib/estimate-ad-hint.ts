// app/lib/estimate-ad-hint.ts（純関数・DB/LLM なし・画面とサーバーで共用）
// 過去に作った御見積書の割引（estimate_records.discount_yen）から、AD が分からない物件の AD を「1.5ヶ月の線の上」と補う。
//
// 2026-10-06 竹内「見積書の割引金額みれば、ADがある物件かもわかる」→ 割引の目安を出した後「それで　1,5以上で」:
//   割引 ÷ 家賃 が線（ratioLine）以上なら AD 1.5ヶ月以上（🌟の並べ方の線の上）とみなす。それ未満は何も言わない（分からないのまま）。
//   ・使うのは「AD が分からない物件の補い」だけ。並べ方の主材料にしない・割引の大小で点を付けない
//     （設計知見 2026-09-27「こちらが自由に決める値（見積書の割引）を物件の判定・点・順位に入れない」と両立: 割引は点ではなく AD の有無の証拠）
//   ・割引は AD から出す（利益＝AD−割引）ので、割引が大きい＝AD がある証拠。小さい割引は AD が小さい証拠にはならない（割引を絞っただけ）
// 線の決め方（2026-10-06 見積書 279行のうち家賃と AD が両方分かる 40行・AD は売上サポの行／rent_observations から。候補で見た分は scripts/audit-star-fit-d.ts の段4）:
//   割引÷家賃 ≥0.3 → 39行・AD1.5未満 3（AD1 が 0.32・0.37）／≥0.4 → 34行・1（AD1.46＝家賃の取り方の端数）／≥0.5 → 32行・1（同じ）・拾えた 31/37
//   ≥1.0 → 7行・0。AD1 の見積書は 0.37 まで → 0.5 は AD1 の最大から 0.13 離れた誤りの少ない側（0.4 と誤りは同じで余白が大きい）
export const ESTIMATE_AD_HINT_RULE = {
  /** 割引 ÷ 家賃（ヶ月）がこれ以上なら AD は線の上 */
  ratioLine: 0.5,
  /** 補う AD（ヶ月）＝🌟の線（recommend-star-rank の adLine） */
  adMonths: 1.5,
} as const;

/** 割引と家賃 → 補う AD（ヶ月）。線の下・分からない時は null */
export function adHintFromDiscount(discountYen: number | null | undefined, rentYen: number | null | undefined, rule: { ratioLine: number; adMonths: number } = ESTIMATE_AD_HINT_RULE): number | null {
  const d = Number(discountYen), r = Number(rentYen);
  if (!Number.isFinite(d) || !Number.isFinite(r) || d <= 0 || r <= 0) return null;
  return d / r >= rule.ratioLine ? rule.adMonths : null;
}

/** そのお客様の過去の御見積書（物件名・号室・割引） */
export type EstimateDiscountRow = { property_name: string | null; room_no?: string | null; discount_yen: number | null };

const toHalf = (s: string) => String(s ?? "").normalize("NFKC");
const roomKey = (r: unknown) => toHalf(String(r ?? "")).replace(/[^0-9A-Za-z]/g, "").replace(/^0+(?=\d)/, "");
/** 建物名の鍵（空白・記号・号室の末尾を外す）。濁点の違いは同じ建物（customer-state の voicingFold と同じ考え） */
export function estimateNameKey(name: string | null | undefined): string {
  let s = toHalf(String(name ?? "")).toLowerCase();
  s = s.replace(/[（(][^）)]*[）)]/g, "").replace(/\s*[a-z]?-?\d{1,4}\s*号室?\s*$/i, "").replace(/\s+\d{2,4}$/, "");
  s = s.replace(/[\s・･\-‐ー－_.,、。'’"“”!！?？☆★🌟]/gu, "");
  return s.normalize("NFD").replace(/[゙゚]/g, "").normalize("NFC");
}

/**
 * 物件（名前・号室・家賃）に当たる過去の御見積書から補う AD。同じ建物で、号室が両方分かる時は同じ号室だけ。
 * 何通もあれば一番大きい割引（送り直しで割引を絞った版より、出せた割引の方が AD の証拠として強い）。
 */
export function estimateAdHintFor(name: string | null | undefined, roomNo: string | null | undefined, rentYen: number | null | undefined, rows: ReadonlyArray<EstimateDiscountRow> | null | undefined): number | null {
  const k = estimateNameKey(name);
  if (!k || k.length < 2 || !rows?.length) return null;
  const rk = roomKey(roomNo);
  let best: number | null = null;
  for (const e of rows) {
    if (estimateNameKey(e.property_name) !== k) continue;
    const ek = roomKey(e.room_no);
    if (rk && ek && rk !== ek) continue;
    const d = Number(e.discount_yen);
    if (Number.isFinite(d) && (best == null || d > best)) best = d;
  }
  return best == null ? null : adHintFromDiscount(best, rentYen);
}
