/**
 * AIX【物件オススメ】で送った物件を、送った物件の記録（sent_properties）に足す（純関数・2026-11-21 作業員G・統括役の OK）
 *
 * 実物（7日で4件・名前は伏せてテストに）: 🌟の送信が「室内の写真1枚 →（室内イメージ）URL →『🌟名前 号室…』の文」の形の時、
 *   写真からは物件名も値も読めないので、sent_properties にどこからも行が書かれていなかった（#448 の結び付けは画像の記録だけ）。
 *   その物件を「送った」と数えられず、2通目・物件選び（K2）・ブレインの「送付済み」から抜けていた。
 *
 * 決まり（作らない側に倒す）:
 *   - AIX の種類が property_recommendation で、記録の物件名（aix_usage_logs.property_names）がちょうど1件の時だけ
 *   - 名前の後ろの「〇〇号室」を号室に分ける（無ければ空）
 *   - 同じ物件（isSameProperty）の行が会話に既にあれば足さない（呼ぶ側）
 *   - 値（家賃など）は入れない（写真からは読めない・推測しない）。送った経路だけ（channel recommendation）
 *   - 試験の行（line_message_id が bexam-）・テストの会話は足さない（呼ぶ側）
 *   - 既定 off（RECOMMENDATION_SENT_RECORD=on）
 */

export function recommendationSentRecordOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.RECOMMENDATION_SENT_RECORD ?? "").trim().toLowerCase() === "on";
}

/** 「名前 302号室」→ 名前と号室。号室が無ければ空 */
export function splitNameRoom(raw: string): { propertyName: string; roomNo: string } {
  const s = String(raw ?? "").trim();
  const m = /^(.*?)[\s　]*(\d{1,4})\s*号室\s*$/.exec(s);
  if (m && m[1].trim()) return { propertyName: m[1].trim(), roomNo: m[2] };
  return { propertyName: s, roomNo: "" };
}

/** 足す行の中身（足さない時は null） */
export function recommendationSentRow(o: { aixType: string | null | undefined; propertyNames: ReadonlyArray<string> | null | undefined; lineMessageId?: string | null }): { propertyName: string; roomNo: string } | null {
  if (o.aixType !== "property_recommendation") return null;
  if (String(o.lineMessageId ?? "").startsWith("bexam-")) return null;
  const names = (o.propertyNames ?? []).map((n) => String(n ?? "").trim()).filter(Boolean);
  if (names.length !== 1) return null;
  const r = splitNameRoom(names[0]);
  return r.propertyName.length >= 2 ? r : null;
}
