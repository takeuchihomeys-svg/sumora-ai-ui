// app/lib/turn-route-guards.ts — ブレインの最後の AIX を、今の番の本質（依頼の中身）に合わせて直す決定論の歯止め（純関数・DB/LLM なし）
//
// 2026-10-09 ブレインの試験（base-ds-1009・本質は正しいのに最終で外れた14問）で見つけた形:
//   ①物件の AIX／2段のピックアップの約束が、物件を探す依頼でない番（検討します q022・内覧のキャンセル q023・最速入居はいつ q065・会社の住所 q067）に付く
//     → その番は返信（AIX なし・約束なし）
//   ②出し切りの判定が、新しい地名を言った番（神崎川は不便 q008・大国町で1K q032・京橋辺りも q062・大国町、本町… q011）まで全力サポートにする
//     → 地名（駅・区・市）を言った番は出し切っていない（新しい条件で探す）
//   ③内覧が決まった後・内覧を頼んでいない番に AIX【内覧調整】（q049 18日の内覧の後に追加・q050 明日の内覧で全部見たい・q053 どっちも気になります・q072 13日以降なら）
//     → 決まった内覧への追加・内覧を頼んでいない・〇日以降の事情は返信
// 戻す: TURN_ROUTE_GUARDS=off（全部）
import { STATION_LINES, WARD_COORDS } from "./osaka-geo";
import { splitRequests } from "./request-ledger";

export function turnRouteGuardsEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TURN_ROUTE_GUARDS ?? "").toLowerCase() !== "off";
}

/** お客様の文（画像の書き起こしは外す）。画像の通は「[画像]」で始まる */
export function textWithoutImages(turnMessages: ReadonlyArray<string>): string {
  return turnMessages.filter((t) => !/^\s*\[(?:画像|動画|ファイル|スタンプ)\]/.test(String(t ?? ""))).join("\n");
}

let PLACE_NAMES: string[] | null = null;
function placeNames(): string[] {
  if (PLACE_NAMES) return PLACE_NAMES;
  const s = new Set<string>();
  for (const k of STATION_LINES.keys()) if (k.length >= 2 && k !== "大阪") s.add(k);
  for (const k of WARD_COORDS.keys()) { const w = k.replace(/^大阪市/, ""); if (w.length >= 2) s.add(w); }
  PLACE_NAMES = [...s].sort((a, b) => b.length - a.length);
  return PLACE_NAMES;
}
/** お客様の文に地名（駅・区・市）があるか（URL は外す）。返すのは最初に当たった地名 */
export function placeMentioned(text: string): string | null {
  const t = String(text ?? "").normalize("NFKC").replace(/https?:\/\/\S+/g, "");
  for (const p of placeNames()) if (t.includes(p)) return p;
  return null;
}

// 試験 q061「選択肢増えるかな」・q079「白基調の部屋はあんまりないですかね」も探す側
const PICKUP_ASK_RE = /探し|探して|ピックアップ|選択肢|増え|(?:あんまり|あまり)(?:ない|無い)|ないですかね|他の(?:物件|お部屋|部屋)|(?:物件|お部屋|部屋)[^。\n]{0,8}(?:送って|下さい|ください|ほしい|欲しい|ありますか|ありませんか)|もう少し(?:見|探)/;
const CANCEL_RE = /キャンセル|取り消|やめ(?:ます|たい|とき|ておき)|見送/;
const HOLD_HES = new Set(["thinking", "callback", "waiting"]);
const CHANGE_CCT = new Set(["area_change", "rent_change", "layout_change", "equip_add", "condition_relax", "multi", "pickup_request"]);

/**
 * 物件を探す依頼でない番か（物件の AIX・ピックアップの約束を付けない＝返信の番）。
 *   お礼・了承だけの番は別の線（約束の後のお礼は AIX のまま黙って果たす）なので false。
 */
export function notPickupTurn(i: { text: string; ackOnly: boolean; conditionChangeType: string | null | undefined; hesitancy: string | null | undefined; companyFactAsked: boolean }): { yes: boolean; why: string } {
  const t = String(i.text ?? "").normalize("NFKC");
  if (!t.trim() || i.ackOnly) return { yes: false, why: "お礼・了承だけ" };
  if (i.conditionChangeType && CHANGE_CCT.has(i.conditionChangeType)) return { yes: false, why: "条件の変更・ピックアップの依頼" };
  if (placeMentioned(t)) return { yes: false, why: "地名を言った" };
  if (PICKUP_ASK_RE.test(t)) return { yes: false, why: "探す依頼の言い方" };
  const items = splitRequests([t], new Date(0).toISOString());
  if (items.some((x) => x.topic === "pickup")) return { yes: false, why: "依頼の一覧に探す依頼" };
  if (i.hesitancy && HOLD_HES.has(i.hesitancy)) return { yes: true, why: `保留（${i.hesitancy}）` };
  if (/検討(?:します|させて|してみます)|考えます|考えさせて/.test(t)) return { yes: true, why: "検討します" };
  if (CANCEL_RE.test(t)) return { yes: true, why: "キャンセル・取り消し" };
  if (i.companyFactAsked) return { yes: true, why: "会社の事実の質問" };
  if (items.some((x) => x.kind === "question")) return { yes: true, why: "質問（探す依頼でない）" };
  return { yes: false, why: "判断しない" };
}

