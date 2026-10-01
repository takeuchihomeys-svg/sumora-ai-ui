// app/lib/cost-question-estimate.ts
// 費用の質問に AIX【見積書送る】が本当に合う時だけを決める（純関数・入口）。brain-core の信号0.96・信号1（決定論の合図）と
// LLM が 見積書送る を選んだ時の補正の両方から呼ぶ。
//
// 2026-10-02 竹内さんの決定「費用の質問の合図を実際の LINE から引き直す」:
//   ⑦（10/01）の測り: 180日の費用の質問 421番でスタッフが見積書送るを押したのは 59（約14%）＝合図が広すぎる。
//   scripts/audit-cost-question-estimate.ts（AIX の記録が揃う 7/15〜・277番）で 59 と残りを全部目で読んだ:
//   ・スタッフがしたこと: 見積書送る（すぐ）53・（後で）22・見積書を手で約束/送付 40・物件確認した 25・手打ち（見積なし）119・他の AIX 18
//   ・**1つの特徴では分かれない**（見積の語あり 13%・物件を指す 17%・こちらの送付 3時間以内 21%・引用返信 28%）。
//     分かれるのは**質問の中身**: 見積書を押した 75番はほぼ全部「ここ／こちら／〇〇の初期費用 いくら・どのくらい・教えて・知りたい」か
//     「見積もり お願い・欲しい・出して」。押さなかった 119番の手打ちは次の型がほとんど（目で読んで分けた）:
//       ①値下げ・交渉（「もう少し安くなりませんか」「礼金下げることは厳しいですか」「交渉お願いしたい」）→ 代表への申請・最大限割引済みの説明
//       ②もっと安い物件の依頼（「もっと初期費用安くなる物件ないですか」「江坂くらい安いおうちは」）→ ピックアップ
//       ③費用の1項目（火災保険・更新料・退去費用・保証料・水道代・駐車場）→ 答える／管理会社に確認
//       ④見積書へのお礼・受け取り（「見積もりありがとうございます」）→ 見積書を作らない（旧の CUSTOMER_ESTIMATE_REQUEST_RE は「ありがとう」も依頼に数えていた）
//       ⑤他社の御見積書の画像（「御見積書 様 この度は…ご利用頂き」）→ 比べて答える
//       ⑥相場・平均（「1LDKだと平均的に家賃いくら」）・金額の確かめ（「¥36,260 は…の合計額でよろしいでしょうか」）→ 答える
//       ⑦お客様が持ち込んだ物件（URL・ポータルの画像）→ 「募集状況確認させて頂きます」が先（物件確認した＋御見積書同封）。
//         持ち込みの番 115 のうち 見積書の動き 44（38%）・物件確認した/確認の宣言 約60%。10/01 竹内さん「持ち込みは物件確認したから」と同じ向き
//   ・ブレインの記録がある番（9/12〜）: LLM が 見積書送る 20 → 押した 14（70%）／信号が 見積書送る 4 → 押した 0。
//   既存の決まりは先に効かせる（呼び出し側の順番のまま）: 物件が無い費用の質問は見積書にしない（cost-question-scope）／
//   中身の質問 S9 → 初期費用について／家賃込みか → 返信／支払いの時期・方法・家賃の線 → 返信（cost-question-kind）／安さへの不審 S8 → 初期費用を説明。

import { costQuestionNotEstimate } from "./cost-question-kind";
import { isRentIncludedQuestion } from "./rent-included-question";
import { customerAsksCostComposition } from "./cost-breakdown";
import { customerDoubtsCheapness } from "./cost-explain-text";

export type CostQuestionEstimateInput = {
  /** 今回のお客様の連投（まとめた文） */
  turnText: string;
  /** 今回の連投に画像がある */
  turnHasImage: boolean;
  /** 今回の連投がこちらの通への引用返信 */
  turnQuotesOurMessage: boolean;
  /** こちらが最後に物件（資料・🌟・物件確認の結果）を送ってからの時間。送っていなければ null */
  hoursSinceOurLastPropertySend: number | null;
  /** 最後の物件の送付の後に AIX【見積書送る】を送り済み */
  estimateSentSinceLastPropertySend: boolean;
  /** 直前（数通）にお客様が物件の URL・画像を送っていた（今回より前） */
  customerSentPropertyEarlier: boolean;
};

export type CostQuestionEstimateAction = "estimate_sheet" | "property_check_result" | null;
export type CostQuestionEstimate = {
  /** 見積書送るが合う */
  estimate: boolean;
  /** 合う AIX（見積書送る／物件確認した（持ち込み・御見積書同封）／null＝返信・他の決まり） */
  action: CostQuestionEstimateAction;
  /** 理由（監査・decision_source 用） */
  reason: string;
};


