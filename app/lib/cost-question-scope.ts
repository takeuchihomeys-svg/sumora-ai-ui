// app/lib/cost-question-scope.ts
// 物件がまだ無い時の費用の質問か（見積書ではなく、質問に答えて「初期費用を抑える」一文で返す場面）。
// 2026-09-14 竹内（ゆうこ事例）「見積書は物件が送られた時や物件の画像が送られた時等や見積依頼があった時」:
//   「これは分割払いで初期費用ですか？」（こちらの送付0・お客様の物件なし）に見積書の約束が入った。
//   実データ（120日）: 物件が無い時の費用の質問 15件でスタッフが見積書を約束したのは物件を指す・見積の依頼がある3件だけ。
//   残りは「初期費用も最大限割引させて頂き…抑えさせて頂きます」等で答えた。estimate-context の 3.（物件がある時だけ見積書）と同じ規則。
// 別ファイルなのは循環 import を避けるため（initial-cost-tight は reply-context が初期化時に使い、line-reply-prompts は reply-context を再輸出する）。
// 関数は呼ばれた時にだけ正規表現を読む（モジュールの初期化時には読まない）
import { CUSTOMER_COST_QUESTION_RE, CUSTOMER_ESTIMATE_REQUEST_RE, CUSTOMER_PROPERTY_REF_RE, FORM_LABEL_RE } from "./line-reply-prompts";

/** 場所・物件を指す語（「ここと ここと ここの初期費用」「ここの初期費用等出せますか」「この物件」）。「これは」（物・話題）は含めない */
const PLACE_DEMONSTRATIVE_RE = /(?:ここ|こちら|そこ|そちら)(?:の|は|って|も|と|だと|ですと)|この(?:物件|お?部屋|マンション)/;

/**
 * お客様の連投が物件か見積を指しているか（URL・画像・号室・物件名／「ここの」「この物件」／見積の語）。
 * 実データ（120日）で「物件が無い費用の質問」のうちスタッフが見積書を約束した5件は、URL が連投の前の通・「ここと ここと ここの」・
 * 「お見積もり確認したい」だった → 連投全体を見て、これらは物件・依頼ありとする
 */
export function customerPointsAtProperty(customerTurn: string | null | undefined): boolean {
  const t = (customerTurn ?? "").replace(FORM_LABEL_RE, " ");
  return CUSTOMER_PROPERTY_REF_RE.test(t) || CUSTOMER_ESTIMATE_REQUEST_RE.test(t) || /見積/.test(t) || PLACE_DEMONSTRATIVE_RE.test(t);
}

export function costQuestionBeforeProperty(customerTurn: string | null | undefined, sentPropertyCount: number): boolean {
  const t = (customerTurn ?? "").replace(FORM_LABEL_RE, " ");
  return sentPropertyCount === 0 && CUSTOMER_COST_QUESTION_RE.test(t) && !customerPointsAtProperty(t);
}
