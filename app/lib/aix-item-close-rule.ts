// app/lib/aix-item-close-rule.ts — AIX要対応（aix_action_items）を、送った AIX で閉じてよいかの決まり（純関数・DB/LLM なし）
//
// 2026-11-15 作業員L（竹内さん 11/15「ちゃんと送った事や確認した事を把握する部分も強化」・統括役の頼み2）。
//   今の completeAixActionItem は、その会話で AIX を1つでも送ると、勧めた AIX と種類が違っても待ちの行を閉じる（done_matched=false で記録するだけ）。
//   30日で勧めと違う AIX で閉じた 72件: 済んだと読める 約20（見積→物件確認した＋見積書を同封 8・物件送付→物件オススメ 9・内覧調整→待ち合わせ場所 3）・
//   要確認 約15（物件確認→見積書 10 等）・誤って閉じた疑い 約37（物件確認→物件オススメ 5・→電話 5・内覧の誘い→物件確認 3 …）。
// 決まり（AIX_ITEM_CLOSE_STRICT=on の時・既定 off）: 同じ種類か、下の「同じ要件を果たす組」の時だけ閉じる。それ以外は待ちのまま残し、
//   resolution_note に「別の AIX（種類）を送った・果たしたか確かめる」を書く（スタッフへの指示と統括が読む）。
type Env = Record<string, string | undefined>;
export const aixItemCloseStrictOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.AIX_ITEM_CLOSE_STRICT ?? "").trim().toLowerCase() === "on";
const norm = (x: string) => (x === "property_check" ? "property_check_result" : x);
/** 勧めた AIX → それで果たしたと読める AIX（同じ要件・先の段階）。estimate は見積書を同封した時だけ */
const FULFIL_BY: Readonly<Record<string, ReadonlyArray<string>>> = {
  property_send: ["property_recommendation"],
  property_recommendation: ["property_send"],
  viewing_invite: ["meeting_place"],
  estimate_sheet: ["property_check_result+estimate"],
};
export type CloseDecision = { close: boolean; matched: boolean; why: string };
export function aixItemCloseDecision(action: string, sentAix: string, o: { estimateSent?: boolean | null } = {}): CloseDecision {
  const a = norm(action), s = norm(sentAix);
  if (a === s) return { close: true, matched: true, why: "同じ AIX" };
  const ok = (FULFIL_BY[a] ?? []).some((x) => x === s || (x === `${s}+estimate` && o.estimateSent === true));
  if (ok) return { close: true, matched: false, why: `同じ要件を果たす AIX（${s}）` };
  return { close: false, matched: false, why: `別の AIX（${s}）を送った・勧めた ${a} を果たしたか確かめる` };
}
