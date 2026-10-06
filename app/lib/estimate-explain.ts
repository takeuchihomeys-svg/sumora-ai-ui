// app/lib/estimate-explain.ts — 御見積書を送る時の「このお部屋の費用の事情」の文を、見積書の読み取りの数字だけから決める（純関数）
//
// 2026-10-06 ⑫ 竹内さん（R への見積書の送付 10/04 16:08 を見て）「このように複雑な返信もする事は出来るのか？いまある資料の読み取りなども活用して
//   …実際にスタッフが送っているような正確で具体的なちゃんとした返信を送るっことが出来れば、よりお客さんから信頼されるし、距離をつめることもできる」
//   スタッフの実送信（R・カーサピエント 203号室）:
//     1通目（金額の札）「…※ご入居日によって日割家賃が発生致します。／こちらの物件貸主様から報酬が出ないお部屋となりますので、仲介手数料33,000円となります。」
//     2通目「お待たせ致しました！！／初期費用の御見積書となります！！／こちらのお部屋クリーニング費用はご契約時にお支払いの為費用が初期費用がかかる物件となります！！
//           ／貸主様から報酬が出ない物件となりますので、スモ割は出来ませんが仲介手数料33,000円となりますので、最安値の費用でお取引させて頂きます😌！！」
//   AI の下書きにはこの事情の文が無かった（scripts/audit-property-explanation-gap.ts: 報酬・AD→割引 6件中 AI 2・仲介手数料の額 11件中 6・最安値 6件中 0・クリーニング 9件中 4）。
//   材料（見積書の読み取りの 割引・仲介手数料・クリーニング費用）はあるのに、文にする決まりが無かった＝(a)＋(d)。
//
// 決まり（実送信 365日の形・アカウントごと。scripts/audit-property-explanation-gap.ts と下のテストの実物）:
//   スモラ・割引 0円・仲介手数料が 2,980円より高い（報酬が出ない＝一般の仲介手数料）:
//     札「こちらの物件貸主様から報酬が出ないお部屋となりますので、仲介手数料{額}円となります。」
//     2通目「貸主様から報酬が出ない物件となりますので、スモ割は出来ませんが仲介手数料{額}円となりますので、最安値の費用でお取引させて頂きます😌！！」
//   スモラ・割引 0円・仲介手数料 2,980円以下（7/12・7/15・7/21 の実送信）:
//     札「スモ割が適用できないお部屋となっており、仲介手数料2,980円のみでご案内させていただきます！！」
//     2通目「スモ割が出来ないお部屋となりますが、仲介手数料2,980円のみでご案内させていただきますので他社さんよりは初期費用抑えてご紹介可能です！！」
//   イエヤス／ギガ・割引 0円・仲介手数料 0円（7/16・8/02 の実送信）: 「イエヤス割が出来ないお部屋となりますが、仲介手数料0円でご紹介させていただきます😊！！」等
//   クリーニング費用が契約時に要る（見積書に載っている）: 2通目「こちらのお部屋クリーニング費用はご契約時にお支払いの為費用が初期費用がかかる物件となります！！」
//   数字は見積書の読み取りの値だけ（作らない）。読めない値の文は出さない。割引がある（>0）お部屋は今まで通り（最大限割引の文）

export type EstimateAccount = "sumora" | "ieyasu" | "giga";
export type EstimateExplainInput = {
  account: EstimateAccount | string | null | undefined;
  /** 割引額（スモ割等）。0＝割引なし・null＝読めない */
  discountYen: number | null | undefined;
  /** 仲介手数料（税込）。null＝読めない */
  commissionYen: number | null | undefined;
  /** 見積書に載っているクリーニング費用（契約時）。null／0＝無い */
  cleaningFeeYen?: number | null;
};
export type EstimateExplain = {
  /** 1通目（金額の札）の最後に足す1行（無ければ null） */
  cardLine: string | null;
  /** 2通目に入れる文（順番どおり・無ければ空） */
  secondLines: string[];
  /** 生成に渡す事実（数字は見積書の読み取りの値） */
  facts: string[];
};

const yen = (n: number) => `${Math.round(n).toLocaleString("ja-JP")}円`;
const BRAND_DISCOUNT: Record<EstimateAccount, string> = { sumora: "スモ割", ieyasu: "イエヤス割", giga: "ギガ割" };

