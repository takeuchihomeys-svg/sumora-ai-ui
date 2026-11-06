// scripts/lib/exam-essence.ts — 試験の本質の道（決まった計算の前のブレインの最初の答え）の数え方の直し（純関数・LLM なし）
//
// 2026-11-06 統括役（作業員4の見つけ・P0 8805bd74）: 本質の採点は aix の欄しか読まず、送れる候補が0件の番でブレインが
//   材料（override-demote の pickupReadyMaterialLine「候補は無い＝まずピックアップしてお送りする約束（turn_contract の該当の route は promise・aix は物件の AIX のままでよい＝約束の後で AIX）」）
//   どおりに答えた物を、物件の AIX＝外れと数えていた（cond1-on・cond2-on の8問中7問）。
//   次の3つがそろう時は本質を「2段:pickup」と数える: ① aix が物件の AIX ② turn_contract の該当（物件の AIX の）ask の route が promise ③ 送れる候補が0件。
//   ③ は答案の trace.pickup_ready（11/06 から brain-core が meta に残す）。残っていない古い答案は ①② だけで決める（材料の決まりで、候補がある番の promise も約束の意味）

/** 物件の AIX（送る・ピックアップ・オススメ・探す） */
export const PROPERTY_AIX = new Set(["property_send", "property_pickup", "property_recommendation", "property_search"]);

type Ask = { route?: unknown; aix?: unknown };
/** 本質を「2段:pickup」と数えるか。raw はブレインの最初の答え（aix・turn_contract）、pickupReady は送れる候補があったか（不明は null） */
export function essencePickupPromise(raw: Record<string, unknown> | null | undefined, pickupReady: boolean | null | undefined): boolean {
  if (!raw) return false;
  const aix = String(raw.aix ?? "").trim();
  if (!PROPERTY_AIX.has(aix)) return false;
  if (pickupReady === true) return false;
  const tc = raw.turn_contract as { asks?: Ask[] } | undefined;
  const asks = Array.isArray(tc?.asks) ? tc!.asks! : [];
  // 該当の ask: 物件の AIX を書いた ask（無ければ aix の欄が無い ask も含めて見る）
  const own = asks.filter((a) => PROPERTY_AIX.has(String(a.aix ?? "")));
  const pool = own.length ? own : asks;
  return pool.some((a) => String(a.route ?? "") === "promise");
}

/**
 * 2026-11-06 統括役（作業員4の見つけ）: aix が物件確認の結果（property_check_result）で、該当の ask の route が promise の答えは、
 *   竹内さんの「募集状況確認させて頂きます」（2段:check）と同じ意味＝本質を「2段:check」と数える（tk35 の q366・q370）
 */
export function essenceCheckPromise(raw: Record<string, unknown> | null | undefined): boolean {
  if (!raw || String(raw.aix ?? "").trim() !== "property_check_result") return false;
  const tc = raw.turn_contract as { asks?: Ask[] } | undefined;
  const asks = Array.isArray(tc?.asks) ? tc!.asks! : [];
  const own = asks.filter((a) => String(a.aix ?? "") === "property_check_result");
  return (own.length ? own : asks).some((a) => String(a.route ?? "") === "promise");
}

/** 本質の道の数え直し（1か所）: 物件の AIX＋promise＋候補0件 → 2段:pickup／物件確認の結果＋promise → 2段:check／それ以外は null（元の道のまま） */
export function essenceOverride(raw: Record<string, unknown> | null | undefined, pickupReady: boolean | null | undefined): "2段:pickup" | "2段:check" | null {
  if (essencePickupPromise(raw, pickupReady)) return "2段:pickup";
  if (essenceCheckPromise(raw)) return "2段:check";
  return null;
}
