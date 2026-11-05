// app/lib/decisions-1103.ts — 竹内さんの決定（11/03 夜・KB P1 1cef1a4e）No.15・17・19・21 のブレインの材料の1行（純関数・候補の網だけ・決めるのはブレイン＝P0）
//
//   No.15 締めの後の「よろしくお願いします」だけも返信しない（こちらが締めた後の、お礼・よろしくだけの番）
//   No.17 間取りの問いはその回だけの検索で、登録の条件は変えない（condition_change_scope=temporary）
//   No.19 場所が遠い・他の候補を は、内覧に触れず他の候補を先に
//   No.21 お礼だけの番で、内覧後・見積書の後に前向きな一言がある時だけ、申込への AIX（application_push）を候補に
//   No.20 保証会社の話は「別の保証会社でも審査できる・通過までサポート」の言い方に限る（ブレインと書き手の両方の材料）
// 切替（どれも既定 off）: BRAIN_CLOSED_THANKS_NO_REPLY・BRAIN_LAYOUT_ASK_TEMPORARY・BRAIN_FAR_OTHER_FIRST・BRAIN_ACK_POSITIVE_APPLY・BRAIN_GUARANTOR_WORDING
// テスト: app/lib/__tests__/decisions-1103.test.ts
type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
const on = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "on";
export const closedThanksNoReplyOn = (env: Env = envOf()) => on(env.BRAIN_CLOSED_THANKS_NO_REPLY);
export const layoutAskTemporaryOn = (env: Env = envOf()) => on(env.BRAIN_LAYOUT_ASK_TEMPORARY);
export const farOtherFirstOn = (env: Env = envOf()) => on(env.BRAIN_FAR_OTHER_FIRST);
// 2026-11-06 作業員4（弱い所 112）: 試験 ack-apply-on2（4問・悪化0・$0.177）で既定 on（竹内さんの決定 No.21・KB 3f67fd3f）。止める BRAIN_ACK_POSITIVE_APPLY=off
export const ackPositiveApplyOn = (env: Env = envOf()) => (env.BRAIN_ACK_POSITIVE_APPLY ?? "").trim().toLowerCase() !== "off";
export const guarantorWordingOn = (env: Env = envOf()) => on(env.BRAIN_GUARANTOR_WORDING);

const flat = (s: string | null | undefined) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "");
const THANKS_ONLY = /^(?:(?:はい|了解(?:しました|です)?|承知(?:しました|致しました)?|わかりました|かしこまりました)[、。!！]*)?(?:(?:何卒|どうぞ|引き続き)?よろしく(?:お願い(?:します|いたします|致します|しますm)?)?|ありがとうございます|ありがとうございました)[!！。〜ー🙇‍♀️🙇😊✨🙏]*$/u;
const STAFF_CLOSING = /(何卒よろしくお願い(?:致します|いたします)|お待ちしております|ご連絡お待ちしております|ご検討の程|お手隙の際にご査収|出次第(?:すぐに)?お送り|ご都合よろしいお日にち)/;

/** No.15: こちらが締めた後の、お礼・よろしくだけの番 */
export function closedThanksLine(turnText: string, lastStaffText: string | null | undefined): string {
  const t = flat(turnText);
  if (!t || t.length > 30 || !THANKS_ONLY.test(t) || !STAFF_CLOSING.test(lastStaffText ?? "")) return "";
  return "【竹内さんの決定 No.15（11/03）】こちらが締めた後の「よろしくお願いします」「ありがとうございます」だけの番は返信しない番（下書きを作らない・AIX も無し）。ただし新しい問い・依頼・気持ちが入っていれば返信する";
}

const LAYOUT_ASK = /(?:1R|1K|1DK|1LDK|2K|2DK|2LDK|3LDK|ワンルーム|間取り)[^。？?]{0,12}(?:あり|あります|ある|無い|ない|空い|出て|どう|でも)[^。]{0,6}[?？か]/;
/** No.17: 間取りを聞いただけの番＝その回だけの検索 */
export function layoutAskLine(turnText: string): string {
  const t = flat(turnText);
  if (!LAYOUT_ASK.test(t) || /(?:に変更|に変えて|で探して|に条件|条件を)/.test(t)) return "";
  return "【竹内さんの決定 No.17（11/03）】間取りを聞いただけの番は、その回だけの検索（condition_change_scope は temporary）。登録の条件は変えない（お客様が条件を変えると言った時だけ permanent）";
}

const FAR_OR_OTHER = /(遠い|遠く|遠すぎ|通えない|通勤(?:が|に)(?:不便|厳しい)|場所が(?:ちょっと|少し)?(?:微妙|悪い)|他の(?:候補|物件|お部屋)(?:も|を|は)|別の(?:物件|お部屋)(?:も|を|は))/;
/** No.19: 場所が遠い・他の候補を */
export function farOtherFirstLine(turnText: string): string {
  if (!FAR_OR_OTHER.test(flat(turnText))) return "";
  return "【竹内さんの決定 No.19（11/03）】「場所が遠い」「他の候補を」の番は、内覧に触れず、他の候補（ピックアップ・オススメ）を先に出す";
}

const POSITIVE = /(良かった|よかった|いい(?:です|感じ|な)|良い(?:です|感じ)|気に入|素敵|ステキ|最高|前向き|ここ(?:に|が)(?:します|いい)|決めたい|住みたい)/;
/** No.21: お礼だけの番で、内覧後・見積書の後に前向きな一言がある */
export function ackPositiveApplyLine(o: { turnText: string; afterViewing: boolean; afterEstimate: boolean }): string {
  const t = flat(o.turnText);
  if (!t || t.length > 80 || /[?？]/.test(t) || !(o.afterViewing || o.afterEstimate) || !POSITIVE.test(t)) return "";
  return `【竹内さんの決定 No.21（11/03）】お礼だけの番でも、${o.afterViewing ? "内覧の後" : "見積書の後"}に前向きな一言がある時は、申込への AIX（application_push）を候補に入れる（前向きな一言が無いお礼だけなら候補にしない）`;
}

const GUARANTOR_TOPIC = /(保証会社|保証人|審査(?:に|が|は)?(?:通|落|不安|心配|厳し|大丈夫)|ブラック|滞納|信用情報|債務整理|自己破産|否決)/;
/** No.20: 保証会社・審査の不安の話の言い方（ブレインと書き手で同じ1行） */
export const GUARANTOR_WORDING_RULE = "【竹内さんの決定 No.20（11/03）】保証会社・審査の話は「別の保証会社でも審査できる・審査通過までサポートさせて頂く」の言い方に限る（特定の保証会社なら通る・必ず通るとは言い切らない・保証会社の名前や仕組みの説明を広げない）";
export function guarantorWordingLine(text: string | null | undefined): string {
  return GUARANTOR_TOPIC.test(flat(text)) ? GUARANTOR_WORDING_RULE : "";
}
