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
/**
 * 今の線で取りこぼしていた依頼の言い方（2026-10-08 竹内さん⑥の監査・scripts/audit-further-discount-reading.ts・365日・人が代表・最安値で答えた番）:
 *   ad97cd40 9/19「こちらの初期費用は抑えること厳しいですか？」→ 人「…最安値のお見積書となります」／
 *   d3f7f5f3 9/05「当初の想定より予算オーバーなので、さらに割引頑張ってもらえると助かります」→ 人「弊社代表から許可を頂いており…最大限割引」／
 *   732692f2 9/28「こちらもう少し安い業者さんがいまして」→ 人「弊社代表にお伝えし更に割引出来るか交渉」。戻す: FURTHER_DISCOUNT_ASK_WIDE=off
 */
const DISCOUNT_ASK_WIDE_RE = /抑え(?:ること|る事|るの)(?:は|って)?(?:厳しい|難しい|でき|出来|可能|無理)|(?:割引|値引き?)(?:を|も)?(?:頑張|がんば)|(?:もう少し|もっと)安い(?:業者|不動産|会社|ところ|所|お店)/;
function askWideEnabled(): boolean { return typeof process === "undefined" || (process.env?.FURTHER_DISCOUNT_ASK_WIDE ?? "").toLowerCase() !== "off"; }
/** 初期費用の話か（家賃だけの値下げは除く） */
const COST_WORD_RE = /初期費用|費用|見積|礼金|敷金|割引|値段|金額|総額|仲介/;
const RENT_ONLY_RE = /家賃|賃料/;

/** お客様が今の番で初期費用を更に安くできないか聞いたか */
export function customerAsksFurtherDiscount(turnText: string | null | undefined): boolean {
  const t = String(turnText ?? "").normalize("NFKC");
  if (!DISCOUNT_ASK_RE.test(t) && !(askWideEnabled() && DISCOUNT_ASK_WIDE_RE.test(t))) return false;
  if (RENT_ONLY_RE.test(t) && !COST_WORD_RE.test(t)) return false;
  // 他社の見積と比べての不審（安すぎる理由）は 初期費用を説明 の領分・分割の話は返信（カード払い）
  if (/なぜ|なんで|理由|大丈夫(?:です|でしょう)か/.test(t) && !/もう少し|これ以上|更に|さらに/.test(t)) return false;
  // 2026-10-08（竹内さん「文の単語だけで変に判断…ブレインを基盤に」の点検）: 安いお部屋を探してほしい依頼（条件）は割引の依頼ではない。
  //   実送信（365日・御見積書の後に「安く」と言った 21番）: 「もう少し安く初期費用がこの位の家は見つからないでしょうか」
  //   「家賃と間取りを下げると初期費用も安くなりますか」→ スタッフは「家賃を抑えられるお部屋をピックアップ」（代表確認 0）。
  //   同じ 21番の代表への確認・最安値の答え（「もう少し安くなりませんか」「礼金下げることは厳しいですか」等 18通）はこの線に当たらない（誤って外す 0）。
  //   戻す: FURTHER_DISCOUNT_ROOM_ASK=off
  if ((typeof process === "undefined" || (process.env?.FURTHER_DISCOUNT_ROOM_ASK ?? "").toLowerCase() !== "off") && CHEAPER_ROOM_ASK_RE.test(t)) return false;
  // 2026-10-08 竹内さん「『初期費用をもう少し抑えたいですね』のような物件を指さない言い方は条件＝安いお部屋を探す形。
  //   『このお部屋の費用をもっと抑えたい』のように送った物件・見積の物件を指す時だけ代表確認」:
  //   実送信（365日・御見積書の後・scripts/audit-further-discount-target.ts）: 9faff2ec「できれば初期費用をもう少し抑えたいですね💦」→ 竹内さん「新着で初期費用抑えられるお部屋…お送り」／
  //   cb1a46e3「初期費用もう少し安くお願いします」→「大阪市内全域から初期費用最大限割引できるお部屋ピックアップ」（同じ人が「これは、いつから住めますか？初期費用もう少し安くお願いします」と物件を指した番は「弊社代表に…確認」）。
  //   線: 願いの形（抑えたい・安くお願い・安くしたい）で、物件を指す語（こちら・この・ここ・これ・その・号室・①②・他社・これ以上）が無い時だけ外す。
  //   「安くなりませんかね？」等の問いの形は今まで通り（77b29095 は人も最大限の答え）。本物の割引の依頼 18通は外れない（同じ監査）。戻す: FURTHER_DISCOUNT_POINTER=off
  if ((typeof process === "undefined" || (process.env?.FURTHER_DISCOUNT_POINTER ?? "").toLowerCase() !== "off") && wishWithoutPointer(t)) return false;
  return true;
}
/** 願いの形（抑えたい・安くお願い）だけで、送った物件・見積の物件を指す語が無い（＝条件＝安いお部屋を探す形） */
const WISH_FORM_RE = /(?:抑え|安く|下げ)(?:たい|て欲し|てほし)|安く(?:お願い|して下さい|してください)|安い(?:方|ほう|の|お部屋|部屋)が(?:いい|良い)/;
const ASK_FORM_RE = /(?:なり|でき|出来|なら)(?:ません|ます|ない)(?:か|かね|よね)|(?:厳しい|難しい|無理)(?:です|でしょう)?か|ないんですか|ありませんか|値引き|割引/;
const POINTER_RE = /こちら|こっち|この|ここ|これ|そちら|その|そこ|あの|号室|[①-⑨]|[0-9]+件目|他社|他の不動産|これ以上|更に|さらに/;
export function wishWithoutPointer(text: string | null | undefined): boolean {
  const t = String(text ?? "").normalize("NFKC");
  return WISH_FORM_RE.test(t) && !ASK_FORM_RE.test(t) && !POINTER_RE.test(t);
}
/** 安いお部屋を探す依頼・条件を変えたらの仮定（割引の依頼ではない） */
export const CHEAPER_ROOM_ASK_RE = /(?:お?部屋|物件|家|ところ|とこ)(?:は|が|って|で|を)?[^\n。？?]{0,8}(?:見つから|探し|探して|あり(?:ます|ませ)|ござい(?:ます|ませ)|紹介|ピックアップ)|(?:家賃|間取り?)[^\n。]{0,8}(?:下げ|変え|落と)(?:ると|たら|れば)/;