/** ①値下げ・交渉（最大限割引の後のもう一押し）。「初期費用を抑えたい」だけ（懸念）は信号0.9 が先に拾う */
const NEGOTIATION_RE = /(?:もう少し|もっと|さらに|更に|もうちょい|もうちょっと|少しでも|なんとか|どうにか)[^。\n？?]{0,12}(?:安く|下げ|下が|抑え|割引|値引|頑張|安くな)|値下げ|値引き|交渉|減額|(?:下げ|抑え|安くす)る(?:の|こと)?(?:は|って)?[^。\n]{0,4}(?:厳し|難し|無理|でき|出来|可能)|安くなりませんか|安くなりますか|お安く(?:して|なり)|以内に(?:でき|出来)(?:ない|ませ)/;
/** ②もっと安い物件の依頼（「初期費用安くなる物件ないですか」「江坂くらい安いおうちはないでしょうか」） */
const CHEAPER_LISTING_RE = /(?:安い|安く|安め|抑え(?:られ|れ)?る|抑えた)[^。\n]{0,14}(?:物件|お?部屋|とこ|ところ|おうち|お家|家)[^。\n]{0,10}(?:ない|あり|探|教え|欲し|ほし)|(?:安い|安く)[^。\n]{0,6}(?:とこ|ところ|おうち|お家)[^。\n]{0,4}(?:は|って)?(?:なかなか|中々)?ない/;
/** ③費用の1項目（初期費用の総額・見積ではない） */
const SINGLE_FEE_ITEM_RE = /火災保険|更新料|退去(?:時|費)|クリーニング|保証料|水道代|水道料|駐車場|駐輪|バイク置き場|鍵交換|町内会|安心(?:クラブ|サポート)|月々|毎月|月額/;
/** 初期費用の総額・見積そのもの */
const TOTAL_ASK_RE = /初期費用|見積|総額|合計(?:で|は)?(?:いくら|どの)|トータル|最初の費用|入居(?:時|する時|に)(?:の)?費用|いくら(?:かかり|くらい|ぐらい|位)|(?:いくら|どのくらい|どれくらい|どれぐらい|どのぐらい)(?:に)?(?:なり|かかり)/;
/** 金額を聞く・知りたい・教えての述部（「〇〇の初期費用教えて」「こちらの初期費用はどうですか」「計算してもらえると」） */
const AMOUNT_ASK_RE = /いくら|どのくらい|どれくらい|どれぐらい|どのぐらい|どんな感じ|どんなもん|おいくら|教えて|知りたい|聞いても|お伺い|わかり(?:ます|ません)|分かり(?:ます|ません)|分からない|わからない|出(?:して|せ)|どう(?:ですか|でしょう)|計算|(?:初期費用|総額)(?:です|でしょう)か|初期費用[^。\n]{0,12}[0-9０-９][^。\n]{0,12}(?:です|でしょう)か/;
/** 「ここ／こちら／この物件 … いくら」 */
const HERE_AMOUNT_RE = /(?:ここ|こちら|そこ|そちら|この(?:物件|お?部屋)|これ)(?:の|は|って|だと|も|で)?[^。\n]{0,10}(?:いくら|おいくら|どのくらい|どれくらい|どれぐらい|どのぐらい)/;
/** 見積の依頼の述部 */
const ESTIMATE_REQUEST_RE = /見積(?:書|り|もり)?(?:を|も|が|は|の|だけ|の方)?[^\n。]{0,8}(?:お願い|欲しい|ほしい|ください|下さい|頂け|いただけ|出して|出せ|送って|作って|貰え|もらえ|可能|できます|出来ます|見たい|みたい|欲しく|ほしく|依頼)/;
/** ④見積書へのお礼・受け取り・確認しますの返事（旧の CUSTOMER_ESTIMATE_REQUEST_RE は「見積もりありがとうございます」も依頼に数えていた） */
const ESTIMATE_THANKS_RE = /見積(?:書|り|もり)?(?:を|の)?(?:ご送付|お送り|送付)?(?:いただき|頂き|して(?:いただき|頂き|下さり|くださり))?[^。\n]{0,6}(?:ありがと|有難|有り難|確認させて|拝見)/;
/** 再見積・条件を変えた見積の依頼（見積済みでも見積書送る） */
const RE_ESTIMATE_RE = /再(?:度)?(?:見積|お見積)|もう(?:一度|1回|一回)[^。\n]{0,8}見積|(?:も|を)含め(?:て)?[^。\n]{0,12}見積|見積(?:もり|り)?[^。\n]{0,8}(?:し直|出し直|やり直)|入居(?:した|する)?場合[^。\n]{0,10}(?:いくら|初期費用)|日に入居[^。\n]{0,12}(?:いくら|初期費用)/;
/** ⑤他社の御見積書（画像の読み取りの文）: 「御見積書 様 … この度は…ご利用頂き」 */
const OTHER_COMPANY_ESTIMATE_RE = /御見積書[\s\S]{0,60}(?:この度は|ご利用頂き|ご利用いただき)/;
/** ⑥相場・平均の質問 */
const MARKET_RE = /平均|相場|一般的に|だいたいの家賃/;
/** ⑥金額の確かめ（数字＋ですか／でよろしいでしょうか） */
const AMOUNT_CONFIRM_RE = /[0-9０-９][0-9０-９,，.．]*\s*(?:円|万)[^。\n]{0,20}(?:ですか|でしょうか|よろしい|であって|で合って|の認識)/;
/** ⑦持ち込みの物件（ポータルの URL・画像）。この番で送ってきた時 */
const PORTAL_URL_RE = /https?:\/\/(?:[a-z0-9.-]*\.)?(?:suumo|homes|athome|chintai|canary-app|canary|goodrooms|smocca|ielove|tiktok|apamanshop|minimini|able|eheya|door|o-uccino|realestate|shamaison|daiwaliving|leopalace|myhome\.nifty|ieselect)/i;
const PORTAL_IMAGE_TEXT_RE = /物件情報|空室状況|お問い合わせ|内見予約|間取り[:：]|賃料|管理費|築年数|SUUMO|HOME'?S|CANARY|カナリー|アットホーム|smocca/i;