export function estimateExplain(i: EstimateExplainInput): EstimateExplain {
  const out: EstimateExplain = { cardLine: null, secondLines: [], facts: [] };
  const acc = (["sumora", "ieyasu", "giga"].includes(String(i.account)) ? i.account : "sumora") as EstimateAccount;
  const brand = BRAND_DISCOUNT[acc];
  const cleaning = typeof i.cleaningFeeYen === "number" && i.cleaningFeeYen > 0 ? i.cleaningFeeYen : null;
  if (cleaning != null) {
    out.secondLines.push("こちらのお部屋クリーニング費用はご契約時にお支払いの為費用が初期費用がかかる物件となります！！");
    out.facts.push(`クリーニング費用 ${yen(cleaning)}（契約時に支払う・見積書の読み取り）`);
  }
  const noDiscount = typeof i.discountYen === "number" && i.discountYen <= 0;
  const comm = typeof i.commissionYen === "number" && i.commissionYen >= 0 ? i.commissionYen : null;
  if (!noDiscount || comm == null) return out;
  if (acc === "sumora") {
    if (comm > 2980) {
      out.cardLine = `こちらの物件貸主様から報酬が出ないお部屋となりますので、仲介手数料${yen(comm)}となります。`;
      out.secondLines.push(`貸主様から報酬が出ない物件となりますので、${brand}は出来ませんが仲介手数料${yen(comm)}となりますので、最安値の費用でお取引させて頂きます😌！！`);
      out.facts.push(`${brand}なし（割引0円）・貸主様からの報酬なし・仲介手数料 ${yen(comm)}（見積書の読み取り）＝お送りする御見積書が最安値`);
    } else {
      out.cardLine = `${brand}が適用できないお部屋となっており、仲介手数料${yen(comm)}のみでご案内させていただきます！！`;
      out.secondLines.push(`${brand}が出来ないお部屋となりますが、仲介手数料${yen(comm)}のみでご案内させていただきますので他社さんよりは初期費用抑えてご紹介可能です！！`);
      out.facts.push(`${brand}なし（割引0円）・仲介手数料 ${yen(comm)}のみ（見積書の読み取り）`);
    }
    return out;
  }
  // イエヤス・ギガ: 仲介手数料 0円の時だけ（実送信の形）。手数料をいただくお部屋は物件ごと（家賃半額 等）なので文を作らない
  if (comm === 0) {
    out.secondLines.push(acc === "ieyasu"
      ? `${brand}が出来ないお部屋となりますが、仲介手数料0円でご紹介させていただきます😊！！`
      : `${brand}が適用出来ないお部屋となりますが仲介手数料0円でご案内させていただきます！！`);
    out.facts.push(`${brand}なし（割引0円）・仲介手数料0円（見積書の読み取り）`);
  }
  return out;
}

/** 生成（AIX【見積書送る】の2通目）に渡す注記。文が無ければ空 */
export function buildEstimateExplainNote(e: EstimateExplain): string {
  if (!e.secondLines.length) return "";
  return [
    "【このお部屋の費用の事情（見積書の読み取りの数字だけ・スタッフの実送信の言い方）】",
    ...e.facts.map((f) => `・${f}`),
    "・次の文をそのまま本文に入れる（言い換えない・数字を変えない・他の金額を足さない）:",
    ...e.secondLines.map((l) => `  「${l}」`),
  ].join("\n");
}

/**
 * 送った1通目（金額の札）から2通目の事情の文を決める（AIX の2通目の生成＝aix-template-generate 用）。
 *   札に「報酬が出ない…仲介手数料〇円」「〇〇割が適用できない…仲介手数料〇円のみ」の行があれば、その数字のまま2通目の文にする（数字は札の字だけ）
 */
export function secondLinesFromCard(card: string | null | undefined, account: EstimateAccount | string | null | undefined): string[] {
  const t = String(card ?? "").normalize("NFKC");
  // アカウントが分からない時は札の字（「スモラなら」「イエヤス」「ギガ」）で決める
  const fromCard: EstimateAccount = /イエヤス/.test(t) ? "ieyasu" : /ギガ/.test(t) ? "giga" : "sumora";
  const acc = (["sumora", "ieyasu", "giga"].includes(String(account)) ? account : fromCard) as EstimateAccount;
  const brand = BRAND_DISCOUNT[acc];
  const out: string[] = [];
  const noReward = t.match(/報酬が(?:出|で)ないお部屋となりますので、仲介手数料([0-9,]+)円/);
  if (noReward) {
    out.push(`貸主様から報酬が出ない物件となりますので、${brand}は出来ませんが仲介手数料${noReward[1]}円となりますので、最安値の費用でお取引させて頂きます😌！！`);
    return out;
  }
  const noDisc = t.match(/(?:スモ割|イエヤス割|ギガ割)が適用(?:でき|出来)ないお部屋となっており、仲介手数料([0-9,]+)円のみ/);
  if (noDisc) out.push(`${brand}が出来ないお部屋となりますが、仲介手数料${noDisc[1]}円のみでご案内させていただきますので他社さんよりは初期費用抑えてご紹介可能です！！`);
  return out;
}
