/**
 * こちらが手で送った見積書・御請求書の画像が「どの物件の物か」を、書き起こしの文から読む（純関数・LLM なし）
 *   2026-11-21 作業員G（台帳 #461 案2）
 *
 * なぜ: 送った画像の物件の記録（sent_image_properties）は DeepSeek の物件の読みでしか作っておらず、見積書は「物件ではない」で
 *   記録が無かった（14日で手で送った見積書・御請求書の画像に記録 0）。お客様が見積書を引用して「この初期費用…」と聞いた時に、
 *   どの物件の見積か分からない。書き起こし（受け取り時の Vision・messages.text）には「物件名：」「住所：〇号室」がある。
 *
 * 決まり:
 *   - 画像の見出しが【見積書・初期費用の明細】の通だけを見る
 *   - 「物件名：」の行の値を名前に、「住所：」「号室：」の行から号室（〇〇号室・〇F は階なので号室にしない）
 *   - 書き起こしは文字化けがある（「SJS七条堀川」→「SJSと条堀川」）ので、名前は**会話の既知の物件名と照合できた時だけ**使う
 *     （照合は呼ぶ側で resolveReadProperty。照合できなければ記録しない＝作らない）
 *   - 見積書の中身（金額・宛名）は記録しない。DeepSeek にも出さない（文字はもう手元にある）
 *   - 既定 off（ESTIMATE_SENT_RECORD=on）
 */

const ESTIMATE_HEAD_RE = /^\s*\[画像\]\s*【見積書・初期費用の明細】/;

export function isEstimateImageText(text: string | null | undefined): boolean {
  return ESTIMATE_HEAD_RE.test(String(text ?? ""));
}

/** 「物件名：」「号室」を読む。名前が読めなければ null */
export function parseEstimatePropertyRef(text: string | null | undefined): { propertyName: string; roomNo: string | null } | null {
  const t = String(text ?? "");
  if (!isEstimateImageText(t)) return null;
  // 欄が空の時に次の行（「住所：」）を名前と読まないよう、行をまたがない空白だけを飛ばす
  const nameLine = /物件名[ \t　]*[：:][ \t　]*([^\n]*)/.exec(t)?.[1] ?? "";
  // 名前の後ろに続く号室・住所の語は外す（「〇〇マンション 302号室」）
  const nameRaw = nameLine.replace(/\s+\d{1,4}\s*号室.*$/, "").replace(/[\s　]+$/, "").trim();
  if (!nameRaw || nameRaw.length < 2 || /^(?:住所|入居者|様)$/.test(nameRaw)) return null;
  let room: string | null = null;
  const roomInName = /(\d{1,4})\s*号室/.exec(nameLine)?.[1];
  const addrLine = /(?:住[ \t　]*所|号[ \t　]*室)[ \t　]*[：:][ \t　]*([^\n]*)/.exec(t)?.[1] ?? "";
  const roomInAddr = /(\d{1,4})\s*号室/.exec(addrLine)?.[1];
  room = roomInName ?? roomInAddr ?? null;
  return { propertyName: nameRaw, roomNo: room };
}

export function estimateSentRecordOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.ESTIMATE_SENT_RECORD ?? "").trim().toLowerCase() === "on";
}
