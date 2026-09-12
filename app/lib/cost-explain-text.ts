// app/lib/cost-explain-text.ts
// AIX【初期費用を説明】（2026-09-12 竹内方針・あや事例）— 純関数・DB 依存なし
//   「費用の安さについてお客さんに不審になられたり、聞かれた場合はこの AIX の初期費用を説明ボタンから送る」
//   「説明と仕組みを両方答える」「貸主からの報酬を入力すると反映されてこのような文が作られる」
//
// 文面はスタッフが実際に送った文（あや 2026-09-12 22:54/22:56 の2通）を1通にしたもの。金額は入力値だけを使う
// （見積書送ると同じく、金額の AI 生成・創作はしない）。
//   仕組み: 仲介手数料0円 → オーナー様からの広告料をお客様に還元 → 一般的な不動産業者よりお安く → 金額差は還元の有無
//   具体  : こちらの物件は貸主から〇〇の手数料を頂く → 〇〇円を貸主から頂き、そこから〇〇円を〇〇さんの初期費用に還元 → 利益も残る
//   貸主から手数料が無いお部屋: 実例（ﾓﾓｶ 2026-08-31）「貸主から手数料がないお部屋となりますので、割引出来ない形となりますが、
//   一般的な不動産業者より〇〇円お得となります」

/** 貸主からの報酬の言い方（「こちらの物件は貸主から【家賃1ヶ月分の】手数料を…」） */
export const LANDLORD_FEE_MONTH_OPTIONS = ["家賃1ヶ月分", "家賃半月分", "家賃2ヶ月分"] as const;

export type CostExplainInput = {
  customerName: string;
  /** お客様が「仲介手数料」に触れている（「仲介手数料無しで大丈夫でしょうか？」）→「仲介手数料は0円で大丈夫です！！」で答える */
  askedBrokerFee: boolean;
  /** 貸主から手数料が無いお部屋 */
  noLandlordFee: boolean;
  /** 貸主からの報酬（円） */
  landlordFeeYen: number | null;
  /** 報酬の言い方（家賃1ヶ月分 等）。無ければ「手数料」だけ */
  landlordFeeLabel: string | null;
  /** お客様の初期費用への還元額（円） */
  refundYen: number | null;
  /** 一般的な不動産業者との差額（円）— 手数料が無いお部屋の時に使う */
  savingYen: number | null;
};

const yen = (n: number) => `${Math.round(n).toLocaleString("ja-JP")}円`;

/** 「67,000」「6.7万」「67000円」→ 67000。読めなければ null */
export function parseYen(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.normalize("NFKC").replace(/[,，\s円]/g, "");
  const man = s.match(/^(\d+(?:\.\d+)?)万(\d+)?$/);
  if (man) return Math.round(parseFloat(man[1]) * 10000) + (man[2] ? parseInt(man[2], 10) : 0);
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Math.round(parseFloat(s));
  return n > 0 ? n : null;
}

/** 入力不足（生成ボタンを押せない理由）。揃っていれば null */
export function costExplainMissing(input: Pick<CostExplainInput, "noLandlordFee" | "landlordFeeYen" | "refundYen">): string | null {
  if (input.noLandlordFee) return null;
  if (!input.landlordFeeYen) return "貸主からの報酬を入力してください";
  if (!input.refundYen) return "初期費用への還元額を入力してください";
  if (input.refundYen > input.landlordFeeYen) return "還元額が貸主からの報酬を超えています";
  return null;
}

/** AIX【初期費用を説明】の本文（説明＋仕組みを1通で） */
export function buildCostExplainMessage(input: CostExplainInput): string {
  const name = input.customerName.trim() ? `${input.customerName.trim()}さん` : "お客様";
  const opening = input.askedBrokerFee
    ? "仲介手数料は0円で大丈夫です！！"
    : "ご質問ありがとうございます😊！！\n弊社は仲介手数料0円となります！！";
  const mechanism =
    `${opening}オーナー様からの広告料をお客様に還元させて頂いている仕組みのため、初期費用を一般的な不動産業者様よりお安くご提案出来ております！！\n\n` +
    "他社様との金額差はこの還元の有無によるものですので、ご安心ください😊！！";

  let detail: string;
  if (input.noLandlordFee) {
    detail = input.savingYen
      ? `こちらの物件は貸主から手数料がないお部屋となりますので、割引出来ない形となりますが、一般的な不動産業者より${yen(input.savingYen)}お得となります！！`
      : "こちらの物件は貸主から手数料がないお部屋となりますので、割引出来ない形となります！！";
  } else {
    const fee = input.landlordFeeYen ?? 0;
    const refund = input.refundYen ?? 0;
    const label = input.landlordFeeLabel?.trim() ? `${input.landlordFeeLabel.trim()}の` : "";
    detail =
      `こちらの物件は貸主から${label}手数料を弊社不動産仲介会社は頂く事が出来ます！！\n` +
      `${yen(fee)}を貸主から頂き、そこから${yen(refund)}を${name}の初期費用に還元させて頂きますので、弊社としましても利益残りますのでご安心頂けますと幸いです！！`;
  }
  return `${mechanism}\n\n${detail}`;
}

