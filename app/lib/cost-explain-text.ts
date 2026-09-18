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

// ── 仕組みだけを説明する（2026-09-19 竹内）─────────────────────────────────────
// 竹内「初期費用について説明すること多いのでAIXの初期費用を説明のところに仕組みを説明のピッカーつけて、
//   そこ押したら、報酬額いれなくても説明されるようにする。
//   このメンションしているのは、公式LINEの挨拶メッセージの初期費用の部分（スモラは最大2,980円＋前家賃の部分）」
//
// 【実データで分かった大事なこと（2026-09-19）】
//   仕組みは**アカウントで違う**。文を1つにすると、どちらかのお客様に嘘を言うことになる。
//   ・スモラ … 仲介手数料 2,980円が**一律**。スモ割（広告料の還元）で初期費用を割引し、最大適用なら「前家賃＋2,980円」
//       実送信「仲介手数料の2,980円は一律で発生し、お部屋によって割引可能額が変わります」
//       実送信「TikTokでご紹介させていただいているお部屋は前家賃と仲介手数料の2,980円のみでご案内させていただいております」
//       公式LINEの挨拶「【最大2,980円＋前家賃だけ！】」「🌟スモ割最大適用で初期費用が【2,980円＋前家賃】に！！」
//   ・イエヤス／ギガ … 仲介手数料0円でご案内できるお部屋が多く、イエヤス割／ギガ割が付く
//       実送信「ガーデンプランツ仲介手数料0円と25,000円のイエヤス割が可能なお部屋となっており」
//       実送信「ギガ割が適用出来ないお部屋となりますが仲介手数料0円でご案内させていただきます」
//   ・どちらにも共通（実送信 21通）「仲介手数料はお部屋によって異なります！！ほとんどのお部屋を仲介手数料0円で
//       ご紹介可能ですが、中には仲介手数料をいただくお部屋もございます！！」
//   文は上のスタッフ実送信の言い回しだけを組み合わせて作る（新しい言い方を作らない）。

/** アカウント（conversations.account）*/
export type CostAccount = "sumora" | "ieyasu" | "giga";
/** スモラの仲介手数料（一律）。公式LINEの挨拶メッセージと同じ数字 */
export const SUMORA_BROKER_FEE_YEN = 2980;

/**
 * 貸主からの手数料の「具体」。2026-09-19 竹内「説明このように、具体的に入れるようにする」。
 * 竹内さんの実送信（9/19 03:02・スモラ）:
 *   「初期費用を抑えられる点についてですが／お部屋によっては貸主様から手数料（家賃1〜2ヶ月分）を頂いており、
 *     ここから❤︎さんの初期費用に還元させて頂くことで費用を抑えられる形となっております！！／
 *     仲介手数料2,980円のみとさせて頂いておりますので、最大限費用を抑えさせて頂く形となります！！／
 *     無事ご満足頂くお部屋が見つかるまでサポートさせて頂きます！！／何卒よろしくお願い致します😌！」
 * 物件ごとの金額を出さなくても「家賃1〜2ヶ月分」「2,980円のみ」で**具体的**に説明できる、というのが型。
 */
export const LANDLORD_FEE_RANGE_PHRASE = "お部屋によっては貸主様から手数料（家賃1〜2ヶ月分）を頂いており";

export type CostMechanismInput = {
  customerName: string;
  /** conversations.account。未指定は sumora 扱い（件数最多・挨拶メッセージの型） */
  account?: CostAccount | string | null;
  /** お客様が「仲介手数料」に触れている */
  askedBrokerFee: boolean;
};

/**
 * 仕組みだけを説明する1通（金額の入力なしで作れる）。
 * 物件ごとの金額は一切書かない＝入力が要らない（竹内さんの「報酬額いれなくても説明される」）。
 */
