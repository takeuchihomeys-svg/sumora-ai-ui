// app/lib/scene-patterns.ts
// 2026-09-12 竹内方針A: 「AIX で送る場面」の判定と、断言検査（ASSERTION_BAN_RULES）・募集状況判定が共有する正規表現と橋渡し文。
// 依存ゼロ（validate-reply / aix-reply-set / route.ts / confirmation-context が import する。循環を作らない）。
// 原則: 同じ事実（時間枠の「空いて」・入居日の質問・審査の質問）を複数の段が別々に判定しない。直す時はこのファイルだけを直す。

/** 時間枠・日程の表現。「明日ってまだ空いてますか」「17:45～18:45のお時間のみ空いております」の「空いて」は空室ではなく内覧枠 */
export const SCHEDULE_SLOT_RE =
  /時間|[0-9０-９]{1,2}\s*[:：時]|日程|枠|お日にち|[月火水木金土日]曜|曜日|明日|明後日|今日|本日の?(?:午前|午後|夕方|夜)|午前|午後|夕方|土日|週末/;

/** 文中の「空いて〜」が時間枠の話か（直前15字に時間表現）。空室の断言・募集状況の質問から除外する */
export function isScheduleSlotVacancy(text: string, idx: number): boolean {
  const pre = text.slice(Math.max(0, idx - 15), idx);
  return SCHEDULE_SLOT_RE.test(pre);
}

/** 顧客文に「時間枠＋空いてますか」がある（内覧日程の質問。S4 viewing_invite） */
export const SLOT_AVAILABILITY_Q_RE = new RegExp(
  `(?:${SCHEDULE_SLOT_RE.source})[^\\n。！!？?]{0,15}空いて(?:ますか|ますでしょうか|いますか|いますでしょうか|る|ます[？?])`,
);

/** 顧客文の「空いて」がすべて時間枠の話か（募集状況の質問として扱わない） */
export function allVacancyWordsAreSlots(text: string): boolean {
  const re = /空いて/g;
  let hit = false;
  for (const m of text.matchAll(re)) {
    hit = true;
    if (!isScheduleSlotVacancy(text, m.index ?? 0)) return false;
  }
  return hit;
}

/** 入居日の質問（S2）。物件が特定できる時だけ AIX【確認した→入居可能日】の場面 */
export const MOVEIN_Q_RE = /いつから(?:住|入居|お?引(?:っ)?越)|入居(?:可能|でき|出来)(?:日|る日|ますか|ますでしょうか|る(?:の|か))|最短[^\n。！!？?]{0,10}入居|いつ(?:頃|ごろ)?(?:入居|住め)|何日から(?:住|入居)/;

/** 審査の質問（S3）。物件が特定できる時だけ AIX【確認した→保証会社（審査面）】の場面 */
export const SCREENING_Q_RE = /審査[^\n。！!？?]{0,8}(?:通|厳し|緩|ゆる|甘|きつ|キツ|難し)|保証会社(?:は|って|どこ|はどこ|の審査)/;

/** 内覧希望（S4）。旧 AIX_VIEWING_INTENT_RE ＋「拝見・見に行け・行けます・いけるみたい」 */
export const VIEWING_INTENT_RE = /見に行き|見に行け|内覧|内見|見学|見てみたい|拝見|行けます|いけ(?:る|ます)みたい/;

/** 日時の指定（S5）: 時刻表現 */
export const TIME_SPEC_RE = /[0-9０-９]{1,2}\s*(?:時|[:：][0-9０-９]{2})/;
/** 日時の指定（S5）: 依頼語 */
export const TIME_REQUEST_RE = /お願い|可能|大丈夫|行けます|いけます|伺|でき(?:ます|れば)|予約/;

// ─── 本文の橋渡し文（スタッフの実際の文）。後処理の断言置換（validate-reply ASSERTION_BAN_RULES.replacement）と AIX セット時の bridge が同じ定数を見る ───
export const BRIDGE_VACANCY_CHECK = "お送り頂きましたお部屋の募集状況確認させて頂きます😊！！";
export const BRIDGE_MOVEIN_CHECK = "最短入居日も合わせて確認させていただきます！！";
/** messages の手打ち「保証会社の情報確認させて頂いた上で審査の通りやすさご連絡させて頂き…」（3通）から採った文 */
export const BRIDGE_SCREENING_CHECK = "保証会社の情報確認させて頂いた上で審査の通りやすさご連絡させて頂きます！！";

/** 断言置換文（後処理）。AIX を assertion 由来でセットする時もこの文を bridge に使う */
export const ASSERTION_REPLACEMENT = {
  DISCLOSURE_ASSERTION: "告知事項につきましては管理会社に確認の上お伝えさせて頂きます！！",
  VACANCY_ASSERTION: "最新の空き状況を確認しご連絡させて頂きます😊！！",
  MOVEIN_DATE_ASSERTION: "ご入居可能日につきましては管理会社に空き状況を確認しご連絡させて頂きます！！",
  SCREENING_ASSURANCE: "審査結果につきましては保証会社の審査次第となりますが、お申込みは最大限サポートさせて頂きます！！",
} as const;
