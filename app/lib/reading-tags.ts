// app/lib/reading-tags.ts — お客様の読み方の札（決定論の候補・純関数）。④ 竹内さんがどう読んだか／⑤ よくある隠れた心配／データから要望の読み方
//
// 2026-11-03 作業員6（竹内さん KB P1「お客様の潜在意識と要点を読む部分を6つで強化」④⑤・「お客様の要望の読み方を実際の会話のデータの傾向から学ぶ」）。
//   ここで付けるのは全部「候補の札」。ブレインに渡す時も「候補」と書き、決めるのはブレイン（P0・統括 11/03）。
//   当たった割合が低い札（件数が少ない・半分以下しか当たらない）はブレインに渡さない（readingCandidateGate）。
//   置き場は takeuchi_compose_examples の read_beyond・hidden_worry・utter_type・true_want（週1の夜の cron が埋める）。
// テスト: app/lib/__tests__/reading-tags.test.ts

/** 隠れた心配の札（④の read_beyond と⑤の hidden_worry で同じ語彙） */
export const WORRY_TAGS = ["screening", "preempt", "cost", "timing", "partner", "commute", "support"] as const;
export type WorryTag = typeof WORRY_TAGS[number];
export const WORRY_JA: Record<WorryTag, string> = {
  screening: "審査に通るか", preempt: "先に申込が入らないか", cost: "初期費用・総額", timing: "入居の時期に間に合うか",
  partner: "同棲の相手・親の意向", commute: "職場・学校との距離", support: "ちゃんと相手にしてもらえるか（任せて大丈夫か）",
};
/** お客様の発言から読む隠れた心配の候補 */
const CUSTOMER_WORRY_RE: Record<WorryTag, RegExp> = {
  screening: /審査|通(?:る|り)ますか|収入|勤続|転職|フリーター|無職|自営|ブラック|保証会社|信販/,
  preempt: /埋まって|他の方|先に(?:申込|申し込み)|まだ空いて|まだありますか|早めに|急ぎ/,
  cost: /初期費用|総額|いくら|費用|安く|抑え|予算/,
  timing: /[0-9０-９]{1,2}月(?:中|頭|上旬|中旬|下旬|末)?(?:に|まで)?(?:入居|引っ越)|間に合|急ぎ|すぐ(?:に)?(?:入居|住)|退去/,
  partner: /彼氏|彼女|同棲|親|母|父|家族|二人|2人|パートナー|相談して/,
  commute: /職場|会社|勤務先|通勤|学校|大学|通学|まで[0-9０-９]{1,2}分|乗り換え/,
  support: /すみません|何度も|わがまま|ご迷惑|大丈夫でしょうか|不安/,
};
/** 竹内さんの返信が答えた心配（表の質問に加えて） */
const STAFF_ANSWER_RE: Record<WorryTag, RegExp> = {
  screening: /審査|保証会社|独立系|通過/,
  preempt: /お申込が入|先にお申込|抑えさせて|押さえ|人気|すぐに決ま/,
  cost: /初期費用|御見積|最大限割引|敷金礼金/,
  timing: /ご入居(?:日|時期)|間に合|[0-9０-９]{1,2}月(?:中|頭|上旬|中旬|下旬|末)/,
  partner: /お二人|ご同棲|ご家族|ご相談の上/,
  commute: /通いやすい|通勤|乗り換えなし|まで[0-9０-９]{1,2}分/,
  support: /全力でサポート|ご満足頂|最善|ご安心|お気軽に/,
};
export function worryCandidatesOf(customerText: string): WorryTag[] {
  const t = String(customerText ?? "").normalize("NFKC");
  return WORRY_TAGS.filter((k) => CUSTOMER_WORRY_RE[k].test(t));
}
/** ④ 竹内さんが表の質問に加えて答えた事（返信が答えた心配のうち、お客様の発言に表では出ていない物） */
export function readBeyondOf(customerText: string, staffText: string): WorryTag[] {
  const said = new Set(worryCandidatesOf(customerText));
  const s = String(staffText ?? "").normalize("NFKC");
  return WORRY_TAGS.filter((k) => STAFF_ANSWER_RE[k].test(s) && !said.has(k));
}

/** お客様の発言の型（データから要望の読み方） */
export const UTTER_TYPES = ["early_cost_ask", "station_near", "new_build", "repeat_ask", "slow_reply", "short_reply", "photo_ask", "many_questions"] as const;
export type UtterType = typeof UTTER_TYPES[number];
export function utterTypesOf(o: { customerText: string; turnNo?: number | null; replyGapMinutes?: number | null; prevCustomerTexts?: string[] }): UtterType[] {
  const t = String(o.customerText ?? "").normalize("NFKC");
  const out: UtterType[] = [];
  if ((o.turnNo ?? 99) <= 3 && /初期費用|総額|いくら/.test(t)) out.push("early_cost_ask");
  if (/駅近|駅から近|徒歩[0-9]{1,2}分(?:以内)?|駅チカ/.test(t)) out.push("station_near");
  if (/築浅|新築|新しめ|綺麗|きれい/.test(t)) out.push("new_build");
  const head = t.replace(/\s+/g, "").slice(0, 12);
  if (head.length >= 6 && (o.prevCustomerTexts ?? []).some((p) => p.replace(/\s+/g, "").includes(head))) out.push("repeat_ask");
  if (o.replyGapMinutes != null && o.replyGapMinutes >= 24 * 60) out.push("slow_reply");
  if (t.replace(/[\s\p{Extended_Pictographic}]/gu, "").length <= 8) out.push("short_reply");
  if (/写真|画像|室内|中の様子/.test(t)) out.push("photo_ask");
  if ((t.match(/[?？]|ですか|ますか/g) ?? []).length >= 3) out.push("many_questions");
  return out;
}

/** 候補の札をブレインに渡すかの線: 件数が min 以上・当たった割合が rate を超える物だけ（統括 11/03「半分以下しか当たらない札は渡さない」） */
export function readingCandidateGate(stats: ReadonlyArray<{ tag: string; n: number; hit: number }>, o: { min?: number; rate?: number } = {}): string[] {
  const min = o.min ?? 10, rate = o.rate ?? 0.5;
  return stats.filter((s) => s.n >= min && s.hit / Math.max(1, s.n) > rate).map((s) => s.tag);
}
/** ブレインへの材料の1行（候補と書く・決めるのはブレイン） */
export function worryCandidateLine(tags: ReadonlyArray<WorryTag>): string {
  if (!tags.length) return "";
  return `【奥の心配の候補（決定論の網・過去の竹内さんの返信で当たりの多い札だけ・当たっているかを決めるのはあなた）】${tags.map((k) => WORRY_JA[k]).join("／")}`;
}