export function buildCostMechanismMessage(input: CostMechanismInput): string {
  const name = input.customerName.trim() ? `${input.customerName.trim()}さん` : "お客様";
  const acct = String(input.account ?? "sumora").toLowerCase();
  const opening = "ご質問ありがとうございます😊！！";
  // 仕組みの中心（実送信そのまま・アカウント共通）
  const refund =
    "オーナー様からの広告料をお客様に還元させて頂いている仕組みのため、初期費用を一般的な不動産業者様よりお安くご提案出来ております！！";
  const closing = "他社様との金額差はこの還元の有無によるものですので、ご安心ください😊！！";

  void refund; void closing;
  if (acct === "ieyasu" || acct === "giga") {
    const wari = acct === "giga" ? "ギガ割" : "イエヤス割";
    return [
      opening,
      "",
      "初期費用を抑えられる点についてですが",
      `${LANDLORD_FEE_RANGE_PHRASE}、ここから${name}の初期費用に還元させて頂くことで費用を抑えられる形となっております！！`,
      "",
      `ほとんどのお部屋を仲介手数料0円でご紹介可能となりますので、最大限費用を抑えさせて頂く形となります！！`,
      `お部屋によっては${wari}も適用させて頂けます😊！！`,
      "無事ご満足頂くお部屋が見つかるまでサポートさせて頂きます！！",
      "何卒よろしくお願い致します😌！！",
    ].join("\n");
  }
  // スモラ（2026-09-19 竹内の実送信の型そのまま）
  return [
    opening,
    "",
    "初期費用を抑えられる点についてですが",
    `${LANDLORD_FEE_RANGE_PHRASE}、ここから${name}の初期費用に還元させて頂くことで費用を抑えられる形となっております！！`,
    "",
    `仲介手数料${SUMORA_BROKER_FEE_YEN.toLocaleString("ja-JP")}円のみとさせて頂いておりますので、最大限費用を抑えさせて頂く形となります！！`,
    "無事ご満足頂くお部屋が見つかるまでサポートさせて頂きます！！",
    "何卒よろしくお願い致します😌！！",
  ].join("\n");
}

