/**
 * 売上サポ（AIXツール）→ LINE のトークの AIX へ、チェックした物件の画像をセットして渡す（純関数・画面とトークの両方で使う）。
 *
 * 2026-09-25 竹内「チェックして物件ピックアップを押せば、トークの AIX のピックアップに画像がセットされる形とする。
 *   チェックして1件だけなら物件オススメでセットされてトークのところに移る。複数選択なら AIX 物件ピックアップ・1件なら AIX 物件オススメ。
 *   物件オススメは1件のみ（一番オススメだから）・物件ピックアップは複数（条件に合った物件を複数ピックアップだから）」
 *   → 件数で AIX の種類を決める（1件＝property_recommendation／2件以上＝property_send）。URL の形は 9/24 の handoff と同じ
 *     （/?conv=…&aix=…&pickup=ids&batch=…）で、aix に property_recommendation も受ける。
 */

export type PickupAixType = "property_send" | "property_recommendation";

/** AIX に一度に渡せる件数（GET /api/property-pickups?ids が10件で切る・AIX【物件ピックアップした】の画像も10枚まで） */
export const PICKUP_AIX_MAX = 10;

/** チェックした件数 → AIX の種類。1件＝物件オススメ（一番オススメの1件）・2件以上＝物件ピックアップ */
export function aixTypeForPickupCount(n: number): PickupAixType | null {
  if (!Number.isInteger(n) || n <= 0) return null;
  return n === 1 ? "property_recommendation" : "property_send";
}

/** ボタンの文字（件数で変わる）。0件はチェックを促す */
export function pickupAixButtonLabel(n: number): string {
  const t = aixTypeForPickupCount(n);
  if (!t) return "📤 チェックした物件を AIX で送る";
  return t === "property_recommendation" ? "🏠 AIX物件オススメ（1件）" : `📤 AIX物件ピックアップ（${n}件）`;
}

/** 売上サポ → トークへ移る URL */
export function buildPickupAixHref(p: { conversationId: string; pickupIds: number[]; batchId?: string | null }): string | null {
  const ids = p.pickupIds.filter((v) => Number.isInteger(v) && v > 0);
  const aix = aixTypeForPickupCount(ids.length);
  if (!aix || !p.conversationId || ids.length > PICKUP_AIX_MAX) return null;
  return `/?conv=${encodeURIComponent(p.conversationId)}&aix=${aix}&pickup=${encodeURIComponent(ids.join(","))}&batch=${encodeURIComponent(p.batchId ?? "")}`;
}

export type PickupAixHandoff = { conv: string; ids: string; batch: string; aix: PickupAixType };

/**
 * トーク側で URL を読む。物件オススメは1件だけ（2件以上の ids で property_recommendation が来たら、送り間違いを避けて物件ピックアップに直す）。
 * 旧の URL（aix=property_send で1件）もそのまま物件ピックアップで開く（前の動きを変えない）
 */
export function parsePickupAixHandoff(search: string): PickupAixHandoff | null {
  const sp = new URLSearchParams(search);
  const conv = sp.get("conv"), ids = sp.get("pickup"), aix = sp.get("aix");
  if (!conv || !ids || (aix !== "property_send" && aix !== "property_recommendation")) return null;
  const n = ids.split(",").filter((s) => /^\d+$/.test(s.trim())).length;
  if (n === 0) return null;
  return { conv, ids, batch: sp.get("batch") ?? "", aix: aix === "property_recommendation" && n !== 1 ? "property_send" : aix };
}