const VIEWING_WORD_RE = /内覧|内見|見学|見に行|見たい|案内|空いて(?:ますか|いますか|る)|ご都合|日程|何時|何日|土日|週末|曜日/;
const LATER_DATE_RE = /[0-9０-９]{1,2}\s*(?:月\s*[0-9０-９]{1,2}\s*日?|日)\s*(?:以降|以後|から)|(?:来週|再来週|来月)(?:以降|から|になら)/;
/**
 * AIX【内覧調整】を返信にする番か。
 *   ①内覧が決まっている（台帳の決まった内覧がある）番の追加・全部見たい（日時の指定が無い）＝決まった内覧に足す返信
 *   ②内覧を頼んでいない（内覧の語が無い）
 *   ③〇日以降・来週以降の事情つき（先に抑える提案などの返信・竹内さん 10/08 の事情の決まり）
 */
export function viewingInviteToReply(i: { text: string; viewingDecided: boolean }): { yes: boolean; why: string } {
  const t = String(i.text ?? "").normalize("NFKC");
  // 10/09 竹内さんの答え（q053「どっちも気になります」＝見積書の後の気になる・退去予定の内覧はスタッフだけが知る中身＝AIX の番）・試験 q085（日程のやり取りの中の
  //   「26日の夕方18時頃なら空いてますでしょうか」）・q087（「ここ見てみたいです」）: 内覧の語が無いだけで返信に戻すと AIX の番を消していた → 既定で使わない。戻す VIEWING_GUARD_NO_WORD=on
  if ((typeof process !== "undefined" && (process.env?.VIEWING_GUARD_NO_WORD ?? "").toLowerCase() === "on") && !VIEWING_WORD_RE.test(t)) return { yes: true, why: "内覧を頼んでいない" };
  if (i.viewingDecided && !/変更|別の日|日程を?変え|ずら/.test(t)) return { yes: true, why: "決まった内覧への追加" };
  if (LATER_DATE_RE.test(t)) return { yes: true, why: "〇日以降の事情" };
  return { yes: false, why: "内覧の依頼" };
}

/**
 * 10/09 試験 q052: こちらがオンライン内覧（ビデオ通話・撮影して送る）の日時を出し、お客様が了承しただけの番は、待ち合わせ場所・内覧調整の AIX ではなく確定の返信
 *   （現地で待ち合わせない＝住所を送らない。竹内さんは「かしこまりました！！⏎9/7（月）16:00よりオンライン内覧させて頂きます」の形で返した）
 */
const ONLINE_VIEWING_RE = /オンライン(?:で|の|にて)?(?:内覧|内見)|ビデオ通話|テレビ電話/;
export function onlineViewingAck(i: { lastStaffTexts: ReadonlyArray<string>; customerText: string; ackOnly: boolean }): boolean {
  const recent = i.lastStaffTexts.slice(-2).join("\n");
  if (!ONLINE_VIEWING_RE.test(recent)) return false;
  const t = String(i.customerText ?? "").normalize("NFKC");
  return i.ackOnly || /^(?:はい|大丈夫|お願いします|了解|わかりました|分かりました|承知)/.test(t.trim());
}

/**
 * 10/09 試験の分解⑦（q055 q078）: 見積の AIX／見積の約束が「初期費用・見積」の語だけで決まっていた（物件が無い費用の質問は見積書ではない＝feedback_estimate_needs_property）。
 *   ①費用の語が無い（「アーバネックス気になります」）②まだ送っていない物件の費用（「他にも気になっている物件があるので、そちらも初期費用教えて」＝この番に URL・画像が無い）→ 返信
 */
const COST_WORD_RE = /初期費用|見積|いくら|費用|お値段|金額/;
const NOT_YET_SENT_RE = /(?:他にも|別に|ほかにも)[^。\n]{0,12}(?:気になって|ある|あります)[^。\n]{0,20}(?:物件|お部屋|部屋)/;
export function estimateToReply(i: { text: string; turnHasPropertyMedia: boolean }): { yes: boolean; why: string } {
  const t = String(i.text ?? "").normalize("NFKC");
  if (!COST_WORD_RE.test(t)) return { yes: true, why: "費用を聞いていない" };
  if (!i.turnHasPropertyMedia && NOT_YET_SENT_RE.test(t)) return { yes: true, why: "まだ送っていない物件の費用" };
  return { yes: false, why: "見積の番" };
}

/** 10/09 試験の分解③（q036）: 保証会社の種類を「条件」として言った番（クレカ系は控えたい・独立系がいい）は保証会社の説明の AIX ではなく探す約束 */
export function guarantorAsCondition(text: string): boolean {
  const t = String(text ?? "").normalize("NFKC");
  return /(?:保証会社|クレカ系|信販系|独立系|信用系)[^。\n]{0,12}(?:控えたい|避けたい|以外|がいい|が良い|希望|で探|にして)/.test(t) && !/(?:どこ|何|どの|種類)[^。\n]{0,6}(?:ですか|でしょうか|\?|？)/.test(t);
}
