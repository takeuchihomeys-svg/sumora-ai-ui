// app/lib/other-candidates-read.ts — 物件を送った後の「良さそう・一旦見てみたい＋他にも候補があれば」を内覧の依頼と読まない（純関数・LLM なし）
//
// 2026-11-06 作業員1（弱い所 61・q174・統括役の案 (a)）: 物件オススメの直後に、お客様が
//   「広くて綺麗ですね！一旦見てみたいです！場所が少し遠い気もしてて、もし他にも候補ありましたらお願いしたいです」と送った番で、
//   ブレインが「見てみたい」を内覧の依頼と読み、customer_questions・turn_contract の background・proposals・key_topics に「内覧」を書いて
//   頼まれていない内覧を誘っていた。前からある「もう少し見てみたい」の材料（customerAsksMoreListings）はこの言い方を拾わない。
//   竹内さん本人の実送信（200日・同じ型 3番）: 他の候補をピックアップする約束（または送った）3/3・内覧に誘った 0・AIX【内覧調整】0。
//     従業員も 5番のうち 4番がピックアップ（7/31「部屋見てみたいのですが、他の部屋も紹介してみたい」もピックアップ）・内覧 0。
//   ＝判断の手本（竹内さんの一手）として材料に足す。答えを決める規則ではなく、ブレインが読む材料（P0「判断はすべてブレイン基準」）。
//   内覧・内見・見学・日程・日時の言葉がある番は、本当の内覧の依頼なので出さない。
//   既定 off（入れる BRAIN_OTHER_CANDIDATES_READ=on）。
//   試験（DeepSeek・11/06・$0.30）: q174 の道は on 6/6・off 2/2 で両方合格（道は元から外れていない）。読み（内覧の語）は off 2/2 が
//   key_topics・customer_questions・situation の全部に内覧 → on（この文）3回は customer_questions 3/3 で消え・key_topics 1/3・situation 1/3、
//   書く欄を名指しした強い文 3回は 0/3（揺れの幅の中）。効きが弱く揺れるので既定 off のまま。q087・q129 はこの材料が当たらない番（入力同じ）で
//   on の回の外れは「どの物件か特定できない」と読んだ揺れ（main でも q129 1/4）。

import { normalizeCustomerText } from "./reply-context";

export function otherCandidatesReadOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_OTHER_CANDIDATES_READ ?? "").trim().toLowerCase() === "on";
}

/** 他の候補の依頼（他にも候補があれば・他の部屋も紹介して 等） */
export const OTHER_CANDIDATES_RE = /(?:他にも|ほかにも|他の|ほかの|別の)(?:候補|物件|お部屋|部屋)|他に(?:も)?(?:候補|良さそう|いい(?:物件|お部屋|部屋))|候補(?:が)?(?:あれば|ありましたら|ございましたら|あったら)/;
/** 本当の内覧の依頼の言葉（あれば出さない） */
// 監査（200日・物件を送った後の約40番）: 内覧が最初の一手だった番は 0。「拝見」（9/02 似た部屋を拝見し確認）・申込（11/05 別の物件にお申し込み）・質問（7/09 他の物件の疑問）は外す
export const VIEWING_WORDS_RE = /拝見|申込|申し込|疑問|質問|内[覧見]|見学|日程|日時|何日|何時|\d{1,2}\s*[日時]|[0-9０-９]{1,2}\s*[:：]\s*[0-9０-９]{2}|土曜|日曜|土日|週末|今週|来週|明日|明後日|空いて(?:いる|る)日|ご案内(?:して|お願い|いただ|頂)/;
/** 送った物件への好感（内覧の依頼と取り違えやすい言葉） */
export const LIKING_RE = /見てみたい|見たい|良さそう|よさそう|いいですね|良いですね|綺麗|きれい|素敵|いい感じ|気になり|気になる/;

export type OtherCandidatesRead = { hit: boolean; liking: boolean };

