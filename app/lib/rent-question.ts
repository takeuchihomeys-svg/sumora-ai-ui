// app/lib/rent-question.ts
// 2026-10-02 ⑫（竹内さん「相場の知識は物件検索ブレインからもらう形になっているかな？返信の部分が」）:
//   お客様が家賃の相場・予算で出るか（「8.5までの家賃で1dkはやっぱりないですよね💦」「この家賃だと厳しいですか」「相場ってどれくらい」）を聞いた番か。
//   当たる時だけ、物件検索のブレインの1つの元（area-rent-server.customerAreaAndRent）から相場の材料を受けて返信に渡す（数字は材料の物だけ）。
//   線は scripts/audit-rent-question.ts（お客様の発言で当たる文を目で読む）
const RENT_LEVEL_RE = new RegExp([
  String.raw`相場`,
  // 「8.5までの家賃で1dkはやっぱりないですよね」「7万以内だと厳しいですか」「この家賃だと難しい」
  String.raw`(?:[0-9０-９.．]+\s*万?(?:円)?(?:まで|以内|以下|台|前後)?|家賃|予算)[^。\n？?]{0,24}?(?:ない|無い|厳し|難し|出てこ|見つから|ありますか|あるんですか|あります？|ないですか)(?:ですよね|ですか|でしょうか|よね|かな|か)?`,
  String.raw`(?:家賃|予算)[^。\n]{0,10}(?:上げ|あげ)(?:たら|れば|ないと)`,
].join("|"), "i");
/** 物件1件の空きの質問（「ここ空いてますか」）は相場の質問ではない */
const NOT_RENT_RE = /空い|空き|募集|内覧|見積|初期費用|支払|振込|振り込|滞納|日割|請求|確定申告|お安く(?:出来|でき)|交渉|①|【|ご希望|諦め|保証/;
/** 「ない／厳しい／ありますか」の問いの形（言い切りの条件の連絡を外す） */
const ASK_FORM_RE = /(?:ない|無い|厳し|難し|出てこ|見つから|あり)(?:ます)?(?:ですよね|ですかね|ですか|でしょうか|よね|かな|か)?s*[？?💦😭🥲、,]|(?:ない|無い)(?:です)?よね|(?:ない|無い)感じ|相場/;

export function customerAsksRentLevel(turn: string | null | undefined): boolean {
  const t = String(turn ?? "").normalize("NFKC");
  if (!t.trim() || /^\s*\[画像\]/.test(t)) return false;
  if (!RENT_LEVEL_RE.test(t)) return false;
  if (NOT_RENT_RE.test(t) && !/相場/.test(t)) return false;
  if (!ASK_FORM_RE.test(t)) return false;
  return true;
}

export type RentMarketForReply = { area: string | null; facts: string[]; sentences: string[]; budgetSentence?: string | null; ageTendency?: "old" | "new" | null };

// 2026-10-02 竹内さん「この場合要約したら築年数古めとなるってことをちゃんとお客さんに伝えるようにする」:
//   予算の中で築年数古めの時に添える次の一手は、スタッフの実際の送信の文だけ（手打ちの送信から・言い回しを作らない）
export const RENT_OLD_NEXT_STEP_STAFF_LINES = [
  "家賃帯やご希望のエリア広げていただけましたらご紹介可能なお部屋増える形となります！！",
  "希望エリアを広げること可能でしたら再度オススメ出来るお部屋ピックアップ可能です！！",
] as const;

/**
 * 返信の生成に渡す相場の材料（generate-reply の【📍 場面と返信方針】の中）。
 *   お客様に書いてよい数字は sentences（スタッフの実際の型・件数が足りる時だけ・⑯ area-rent-explain が作る）の文の物だけ。
 *   facts（区ごとの件数・築年や面積の中央値 等）は方向を決める材料で、数字をお客様に書かない
 *   （予算と築年・面積の関係を言うスタッフの実際の文の型が無い＝作らない。2026-10-02 実送信 697通で 0）。
 */
export function buildRentMarketNote(rm: RentMarketForReply | null | undefined): string {
  if (!rm || (!rm.sentences.length && !rm.facts.length && !rm.budgetSentence)) return "";
  const lines = ["- 💴 家賃の相場（物件検索のブレインの材料・弊社の検索で見つかったお部屋から。お客様が相場・予算で出るかを聞いている）:"];
  if (rm.budgetSentence) {
    // 予算の中の目安（築年は10年刻み・広さは5㎡刻み・古め／浅めの要約）は必ず伝える（竹内さん 10/02）
    lines.push(`  ・必ずこの文をそのまま入れる（予算の中の目安・数字も言い回しも変えない）: 「${rm.budgetSentence}」`);
    if (rm.ageTendency === "old") lines.push(`  ・築年数古めの時は、続けて次の一手をスタッフの実際の文から1つだけそのまま: ${RENT_OLD_NEXT_STEP_STAFF_LINES.map((x) => `「${x}」`).join(" ／ ")}`);
  }
  const others = rm.sentences.filter((x) => x !== rm.budgetSentence);
  if (others.length) lines.push(`  ・お客様に送ってよい相場の文（数字も言い回しもそのまま・1文まで）: ${others.map((x) => `「${x}」`).join(" ／ ")}`);
  if (rm.facts.length) lines.push(`  ・事実（返信の方向を決める材料。ここの数字はお客様に書かない）: ${rm.facts.join(" ／ ")}`);
  lines.push("  ・上の文に無い相場・家賃の幅・築年数・広さの数字は書かない（作らない）。相場の文が無い時は数字を出さず、ご条件を広げたピックアップの提案など方向だけを書く");
  return lines.join("\n");
}
