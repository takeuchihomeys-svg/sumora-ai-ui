// app/lib/alt-pii-gate.ts
// DeepSeek（別クラウド）に回す直前の共通の門: 送る本文に個人を特定する「値」があれば Claude に戻す（純関数）。
//
// 2026-10-15 竹内「核となるブレインはアンソロピック（Claude）に。核じゃない所を DeepSeek にする。個人情報は渡さないのを徹底」:
//   今までの守り（llm-alt-provider の出口）は「申込以降の印」「時刻の線の印（会話の呼び出し）」「線より前の発言の網（cut の時だけ）」と、
//   入口ごとの名前・番号の伏せ（maskPII）で、本文そのものに個人の値が残っていないかを見る網は**テストの間だけ**（test-pii-guard.testPiiRefusal）だった。
//   → 本番でも、回すと決まった呼び出しの本文に値が残っていれば Claude に戻す（入口の伏せ漏れの最後の歯止め・fail-closed）。
//
// 【見るのは「値」だけ】本文には指示文（「本人確認書類（運転免許証・パスポート）…」「生年月日」等の語）が入るので、語では止めない（止めると全部が Claude に戻る）。
//   ・携帯電話の番号（070/080/090）・メールアドレス・記入済みの申込フォーム … test-pii-guard と同じ形（実データ YUMA 504通で当たり 0）
//   ・生年月日は**欄の名前と組**の時だけ（「生年月日 1995年…」）。test-pii-guard の「平成27年3月」は物件の築年月と同じ形なので本番の門では使わない
//   ・個人番号・免許証番号（欄の名前と組）・口座番号の値。欄の無い12桁の番号は見ない（レインズの物件番号・SUUMO の jnc_ と同じ形）
//   住所は物件の所在地と同じ形なので値では見ない（申込フォームの欄・郵便番号の伏せ＝maskPII の側で守る）。
// 止める: LLM_ALT_PII_GATE=off（既定 on）

import { MOBILE_RE, EMAIL_RE, APPLICATION_FORM_RE, INCOME_VALUE_RE } from "./test-pii-guard";

const URL_RE = /https?:\/\/[^\s"'<>）)]+/g;
/** 生年月日の欄と値の組（「生年月日：1995年3月12日」「生年月日 平成7年」「生年月日 1995/03/12」） */
export const LABELED_BIRTH_RE = /生年月日\s*[:：]?\s*(?:(?:19|20)\d{2}\s*[年/.\-]|(?:昭和|平成|令和)\s*(?:\d{1,2}|元)\s*年)/;
/** 申込フォームの生年月日の値（年月日の漢字つき・2010年以前） */
const BIRTH_FULL_RE = /(?:19\d{2}|200\d)\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/;
/** 個人番号・免許証番号の欄と値 */
export const LABELED_ID_RE = /(?:マイナンバー|個人番号|免許証番号|運転免許証番号|保険証番号|在留カード番号)\s*[:：は]?\s*[0-9０-９]/;
/** 口座番号の値 */
export const BANK_ACCOUNT_RE = /口座番号\s*[:：は]?\s*[0-9０-９]{6,8}/;

/** 送る本文に個人を特定する値があれば理由（日本語）・無ければ null */
export function altPiiSignal(text: string | null | undefined): string | null {
  const raw = String(text ?? "");
  if (!raw) return null;
  const t = raw.replace(URL_RE, " ");
  if (APPLICATION_FORM_RE.test(t) && (MOBILE_RE.test(t) || BIRTH_FULL_RE.test(t) || LABELED_BIRTH_RE.test(t) || INCOME_VALUE_RE.test(t))) return "記入済みの申込フォーム";
  if (MOBILE_RE.test(t)) return "携帯電話の番号";
  if (EMAIL_RE.test(t)) return "メールアドレス";
  if (LABELED_BIRTH_RE.test(t)) return "生年月日の値";
  if (LABELED_ID_RE.test(t)) return "個人番号・免許証番号";
  if (BANK_ACCOUNT_RE.test(t)) return "口座番号";
  return null;
}

/** 門を使うか（既定 on・LLM_ALT_PII_GATE=off で止める） */
export function altPiiGateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.LLM_ALT_PII_GATE ?? "on").trim().toLowerCase() !== "off";
}