/** この番が「送った物件の後・他の候補の依頼・内覧の言葉なし」か */
export function readOtherCandidates(i: { customerText: string | null | undefined; sentPropertyCount: number; alreadySeeMore?: boolean }): OtherCandidatesRead {
  const c = normalizeCustomerText(i.customerText);
  if (!c.trim() || i.sentPropertyCount <= 0 || i.alreadySeeMore) return { hit: false, liking: false };
  if (!OTHER_CANDIDATES_RE.test(c) || VIEWING_WORDS_RE.test(c)) return { hit: false, liking: false };
  return { hit: true, liking: LIKING_RE.test(c) };
}

/** 竹内さんの実送信の手本（伏せた・名前は〇〇） */
export type OtherCandidatesExample = { conv: string; at: string; customer: string; actual: string; staff: string; writer: "takeuchi" | "employee" };
export const OTHER_CANDIDATES_EXAMPLES: ReadonlyArray<OtherCandidatesExample> = [
  { conv: "c068a6a3-1018-40c6-8224-8388c98f6469", at: "2026-10-16", writer: "takeuchi",
    customer: "広くて綺麗ですね！一旦見てみたいです！場所が少し遠い気もしてて、もし他にも候補ありましたらお願いしたいです",
    actual: "約束の返信（探す）", staff: "かしこまりました！！駅から近くて〇〇さんにオススメできるお部屋を新たにピックアップしてお送りさせて頂きます！！" },
  { conv: "b50fd451-2393-4826-b61f-34db7aefa55d", at: "2026-09-19", writer: "takeuchi",
    customer: "その日に他の物件も見たいのでまた出していただけると助かります",
    actual: "約束の返信（探す）", staff: "かしこまりました！！21日16時のご案内に合わせて、オススメできるお部屋ピックアップしてお送りさせて頂きます😊！！" },
  { conv: "e9b2c02c", at: "2026-07-31", writer: "employee",
    customer: "部屋見てみたいのですが、他の部屋も紹介してみたいです！",
    actual: "約束の返信（探す）", staff: "かしこまりました！！エリア広がること可能でしたら追加でオススメ物件お送り可能です！！" },
];

/** 手本の選び（同じ会話・試験の元の会話は外す＝答えが漏れない） */
export function pickOtherCandidatesExamples(conversationId: string | null | undefined, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): OtherCandidatesExample[] {
  const ex = new Set([String(conversationId ?? ""), ...String(env.BRAIN_JUDGE_EXAMPLES_EXCLUDE_CONV ?? "").split(",")].map((x) => x.trim()).filter(Boolean));
  return OTHER_CANDIDATES_EXAMPLES.filter((e) => ![...ex].some((x) => e.conv === x || x.startsWith(e.conv) || e.conv.startsWith(x)));
}

/** ブレインの材料の文（当たらなければ空） */
export function otherCandidatesBrainText(r: OtherCandidatesRead, examples: ReadonlyArray<OtherCandidatesExample>): string {
  if (!r.hit) return "";
  const lines = examples.map((e, i) => `${i + 1}. お客様「${e.customer}」→ ${e.writer === "takeuchi" ? "竹内さん" : "スタッフ"}: ${e.actual}「${e.staff}」`);
  return `\n\n【読み方の手本（物件を送った後の「他にも候補があれば」）】お客様は送ったお部屋の他の候補を頼んでいる。${r.liking ? "「見てみたい・良さそう・綺麗」は送ったお部屋への好感で、内覧の依頼ではない（内覧・日程・日時の言葉が無い）。customer_questions・proposals・key_topics に内覧を書かない。" : ""}
竹内さんの実送信（同じ型 3番）: 他の候補をピックアップする約束（または送った）3・内覧に誘った 0・AIX【内覧調整】0。${lines.length ? `\n${lines.join("\n")}` : ""}
※ 決めるのはこの会話の事実。お客様が内覧・日程を言った番はこの手本に当たらない。`;
}
