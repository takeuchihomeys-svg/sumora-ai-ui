// app/lib/cost-question-kind.ts
// 費用の語を含むが「見積書を作って送る」場面ではない質問の形（純関数）。brain-core の信号0.96・信号1（→AIX【見積書送る】）の手前で外す。
//
// 2026-10-01 YUMA の再生テスト（scripts/yuma-replay-scenarios.ts・本番の実際の会話から作った場面）:
//   「初期費用の支払いはいつですか？」→ signal:estimate_sheet（スタッフは「ご入居日から5日から1週間ほど前…」と手打ち）
//   「家賃をいくらまでにしたら、堺筋本町あたりに物件が出てきますか？」→ signal:estimate_sheet（スタッフは「11万円、12万円に広げて頂けますと…」と手打ち）
//   どちらも CUSTOMER_COST_QUESTION_RE（初期費用…ですか／家賃…いくら）に当たって見積書送るに倒れ、AIX の道（自動で送れない）に入っていた（穴:G5）。
// 線: scripts/audit-cost-question-signal.ts（180日・費用の質問の番で、スタッフが返事のまとまりで見積書送るを押したか）。結果はこのファイルの下の表。
//   ここで外すのは信号（決定論）だけ。ブレイン（LLM）が見積書送ると判断した物は変えない＝入口のみ・本文は変えない
export type CostQuestionKind = "支払いの時期・方法" | "家賃の線の質問";

/** 支払いの時期・方法（いつ払う・一括か・分割・カード・振込） */
const PAYMENT_RE = /(?:支払|払い|払う|振込|振り込|入金|分割|一括|クレジット|カード払)[^\n。]{0,12}(?:いつ|いつまで|タイミング|方法|ですか|でしょうか|可能|でき|出来|ますか|よね)|(?:いつ|どのタイミング)[^\n。]{0,8}(?:支払|払|振込|振り込|入金)/;
/** 家賃・予算をいくらにすれば（広げれば）物件が出るか＝条件の線の質問 */
const RENT_LINE_RE = /(?:家賃|予算|賃料)[^\n。]{0,6}いくら(?:まで|以上|くらい|ぐらい)?(?:に(?:した|すれ|あげ|上げ)|まで(?:上げ|あげ|出せ|広げ)|あれば)|(?:家賃|予算)[^\n。]{0,12}(?:物件|お?部屋)[^\n。]{0,6}(?:出て|あり|見つか)/;
/** 見積書そのものを頼んでいる（これがあれば外さない） */
const ESTIMATE_ASK_RE = /見積|いくらに(?:なり|なる)|総額|合計(?:で|は)?いくら|いくらかかり/;

export function costQuestionNotEstimate(text: string | null | undefined): CostQuestionKind | null {
  const t = String(text ?? "");
  if (!t.trim() || ESTIMATE_ASK_RE.test(t)) return null;
  if (PAYMENT_RE.test(t)) return "支払いの時期・方法";
  if (RENT_LINE_RE.test(t)) return "家賃の線の質問";
  return null;
}