/**
 * 費用の質問に AIX【見積書送る】が合うか。
 * 呼び出し側の前提: 費用の質問（CUSTOMER_ESTIMATE_INTENT_RE）で、物件が会話にある（propertyInPlay）こと。
 */
export function resolveCostQuestionEstimate(i: CostQuestionEstimateInput): CostQuestionEstimate {
  const t = String(i.turnText ?? "");
  const no = (reason: string): CostQuestionEstimate => ({ estimate: false, action: null, reason });
  const yes = (reason: string): CostQuestionEstimate => ({ estimate: true, action: "estimate_sheet", reason });
  if (!t.trim()) return no("空");
  // 既存の決まり（別の AIX・返信）を先に
  const kind = costQuestionNotEstimate(t);
  if (kind) return no(`既存:${kind}`);
  if (isRentIncludedQuestion(t)) return no("既存:家賃込みか");
  if (customerDoubtsCheapness(t)) return no("既存:安さへの不審(S8)");
  if (customerAsksCostComposition(t)) return no("既存:費用の中身(S9)");
  // ⑤他社の御見積書
  if (OTHER_COMPANY_ESTIMATE_RE.test(t)) return no("他社の御見積書");
  const estimateRequest = ESTIMATE_REQUEST_RE.test(t) && !ESTIMATE_THANKS_RE.test(t.replace(ESTIMATE_REQUEST_RE, ""));
  const reEstimate = RE_ESTIMATE_RE.test(t);
  const totalAmountAsk = TOTAL_ASK_RE.test(t) && AMOUNT_ASK_RE.test(t);
  const hereAmountAsk = HERE_AMOUNT_RE.test(t);
  const namedInitialCostAsk = /(?:の|は)初期費用[^。\n]{0,4}(?:教えて|いくら|知りたい|どの|どれ)/.test(t);
  // ④見積書へのお礼・受け取りだけ（新しい依頼が無い）
  if (ESTIMATE_THANKS_RE.test(t) && !estimateRequest && !reEstimate && !(totalAmountAsk && /[？?]|ですか|ますか|でしょうか|教えて|知りたい/.test(t.replace(ESTIMATE_THANKS_RE, "")))) return no("見積書へのお礼・受け取り");
  // ②もっと安い物件の依頼（このお部屋の初期費用も同時に聞いた時は見積書の方）。「もっと…安くなる物件」を値下げと読まないよう①より先
  if (CHEAPER_LISTING_RE.test(t) && !estimateRequest && !hereAmountAsk && !namedInitialCostAsk) return no("もっと安い物件の依頼");
  // ①値下げ・交渉（見積の依頼を同時にしていない時）
  if (NEGOTIATION_RE.test(t) && !estimateRequest && !reEstimate) return no("値下げ・交渉");
  // ⑥相場・平均
  if (MARKET_RE.test(t) && !estimateRequest) return no("相場・平均の質問");
  // ⑥金額の確かめ（「家賃81000円ですよね」）。初期費用・見積の語がある確かめ（「初期費用119.000円ですか？」）は見積書で答える
  //   （見積書の後の総額の確かめ S6 は呼び出し側の決まりが先）
  if (AMOUNT_CONFIRM_RE.test(t) && !estimateRequest && !reEstimate && !/初期費用|見積/.test(t)) return no("金額の確かめ");
  // ③費用の1項目だけ（項目を除いた残りに総額・見積の語が無い）
  if (SINGLE_FEE_ITEM_RE.test(t) && !TOTAL_ASK_RE.test(t.replace(new RegExp(SINGLE_FEE_ITEM_RE.source, "g"), " "))) return no("費用の1項目");
  // 見積の依頼でも金額の質問でもない（「費用が心配」「初期費用は抑えたい」等）
  if (!estimateRequest && !reEstimate && !totalAmountAsk && !hereAmountAsk) return no("金額・見積の依頼ではない");
  // ⑦お客様がこの番で物件を持ち込んだ（ポータルの URL・画像）→ 物件確認した（募集状況の確認＋御見積書同封）
  const broughtNow = PORTAL_URL_RE.test(t) || (i.turnHasImage && PORTAL_IMAGE_TEXT_RE.test(t));
  if (broughtNow && !i.turnQuotesOurMessage) return { estimate: false, action: "property_check_result", reason: "持ち込みの物件（募集状況の確認が先）" };
  // 最後の物件の後に見積書を送り済み（再見積・見積の依頼でなければ）→ 送り直さない（総額の確かめは S6 の決まりが受け持つ）
  if (i.estimateSentSinceLastPropertySend && !reEstimate && !estimateRequest) return no("見積書は送り済み");
  return yes(estimateRequest ? "見積の依頼" : reEstimate ? "再見積の依頼" : "物件の初期費用の質問");
}