export type CostExplainInput = {
  customerName: string;
  /** お客様が「仲介手数料」に触れている（「仲介手数料無しで大丈夫でしょうか？」）→ 冒頭でその点に答える */
  askedBrokerFee: boolean;
  /**
   * conversations.account。**スモラは仲介手数料 2,980円が一律**なので「0円」と書かない（2026-09-19 竹内）。
   * 未指定は従来どおり（0円）＝既存の呼び出しの挙動を変えない
   */
  account?: CostAccount | string | null;
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

/**
 * 冒頭の仲介手数料の言い方。
 * 2026-09-19 竹内「スモラの場合は仲介手数料2,980円なので、スモラだけ2,980円と変えておく」。
 *   DB のルール（ai_prompt_rules 4f2474ee）にも「仲介手数料は一律2,980円（固定）であり割引するものではない」とある。
 *   スモラの実送信でも既定は 2,980円（「仲介手数料2,980円のみでご案内させていただきます」7/12・7/15・7/21、
 *   「仲介手数料の2,980円は一律で発生し」8/11）。0円は**代表の特別許可**という例外（8/19・8/28）なので既定にしない。
 *   イエヤス・ギガは従来どおり 0円（実送信「仲介手数料0円と25,000円のイエヤス割」「仲介手数料0円でご案内させていただきます」）。
 */
export function brokerFeeOpening(account: CostAccount | string | null | undefined, askedBrokerFee: boolean): string {
  const acct = String(account ?? "").toLowerCase();
  if (acct === "sumora") {
    return askedBrokerFee
      ? "仲介手数料は一律2,980円のみとなります！！"
      : "ご質問ありがとうございます😊！！\n弊社は仲介手数料2,980円のみでご案内させて頂いております！！";
  }
  return askedBrokerFee
    ? "仲介手数料は0円で大丈夫です！！"
    : "ご質問ありがとうございます😊！！\n弊社は仲介手数料0円となります！！";
}

/** AIX【初期費用を説明】の本文（説明＋仕組みを1通で） */
export function buildCostExplainMessage(input: CostExplainInput): string {
  const name = input.customerName.trim() ? `${input.customerName.trim()}さん` : "お客様";
  const opening = brokerFeeOpening(input.account, input.askedBrokerFee);
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

// ── 会話を合わせる（2026-09-19 竹内「初期費用を説明のところ会話を合わせるボタンをつける」）──────────
// 固定テンプレは画面で作り（AI不使用）、こちらは会話に合わせた1通をサーバーで作る。
// 金額は**スタッフの入力値だけ**。見積書・保証会社と同じで、入力に無い金額は〇〇円に伏せて送信前チェックで止める。

/** 本文に出てくる金額（「67,000円」「2,980円」「12万円」）を拾う */
function scanYenTokens(text: string): Array<{ raw: string; yen: number; start: number; end: number }> {
  const out: Array<{ raw: string; yen: number; start: number; end: number }> = [];
  const re = /[¥￥]?\s*([0-9０-９][0-9０-９,，.．]*)\s*(万円|万|円)/g;
  for (const m of (text ?? "").matchAll(re)) {
    const yenVal = parseYen(m[2].startsWith("万") ? `${m[1]}万` : m[1]);
    if (yenVal === null) continue;
    out.push({ raw: m[0], yen: yenVal, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/**
 * 入力に無い金額を〇〇円に伏せる。
 * allowed に無い金額が本文にあれば置き換えて unmatched に返す（送信前チェックで止まる）。
 * 家賃1ヶ月分などの「◯ヶ月」や帖数は金額ではないので当たらない。
 */
export function checkCostFacts(text: string, allowedYens: readonly (number | null | undefined)[]): { cleaned: string; unmatched: number[] } {
  const allowed = new Set(allowedYens.filter((n): n is number => typeof n === "number" && n > 0));
  // 会社の仕組みの数字（スモラの仲介手数料）は常に許す
  allowed.add(SUMORA_BROKER_FEE_YEN);
  const hits = scanYenTokens(text).filter((h) => !allowed.has(h.yen));
  if (hits.length === 0) return { cleaned: text ?? "", unmatched: [] };
  let cleaned = text ?? "";
  for (const h of [...hits].reverse()) cleaned = cleaned.slice(0, h.start) + "〇〇円" + cleaned.slice(h.end);
  const unmatched: number[] = [];
  for (const h of hits) if (!unmatched.includes(h.yen)) unmatched.push(h.yen);
  return { cleaned, unmatched };
}

/**
 * 仲介手数料の言い方をアカウントに合わせて直す（出口の決定論）。
 * スモラで「仲介手数料0円／無料」と書いてしまったら「仲介手数料2,980円」に直す。
 * イエヤス・ギガはそのまま（0円が正しい）。
 */
export function fixBrokerFeeWording(text: string, account: CostAccount | string | null | undefined): { text: string; fixed: number } {
  if (String(account ?? "").toLowerCase() !== "sumora") return { text: text ?? "", fixed: 0 };
  let fixed = 0;
  const out = (text ?? "")
    .replace(/仲介手数料(?:は|も|が)?[^\n。！!、]{0,4}(?:0円|０円|無料|なし|無し)/g, (m) => {
      fixed++;
      return m.includes("は") ? "仲介手数料は一律2,980円" : "仲介手数料2,980円";
    });
  return { text: out, fixed };
}

/**
 * スタッフが入力した金額が本文に入っていなければ、締めの前に1文足す（出口の決定論）。
 *
 * 2026-09-19 の本番検証（YUMA・3回）: 材料に「貸主から67,000円・還元22,000円」を渡したのに
 * 3回とも本文に金額が入らず、仕組みだけを答えていた。金額を入力しているのに使われないと
 * スタッフの入力の意味が無くなる（元の仕様 2026-09-12 竹内「貸主からの報酬を入力すると反映されて
 * このような文が作られる」）。指示だけでは落ちるので、無ければ足す。
 * 文は固定テンプレ（buildCostExplainMessage）と同じ言い方にする（2つの経路で言い方が割れない）。
 */
export function ensureCostDetail(
  text: string,
  input: { customerName: string; mode: "fee" | "no_fee" | "mechanism"; landlordFeeYen?: number | null; landlordFeeLabel?: string | null; refundYen?: number | null; savingYen?: number | null },
): { text: string; added: boolean } {
  const src = (text ?? "").trim();
  if (!src) return { text: src, added: false };
  const name = input.customerName.trim() ? `${input.customerName.trim()}さん` : "お客様";
  if (input.mode === "mechanism") {
    // 2026-09-19 竹内「説明このように、具体的に入れるようにする」:
    //   「広告料を還元」だけで終わっていたら、貸主様から頂く手数料（家賃1〜2ヶ月分）→ 還元 の具体を足す
    if (/家賃[0-9０-９]{1,2}[〜~ー-][0-9０-９]{1,2}[ヶケか]?月分|貸主(様)?から.{0,12}手数料/.test(src)) return { text: src, added: false };
    const sentence = `${LANDLORD_FEE_RANGE_PHRASE}、ここから${name}の初期費用に還元させて頂くことで費用を抑えられる形となっております！！`;
    const lines = src.split("\n");
    const closerIdx = lines.findIndex((l) => /ご安心ください|ご安心頂け|何卒よろしく|お気軽に|サポートさせて頂きます/.test(l));
    if (closerIdx >= 0) lines.splice(closerIdx, 0, sentence);
    else lines.push(sentence);
    return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), added: true };
  }
  let sentence: string | null = null;
  if (input.mode === "fee") {
    const fee = input.landlordFeeYen ?? 0;
    const refund = input.refundYen ?? 0;
    if (!fee || !refund) return { text: src, added: false };
    // どちらかの金額が既に本文にあれば足さない（言い方はLLMに任せる）
    if (src.includes(yen(fee)) || src.includes(yen(refund))) return { text: src, added: false };
    const label = input.landlordFeeLabel?.trim() ? `${input.landlordFeeLabel.trim()}の` : "";
    sentence =
      `こちらの物件は貸主から${label}手数料を弊社不動産仲介会社は頂く事が出来ます！！\n` +
      `${yen(fee)}を貸主から頂き、そこから${yen(refund)}を${name}の初期費用に還元させて頂きますので、弊社としましても利益残りますのでご安心頂けますと幸いです！！`;
  } else {
    // 手数料が無いお部屋: 差額が入力されていて本文に無ければ足す
    const saving = input.savingYen ?? 0;
    if (!saving || src.includes(yen(saving))) return { text: src, added: false };
    sentence = `こちらの物件は貸主から手数料がないお部屋となりますので、割引出来ない形となりますが、一般的な不動産業者より${yen(saving)}お得となります！！`;
  }
  if (!sentence) return { text: src, added: false };
  // 締め（ご安心ください等）の直前に入れる。見つからなければ末尾
  const lines = src.split("\n");
  const closerIdx = lines.findIndex((l) => /ご安心ください|ご安心頂け|何卒よろしく|お気軽に/.test(l));
  if (closerIdx >= 0) lines.splice(closerIdx, 0, sentence);
  else lines.push(sentence);
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), added: true };
}

/** 生成に渡す材料（会話を合わせる用・金額は入力値だけ） */
export function buildCostExplainFactsNote(input: {
  account?: CostAccount | string | null;
  mode: "fee" | "no_fee" | "mechanism";
  landlordFeeYen?: number | null;
  landlordFeeLabel?: string | null;
  refundYen?: number | null;
  savingYen?: number | null;
}): string {
  const acct = String(input.account ?? "sumora").toLowerCase();
  const lines: string[] = ["【確定事実（この金額・この仕組みだけを使う。他の金額は書かない）】"];
  if (acct === "sumora") {
    lines.push("・仲介手数料: スモラは**一律2,980円**（0円とは書かない。「割引」もしない＝割引するのは初期費用）");
    lines.push("・スモ割が最大適用出来るお部屋なら初期費用は【前家賃＋2,980円】のみ（公式LINEの案内と同じ）");
  } else {
    lines.push(`・仲介手数料: ${acct === "giga" ? "ギガ" : "イエヤス"}はほとんどのお部屋を**0円**でご紹介可能（お部屋によっては頂く場合もある）`);
    lines.push(`・お部屋によっては${acct === "giga" ? "ギガ割" : "イエヤス割"}も適用できる`);
  }
  // 2026-09-19 竹内「説明このように、具体的に入れるようにする」＝ 金額が無くても具体で説明する
  lines.push(`・安さの理由（**この具体で説明する**）: ${LANDLORD_FEE_RANGE_PHRASE}、ここからお客様の初期費用に還元している`);
  lines.push("・「広告料を還元」とだけで終わらせず、**貸主様から頂く手数料（家賃1〜2ヶ月分）→ お客様へ還元**の流れを書く");
  if (input.mode === "fee") {
    if (input.landlordFeeYen) lines.push(`・このお部屋は貸主から${input.landlordFeeLabel ? `${input.landlordFeeLabel}の` : ""}手数料 ${input.landlordFeeYen.toLocaleString("ja-JP")}円 を頂ける`);
    if (input.refundYen) lines.push(`・そのうち ${input.refundYen.toLocaleString("ja-JP")}円 をお客様の初期費用に還元する（弊社にも利益が残る）`);
  } else if (input.mode === "no_fee") {
    lines.push("・このお部屋は**貸主から手数料がない**ため割引が出来ない");
    if (input.savingYen) lines.push(`・それでも一般的な不動産業者より ${input.savingYen.toLocaleString("ja-JP")}円 お得`);
  } else {
    lines.push("・今回は**物件ごとの金額は書かない**（仕組みだけを説明する）");
  }
  return lines.join("\n");
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
