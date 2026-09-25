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

/** WORD JOINER（U+2060）。数字と「件」の間で折り返さない */
const WJ = String.fromCharCode(0x2060);
/** ボタンの文字（件数で変わる）。0件はチェックを促す */
export function pickupAixButtonLabel(n: number): string {
  const t = aixTypeForPickupCount(n);
  if (!t) return "📤 チェックした物件を AIX で送る";
  // 数字と「件」の間は WORD JOINER（U+2060）: 390px のボタンで「（1」「件）」と割れて折り返していた（2026-09-25 E2E のスクショ）
  return t === "property_recommendation" ? `🏠 AIX物件オススメ（1${WJ}件）` : `📤 AIX物件ピックアップ（${n}${WJ}件）`;
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

/**
 * 送り終えた時（onAfterSend）に「送った」印を付ける行と、sent_properties と結ぶ画像の URL を決める。
 *
 * 2026-09-25 YUMA の E2E テストで分かった穴（反証）:
 *   旧は URL の ids を全部 mark_sent に渡していた。①画像が取れなかった行（取得の失敗・72時間切れ）も「送った」になり
 *   売上サポから消える（実際は送っていない）②その時は画像の数と行の数が合わず、届いた物件の sent_properties も
 *   丸ごと書かれない（image_count_mismatch）③スタッフが AIX の中で画像を外した行も「送った」になる
 *   ④物件オススメで資料を「変更」で別の物件に差し替えて送っても、売上サポの物件に「送った」が付く。
 *   → 印は「セットした画像（File）が送る直前の並びに残っていた行」だけに付ける。1枚も残っていなければ印は付けない。
 *   画像の URL を結ぶのは物件ピックアップで、セットした並びのまま送った時だけ（今まで通り）。
 *   物件オススメは URL を結ばない（送った記録は画像の読み取り＝source aix:property_recommendation に任せる。
 *   recordPickupSent は channel=pickup で書くので、オススメを結ぶと経路を取り違える）。
 *
 * @param handoffIds   画像をセットできた行（handoffFiles と同じ並び）
 * @param handoffFiles セットした File（同一性で比べるだけなので型は問わない）
 * @param sentFiles    送る直前の File の並び（AixModal の onPropertySendFiles）。null＝分からない（古い画面）→ セットした行全部
 * @param sentImageUrls AIX で実際に届いた画像の URL（物件ピックアップの時だけ使う）
 */
export function planPickupMarkSent<F>(p: {
  aix: PickupAixType;
  handoffIds: readonly number[];
  handoffFiles: readonly F[];
  sentFiles: readonly F[] | null;
  sentImageUrls: readonly string[];
}): { itemIds: number[]; imageUrls: string[] } | null {
  if (p.handoffIds.length === 0 || p.handoffIds.length !== p.handoffFiles.length) return null;
  if (p.sentFiles === null) return { itemIds: [...p.handoffIds], imageUrls: [] };
  const sent = p.sentFiles;
  const itemIds = p.handoffIds.filter((_, i) => sent.includes(p.handoffFiles[i]));
  if (itemIds.length === 0) return null;
  const intact = sent.length === p.handoffFiles.length && sent.every((f, i) => f === p.handoffFiles[i]);
  return { itemIds, imageUrls: p.aix === "property_send" && intact ? [...p.sentImageUrls] : [] };
}