/**
 * 直近の AIX【見積書送る】の本文から金額を拾う（入力欄の初期値。スタッフが書き換えられる）
 *   「初期費用さらに\n🌟24,000円割引させて頂き」→ refund / 「一般的な不動産業者より97,700円節約出来ます」→ saving
 */
export function extractEstimateAmounts(staffTexts: string[]): { refundYen: number | null; savingYen: number | null } {
  for (let i = staffTexts.length - 1; i >= 0; i--) {
    const t = (staffTexts[i] ?? "").normalize("NFKC");
    const refund = t.match(/([\d,]+)円割引/);
    const saving = t.match(/より([\d,]+)円(?:節約|お得)/);
    if (refund || saving) {
      return { refundYen: refund ? parseYen(refund[1]) : null, savingYen: saving ? parseYen(saving[1]) : null };
    }
  }
  return { refundYen: null, savingYen: null };
}

/** お客様が仲介手数料に触れているか（冒頭の答え方を決める） */
export function mentionsBrokerFee(customerText: string): boolean {
  return /仲介手数料/.test(customerText.normalize("NFKC"));
}

// ── ブレイン用: 「安さへの不安・疑問」─────────────────────────────────────────
// 実例（200日）: あや「安いのには何か理由があるのでしょうか？」「仲介手数料無しで大丈夫でしょうか？」／𝓡「初期費用ここまでなぜ安くできるのですか？」
//   ／みこと「他社だと38万円だったのですが本当に22万円より高くなることはないですか？」／a🤫「仲介手数料なしってこの前言われたんですけど」
// 値引きの相談（「もう少し安くなりませんか」「安くできますか」「これ以上抑えることは難しいですかね」）は別の場面（交渉）なので含めない
const CHEAP_DOUBT_RES: RegExp[] = [
  /安い.{0,12}(理由|なぜ|何で|なんで|どうして|大丈夫|怪し|あやし|不安|本当|ほんと|からくり|カラクリ)/,
  /(理由|なぜ|何で|なんで|どうして).{0,12}安(い|く|すぎ)/,
  // 仲介手数料だけでは疑問か分からない（a🤫「仲介手数料なしってこの前言われたんですけど」は請求への指摘）→ 不安・疑問の語と一緒の時だけ
  /仲介手数料.{0,15}(無し|なし|無料|0円|かからない|掛からない|かかりません|要らない|いらない).{0,15}(大丈夫|本当|ほんと|理由|なぜ|何で|なんで|どうして|怪し|あやし|不安)/,
  /(他社|他の不動産|別の不動産|他の会社|他のところ|ほかの不動産).{0,40}(万|円).{0,40}(本当|ほんと|高くなる|大丈夫|理由|なぜ|何で|なんで|どうして)/,
  /(怪しい|あやしい|裏がある|からくり|カラクリ)/,
];
//   mai.t「仲介手数料無料や礼金の交渉はむずかしい物件なのか」も交渉の相談（スタッフは 確認します で返した）
const NEGOTIATION_RE = /(安くなりませんか|安くできますか|安く出来ますか|安くして|もう少し安く|これ以上.{0,10}(抑え|安く|下げ)|値引き|交渉|割引.{0,6}(ないんですか|ありませんか|できませんか|出来ませんか))/;

/** お客様の発言が「費用の安さへの不安・疑問」か（値引きの相談・画像の読み取り文字は除く） */
export function customerDoubtsCheapness(customerText: string): boolean {
  const t = customerText.normalize("NFKC");
  if (!t.trim()) return false;
  // 画像の読み取り文字（他社の見積書の「仲介手数料 0円」等）はお客様の言葉ではない
  if (/^\s*\[画像\]/.test(t)) return false;
  if (NEGOTIATION_RE.test(t)) return false;
  return CHEAP_DOUBT_RES.some((re) => re.test(t));
}
