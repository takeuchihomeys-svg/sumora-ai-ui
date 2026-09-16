// app/lib/two-choice.ts
// 「AIX か返信か」の2択をセットする場面の判定（純関数・DB 依存なし）。
//
// 2026-09-15 竹内（みく事例・承認）: 重要な場面は2択をブレインがセットし、自動の下書きは作らない。
// 2026-09-16 竹内（慶次事例）「この場合は物件ピックアップと返信の2択をセットする。場合によってはここはいきなり
//   物件ピックアップで詰めるのが良いし、または返信して約束して、物件まとめて送った方が良いから、
//   これはスタッフの状況にもよるので、2択でセットする形とする」:
//   慶次 11:40「礼金10万がネックですねぇ／初期費用がどれぐらいか／今から仕事ですので、他にあれば、送っておいてください。／
//   確認して見たい物件があれば、ご連絡致します。」→ 画面は AIX 物件ピックアップの1択だった。
//   実データ（120日・「他にあれば送って」型 9件）: スタッフの次の一手は「返信して約束」5件（「かしこまりました！！
//   新着でオススメできるお部屋お送りさせていただきます」）・AIX で即送付は0件。どちらも正解になりうるので選ばせる。

/**
 * 条件のトレードオフ質問（築年数・家賃・設備の妥協の相談）。
 * 成約データ（closed_won 15件）: この後は物件の追加送付が最多（5件）・相場や条件の説明の返信で決まった例もある（2件）
 */
export const TRADEOFF_QUESTION_RE =
  /築年数.{0,15}(古|どう|気になる|問題|大丈夫|基準|影響)|古.{0,10}(どう|問題|大丈夫|気になる)|リノベ|ユニットバス|バスト(?:イレ|レ)一緒|設備.{0,15}(どう|どんな|どれ|変わ|なくな|難し)|[0-9０-９万]+(円)?(台|以下|だと|の部屋).{0,20}(難し|厳し|無理|ないです|ありませ)|家賃.{0,10}(安く|下げ|抑え).{0,15}(設備|広|築|駅)|狭く(なって|てもいい|ても)|間取り.{0,10}妥協|妥協.{0,10}(すると|したら|すれば)|なぜ.{0,5}(高い|安い|この値段)|なんで.{0,5}(高い|安い)|価格.{0,10}(違い|差|同じ|なぜ)|差は何|何が違う|この物件.{0,5}(高い|安い|妥当|なぜ)|相場.{0,15}(どう|いくら|教え|知りたい)|[0-9０-９\.]+万.{0,5}と.{0,5}[0-9０-９\.]+万.{0,10}(違い|差)/;

/** お客様が「他のお部屋も送ってほしい」と依頼した（今すぐ物件を出すか、返信して約束するか） */
export const MORE_PROPERTY_REQUEST_RE =
  /(?:他|ほか|別)(?:に|の)[^\n。！!]{0,12}(?:あれば|ありましたら|ございましたら|物件|お部屋)[^\n。！!]{0,16}(?:送っ|お送り|教え|ご連絡|探し|ピックアップ)|(?:他|ほか)に[^\n。！!]{0,8}(?:物件|お部屋)[^\n。！!]{0,8}探/;
/** 探すのを止める・待ってほしい（依頼ではない）。「他のお部屋探し保留でも大丈夫ですか」を2択にしない */
const PAUSE_SEARCH_RE = /保留|一旦(?:止|ストップ|やめ)|止めて|ストップ|見送/;

export type TwoChoiceVerdict = { two: boolean; reason: string };

/**
 * 2択（AIX か返信か）をセットする場面か。
 *   必ず要るもの: 物件提案中・送付済み物件が1件以上・お客様の発言がある
 *   出す場面: ①条件のトレードオフの相談 ②他のお部屋の依頼（＋費用・条件の質問や懸念が同じ連投にある）③ブレインが2択と判断
 *   出さない場面: 新しい条件の追加（物件探しが正解）・確定アクション（内覧・申込・待ち合わせ）・お客様が断っている
 */
export function resolveTwoChoice(o: {
  customerText: string | null | undefined;
  checkpointStage: string | null | undefined;
  sentPropertyCount: number;
  finalAix: string | null | undefined;
  conditionChangeType: string | null | undefined;
  customerIntent: string | null | undefined;
  llmTwoChoice?: boolean;
}): TwoChoiceVerdict {
  const no = (reason: string): TwoChoiceVerdict => ({ two: false, reason });
  const t = (o.customerText ?? "").trim();
  if (!t) return no("no_customer_text");
  if (o.checkpointStage !== "proposing") return no("not_proposing");
  if (o.sentPropertyCount <= 0) return no("no_sent_property");
  if (o.finalAix === "viewing_invite" || o.finalAix === "application_push" || o.finalAix === "meeting_place") return no("decided_action");
  if (o.customerIntent === "negative") return no("customer_negative");
  if (PAUSE_SEARCH_RE.test(t)) return no("pause_search");
  // お客様が「他のお部屋も送ってほしい」と**はっきり頼んだ**時は、条件の変更（礼金がネック 等）が一緒にあっても2択にする。
  //   慶次 11:40「礼金10万がネックですねぇ／初期費用がどれぐらいか／他にあれば、送っておいてください」はブレインが
  //   condition_change_type を立てており、旧の除外（新しい条件の追加は物件探しが正解）で2択が消えていた。
  //   今すぐ物件を出すか、返信して約束してからまとめて送るかはスタッフの状況次第（竹内さんの指摘）
  if (MORE_PROPERTY_REQUEST_RE.test(t)) return { two: true, reason: "more_property_request" };
  if (o.conditionChangeType) return no("condition_change");
  if (TRADEOFF_QUESTION_RE.test(t)) return { two: true, reason: "tradeoff_question" };
  if (o.llmTwoChoice) return { two: true, reason: "llm" };
  return no("no_signal");
}
