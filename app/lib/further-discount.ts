// app/lib/further-discount.ts — 御見積書の後の「更に安くならないか」は AIX【確認します→代表確認（初期費用）】（純関数・LLM なし）
//
// 2026-10-08 竹内さん（10巡目の質問1への答え）: 「さらに安くならないか」と聞かれた時＝初期費用をさらに割引できるか＝代表確認。
//   ピッカー 代表確認（初期費用）で「弊社代表に更に割引可能か確認させて頂きます」をお客様へ送り、その結果は AIX【確認した→代表に確認した】で送る。
//   御見積書をまだ送っていない物件の「安くなりますか」は AIX【見積書送る】（9巡目の学習ルールの見直し 39d0ca54・af6d7319 と同じ線）。
//   実送信（10/08 点検）: AIX【確認します】6回は全部この形（代表への割引の確認・交渉）。竹内さんの手打ちも同じ中身（「更に初期費用割引出来ますよう弊社代表に申請させて頂きます」）。
//   家賃だけの値下げ（「家賃もう少し下がったりしないですよね」）は初期費用の割引ではない＝当てない（rent-negotiation-guard の領分）。
//   戻す: FURTHER_DISCOUNT_DAIHYO=off

/** 値下げ・割引の依頼の語（cost-explain-text の NEGOTIATION_RE と同じ語の並び＋「下げることは」「安くなりますか」） */
const DISCOUNT_ASK_RE = /安くなりませんか|安くなりますか|安くできますか|安く出来ますか|安くして(?:もら|いただ|頂)|もう少し安く|もう少し(?:抑え|下げ)|これ以上[^\n。]{0,10}(?:抑え|安く|下げ)|値引き|(?:割引|値下げ)[^\n。]{0,6}(?:ないんですか|ありませんか|できませんか|出来ませんか|して(?:もら|いただ|頂))|(?:礼金|敷金|初期費用|費用)[^\n。]{0,8}下げ(?:る|られ)/;
/** 初期費用の話か（家賃だけの値下げは除く） */
const COST_WORD_RE = /初期費用|費用|見積|礼金|敷金|割引|値段|金額|総額|仲介/;
const RENT_ONLY_RE = /家賃|賃料/;

/** お客様が今の番で初期費用を更に安くできないか聞いたか */
export function customerAsksFurtherDiscount(turnText: string | null | undefined): boolean {
  const t = String(turnText ?? "").normalize("NFKC");
  if (!DISCOUNT_ASK_RE.test(t)) return false;
  if (RENT_ONLY_RE.test(t) && !COST_WORD_RE.test(t)) return false;
  // 他社の見積と比べての不審（安すぎる理由）は 初期費用を説明 の領分・分割の話は返信（カード払い）
  if (/なぜ|なんで|理由|大丈夫(?:です|でしょう)か/.test(t) && !/もう少し|これ以上|更に|さらに/.test(t)) return false;
  return true;
}

export type FurtherDiscountInput = { turnText: string | null | undefined; estimateSent: boolean; postApply: boolean; env?: Record<string, string | undefined> };
/** AIX【確認します→代表確認（初期費用）】にするか（御見積書を送った後の更なる割引の依頼だけ） */
export function furtherDiscountDaihyo(i: FurtherDiscountInput): boolean {
  const env = i.env ?? (typeof process !== "undefined" ? process.env : {});
  if ((env.FURTHER_DISCOUNT_DAIHYO ?? "").toLowerCase() === "off") return false;
  return !i.postApply && i.estimateSent && customerAsksFurtherDiscount(i.turnText);
}
export const FURTHER_DISCOUNT_SOURCE = "rule:further_discount_daihyo";

/**
 * 交渉・申請の約束（「管理会社に礼金の減額交渉させて頂きます」「弊社代表に申請させて頂きます／承認降り次第ご連絡」）がまだ果たされていない時の
 * お客様のお礼・了承の番は、約束を果たす AIX【確認した（条件・交渉）→初期費用について（mgmt_initial_cost）】を立てる（10/08 竹内さんの答え7「それで大丈夫」）。
 *   旧は行動台帳が「交渉させて頂きます」を約束と読まず（classifyStaffTextFacts が空）、お礼の番は返信の下書きになっていた（d3a56a97 10/07）。
 *   交渉の結果はスタッフだけが知る情報（P0）＝AIX。戻す: NEGOTIATION_PROMISE_AIX=off
 */
export const NEGOTIATION_PROMISE_RE = /(?:交渉|申請)(?:を)?(?:させて(?:頂|いただ)きます|致します|いたします)|(?:交渉|承認|許可)[^\n。！!]{0,8}(?:出来|でき|降り|おり|下り|あり)次第/;
export function negotiationPromisePending(i: { lastStaffText: string | null | undefined; customerAckOnly: boolean; reportedAfter: boolean; env?: Record<string, string | undefined> }): boolean {
  const env = i.env ?? (typeof process !== "undefined" ? process.env : {});
  if ((env.NEGOTIATION_PROMISE_AIX ?? "").toLowerCase() === "off") return false;
  return i.customerAckOnly && !i.reportedAfter && NEGOTIATION_PROMISE_RE.test(String(i.lastStaffText ?? "").normalize("NFKC"));
}
export const NEGOTIATION_PROMISE_SOURCE = "promise:negotiation";