/** 理由のうち「見積書ではない」とはっきり言える物（LLM が 見積書送る を選んでも外す）。それ以外の no は LLM の判断を残す */
export const CLEAR_NOT_ESTIMATE_REASONS: ReadonlySet<string> = new Set([
  "値下げ・交渉", "もっと安い物件の依頼", "費用の1項目", "見積書へのお礼・受け取り", "他社の御見積書", "相場・平均の質問", "金額の確かめ",
]);

const OUR_PROPERTY_TEXT_RE = /🌟|[0-9０-９]{2,4}号室|ご査収/;
type MsgLite = { sender: string; text: string | null; created_at: string; quoted_message_id?: string | null };
type AixLite = { aix_type: string | null; created_at: string; sent_at?: string | null };

/**
 * 会話の最近の通（新しい順）と AIX の記録（新しい順）から入力を作る（brain-core の2か所と監査で同じ形）。
 * 今回の連投＝最後のこちらの通より後のお客様の通。
 */
export function costQuestionInputFrom(msgsNewestFirst: ReadonlyArray<MsgLite>, aixNewestFirst: ReadonlyArray<AixLite>, nowIso?: string): CostQuestionEstimateInput {
  const lastOurs = msgsNewestFirst.find((m) => m.sender !== "customer") ?? null;
  const turn = msgsNewestFirst.filter((m) => m.sender === "customer" && (!lastOurs || m.created_at > lastOurs.created_at)).reverse();
  const turnStart = turn[0]?.created_at ?? nowIso ?? new Date().toISOString();
  const sendTimes = [
    ...aixNewestFirst.filter((a) => a.aix_type === "property_send" || a.aix_type === "property_recommendation" || a.aix_type === "property_check_result").map((a) => a.sent_at ?? a.created_at),
    ...msgsNewestFirst.filter((m) => m.sender !== "customer" && OUR_PROPERTY_TEXT_RE.test(m.text ?? "")).map((m) => m.created_at),
  ].filter((x) => x < turnStart).sort();
  const lastSend = sendTimes[sendTimes.length - 1] ?? null;
  const estTimes = aixNewestFirst.filter((a) => a.aix_type === "estimate_sheet").map((a) => a.sent_at ?? a.created_at).filter((x) => x < turnStart).sort();
  const lastEst = estTimes[estTimes.length - 1] ?? null;
  return {
    turnText: turn.map((m) => m.text ?? "").join("\n"),
    turnHasImage: turn.some((m) => /^\[画像\]/.test(m.text ?? "")),
    turnQuotesOurMessage: turn.some((m) => !!m.quoted_message_id),
    hoursSinceOurLastPropertySend: lastSend ? (Date.parse(turnStart) - Date.parse(lastSend)) / 3_600_000 : null,
    estimateSentSinceLastPropertySend: !!(lastEst && (!lastSend || lastEst >= lastSend)),
    customerSentPropertyEarlier: msgsNewestFirst.filter((m) => m.sender === "customer" && m.created_at < turnStart).slice(0, 6).some((m) => /https?:\/\/|^\[画像\]/.test(m.text ?? "")),
  };
}