export type FurtherDiscountMsg = { sender?: string | null; text?: string | null; created_at?: string | null; createdAt?: string | null };
export type FurtherDiscountInput = {
  turnText: string | null | undefined; estimateSent: boolean; postApply: boolean; env?: Record<string, string | undefined>;
  /** 会話（古い順・今回の発言を含んでよい）。渡された時だけ「指しているのが見積書のお部屋か」を読む（newPropertyAfterEstimate） */
  recent?: ReadonlyArray<FurtherDiscountMsg> | null;
};
/** AIX【確認します→代表確認（初期費用）】にするか（御見積書を送った後の更なる割引の依頼だけ） */
export function furtherDiscountDaihyo(i: FurtherDiscountInput): boolean {
  const env = i.env ?? (typeof process !== "undefined" ? process.env : {});
  if ((env.FURTHER_DISCOUNT_DAIHYO ?? "").toLowerCase() === "off") return false;
  if (i.postApply || !i.estimateSent || !customerAsksFurtherDiscount(i.turnText)) return false;
  // 「これ以上・更に」と見積書の金額を指す時は、持ち込みの後でも代表確認（1191b1eb 9/24「こちらはこれ以上安くなるのは厳しいですか？」→ 人は最安値の答え）
  if (i.recent && (env.FURTHER_DISCOUNT_NEW_PROPERTY ?? "").toLowerCase() !== "off" && !/これ以上|更に|さらに/.test(String(i.turnText ?? "")) && newPropertyAfterEstimate(i.recent)) return false;
  return true;
}

/**
 * 最後の御見積書の後に、お客様が新しく物件（URL・ポータルの共有文）を送ってきたか＝今の「安くなりますか」「こちらはいくらくらいお安くできますか」は
 * その新しい物件の初期費用を聞いている（＝AIX【見積書送る】・物件確認の領分）。代表に更なる割引を確認する番ではない。
 *   2026-10-08 竹内さん⑥「その物件に対して『もっと初期費用を安くできないか』という依頼なら代表確認」の監査（scripts/audit-further-discount-reading.ts・365日）:
 *   f5e92bc6 9/15「こちらはいくらくらいお安くできますか？」（直前に持ち込みの物件）→ 人は「お送り頂きました物件につきまして募集状況確認…」／
 *   同じ日の「お安くなりますか？」（持ち込みの画像の後）→ 人は御見積書の画像。どちらも今の線は代表確認にしていた。
 *   戻す: FURTHER_DISCOUNT_NEW_PROPERTY=off
 */
/** 送った御見積書（AIX の御見積書の本文「①【伊原文化 206号室】 初期費用：102,280円」も） */
const ESTIMATE_SENT_RE = /御見積書|お見積書|お見積り書|初期費用[:：]\s*[0-9,]+円/;
/** お客様の持ち込みの物件（URL・ポータルの共有文「物件名：」「価格：8.2万円」「1LDK 8.5万円」）。[画像] だけは自分たちが送った物の画面写しもあるので数えない
 *  （044608b4 6/11: [画像] の後「こちらで契約…敷礼等お安くなりますか」→ 人は管理会社への敷礼の減額交渉＝割引の依頼） */
const CUSTOMER_LISTING_RE = /https?:\/\/|物件名[:：]|価格[:：]|[0-9.]+万円[^\n]{0,20}(?:徒歩|駅)|(?:徒歩|駅)[^\n]{0,30}[0-9.]+万円/;
export function newPropertyAfterEstimate(recent: ReadonlyArray<FurtherDiscountMsg>): boolean {
  const at = (m: FurtherDiscountMsg) => Date.parse(String(m.created_at ?? m.createdAt ?? ""));
  let estIdx = -1;
  recent.forEach((m, k) => { if (m.sender !== "customer" && ESTIMATE_SENT_RE.test(String(m.text ?? ""))) estIdx = k; });
  if (estIdx < 0) return false;
  const estAt = at(recent[estIdx]);
  return recent.slice(estIdx + 1).some((m) => m.sender === "customer" && CUSTOMER_LISTING_RE.test(String(m.text ?? "").normalize("NFKC")) && (!Number.isFinite(estAt) || !Number.isFinite(at(m)) || at(m) > estAt));
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
