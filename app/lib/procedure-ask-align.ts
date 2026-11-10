// 手続きの一般の問いで返信に決めた番の「依頼の答え方」をそろえる（純関数）
//
// 2026-11-10 作業員1（型2・q374「最短入居日どのくらいですね」・試験 proc-points-on-1108b）:
//   規則（rule:procedure_question_reply・PROCEDURE_UNKNOWN_POINTS_ONLY の一般の問い）で道は「返信」に直ったのに、
//   ブレインの turn_contract の asks は route=promise（「確認しご連絡」）・priorities は handling=confirm のまま残り、
//   試験の判定は「依頼の答え方の抜け」（asks 1/1 ✕）・書き手に「確認の約束」と読める材料が残っていた（brain:priority h={"confirm":1}）。
//   竹内さん本人の実送信（200日・最短の入居の問い）: 物件を指さない一般の問い 4/4 を会社の事実で本文の返信
//   （10/26「お申込し早くて1週間〜2週間でご入居可能」・10/20「お申込みからご入居までは最短でも1週間〜2週間ほど」・07/07・06/30）、
//   「この物件／こちらの物件」と指す問い 2/2 は AIX（確認した結果・09/09・08/31）＝道の規則と同じ線。
//   ここは道を変えない（返信に決まった後の、依頼の項目の答え方だけを道にそろえる）。turn-contract.reconcileTurnContractWithAix と同じ考え。
//   既定 on（2026-11-11・proc-ask-dig-1111 悪化0・止める PROCEDURE_GENERAL_ASK_REPLY=off）
import { detectProcedureQuestion, isProcedureReplyQuestion } from "@/app/lib/procedure-question";

export function procedureGeneralAskReplyOn(env: Record<string, string | undefined> = process.env): boolean {
  // 2026-11-11 既定 on（proc-ask-dig-1111 確かな悪化0・道/本質の悪化0・q374 の依頼が○に・止める PROCEDURE_GENERAL_ASK_REPLY=off）
  return (env.PROCEDURE_GENERAL_ASK_REPLY ?? "").trim().toLowerCase() !== "off";
}

/** 答えの目安（会社の事実の側・数字は company-facts screening_flow／竹内さん 11/05 No.4 と同じ） */
export const PROCEDURE_GENERAL_ASK_ANSWER = "会社の事実で本文で答える（お申込みから審査・契約のお手続きを経て最短1〜2週間程でご入居の目安・管理会社への確認の約束にしない）";

/** その依頼の文が一般の手続きの問い（審査・入居までの期間と流れ）か。必要書類だけの問いも返信の側 */
export function isProcedureAskText(text: unknown): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return isProcedureReplyQuestion(detectProcedureQuestion(t));
}

type Ask = { quote?: unknown; topic?: unknown; route?: unknown; answer?: unknown; basis?: unknown; aix?: unknown; [k: string]: unknown };

/**
 * 返信に決まった番（finalAix なし）で、手続きの問いの依頼が promise／aix のまま → reply・basis=company_fact に直す。
 *   他の依頼（物件・費用・探す 等）はそのまま。直した数を返す。
 */
export function alignProcedureAsks<T extends { asks?: Ask[] | unknown }>(
  raw: T | null,
  o: { on: boolean; replyTurn: boolean },
): { contract: T | null; changed: number } {
  if (!raw || !o.on || !o.replyTurn) return { contract: raw, changed: 0 };
  const asks = (raw as { asks?: unknown }).asks;
  if (!Array.isArray(asks)) return { contract: raw, changed: 0 };
  let changed = 0;
  const next = asks.map((a: Ask) => {
    if (!a || (a.route !== "promise" && a.route !== "aix")) return a;
    if (!isProcedureAskText(a.quote) && !isProcedureAskText(a.topic)) return a;
    changed++;
    return { ...a, route: "reply", aix: null, basis: "company_fact", answer: PROCEDURE_GENERAL_ASK_ANSWER };
  });
  return changed ? { contract: { ...raw, asks: next } as T, changed } : { contract: raw, changed: 0 };
}

type PItem = { quote: string | null; item: string; handling: string; aix: string | null; reason: string; [k: string]: unknown };

/** 優先の項目も同じ: 手続きの問いの項目の confirm／aix → answer_now（返信に決まった番だけ） */
export function alignProcedurePriorities<P extends PItem>(items: P[] | undefined, o: { on: boolean; replyTurn: boolean }): { items: P[] | undefined; changed: number } {
  if (!items || !o.on || !o.replyTurn) return { items, changed: 0 };
  let changed = 0;
  const next = items.map((p) => {
    if (p.handling !== "confirm" && p.handling !== "aix") return p;
    if (!isProcedureAskText(p.quote) && !isProcedureAskText(p.item)) return p;
    changed++;
    return { ...p, handling: "answer_now", aix: null, reason: `${p.reason ? `${p.reason}／` : ""}手続きの一般の問い＝会社の事実で返信` } as P;
  });
  return changed ? { items: next, changed } : { items, changed: 0 };
}
