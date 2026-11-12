// final-check-roots2.ts — 最終チェックの残りの穴の直し（作業員20・2026-11-12・統括役「既定 off で作ってよい」）。各スイッチは既定 off（on の時だけ動く・本文は書き換えない）。
//
//   ・FC_TIME_INVALID_TARGET … 「本日中に」の約束の相手を見る。いまは18時以降なら相手を問わず TIME_INVALID_HONIJITSU（自動送信は block）。
//     18時は管理会社の窓口の終わり。スタッフ自身の作業（物件のピックアップ・お送り・見積）の約束は、スタッフの電話対応が19時まで（メモリ fact_phone_hours・10/02）なので18〜19時は実行できる。
//     on の時は、管理会社・オーナー・貸主・募集状況・空室・番手に掛かる文だけを18時で止め、自社の作業の文は19時で止める（土日の線は今までどおり）
//   ・FC_BANNED_MATERIAL … BANNED_WORD の数値の言い回し（「家賃の2ヶ月分」「初期費用は家賃の」等）は、資料（materialFacts）に同じ項目と同じ数があれば block しない（礼金・敷金・保証料の説明）
//   ・FC_RULES_SLICE_ALIGN … finalCheckRules の切り方が rule_check は3000字・anomaly_scan／context_check は2000字とずれていた（3000字を超える分は2つの段に届かず、切ったログも rule_check だけ）。3つの段で3000字に揃え、切った時はログを出す

import { COMPANY_CLOSE_HOUR, isVacancyConfirmObject } from "./mgmt-hours-split";

type Env = Record<string, string | undefined>;
const envOf = (env?: Env): Env => env ?? (typeof process !== "undefined" ? process.env : {});
const on = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "on";

export function fcTimeInvalidTargetEnabled(env?: Env): boolean { return on(envOf(env).FC_TIME_INVALID_TARGET); }
export function fcBannedMaterialEnabled(env?: Env): boolean { return on(envOf(env).FC_BANNED_MATERIAL); }
export function fcRulesSliceAlignEnabled(env?: Env): boolean { return on(envOf(env).FC_RULES_SLICE_ALIGN); }
export function fcTimeVacancy21Enabled(env?: Env): boolean { return on(envOf(env).FC_TIME_VACANCY_21); }

// ─── 本日中の約束の相手 ───
/** 管理会社側の返事・動きに掛かる文（18時で窓口が閉まる相手） */
const MGMT_TARGET_RE = /管理会社|オーナー|貸主|大家|元付|募集状況|空室|空き状況|番手|入居可能|退去|審査結果|交渉/;
/** 窓口が閉まる側の確認（番手・入居可能日・審査結果）。isVacancyConfirmObject（mgmt-hours-split・設備・交渉・鍵・駐車場 等を除く）に足す除外 */
const STRICT_EXTRA_RE = /番手|入居可能|審査結果/;
export function isVacancyOnlyPromise(sentence: string): boolean { return isVacancyConfirmObject(sentence) && !STRICT_EXTRA_RE.test(sentence); }
/** その日のその時刻に、約束の文を「本日中」に実行できないとして止めるか（false＝止めない） */
export function sameDayPromiseBlocked(o: { sentence: string; hour: number; isWeekend: boolean; env?: Env }): boolean {
  const legacy = o.hour >= 18 || o.isWeekend;
  if (!fcTimeInvalidTargetEnabled(o.env)) return legacy;
  if (o.isWeekend) return true;
  // 2026-11-12 作業員20（FC_TIME_VACANCY_21・既定 off）: 竹内さんの決定 5fe999f8（11/04）「募集状況の確認（ポータル・業者サイトで確かめられる物）は21時より前は営業時間の終了を付けない・設備の確認と交渉は18時の線」
  if (fcTimeVacancy21Enabled(o.env) && isVacancyOnlyPromise(o.sentence)) return o.hour >= COMPANY_CLOSE_HOUR;
  if (MGMT_TARGET_RE.test(o.sentence)) return o.hour >= 18;
  return o.hour >= 19;
}
/** idx を含む文（。！改行の区切り） */
export function sentenceAtIndex(text: string, idx: number): string {
  const cut = (re: RegExp, from: number, back: boolean) => { let i = from; while (i >= 0 && i < text.length && !re.test(text[i])) i += back ? -1 : 1; return i; };
  const s = cut(/[。！!？?\n]/, idx, true);
  let e = cut(/[。！!？?\n]/, idx, false);
  while (e < text.length - 1 && /[。！!？?]/.test(text[e]) && /[。！!？?]/.test(text[e + 1])) e++;
  return text.slice(s < 0 ? 0 : s + 1, e >= text.length ? text.length : e + 1).trim();
}

// ─── BANNED_WORD の数値の言い回しの資料免除 ───
const NUMERIC_BANNED = new Set(["初期費用は家賃の", "家賃の2ヶ月分", "家賃の3ヶ月分"]);
const ITEM_LABEL_RE = /礼金|敷金|保証料|保証金|仲介手数料|更新料|賃料/;
/** 禁止語が資料で裏付く数値の説明か（同じ項目＋同じ「Nヶ月」が materialFacts に書いてある時だけ true＝block しない） */
export function bannedWordMaterialGrounded(word: string, text: string, materialFacts: string | null | undefined, env?: Env): boolean {
  if (!fcBannedMaterialEnabled(env) || !NUMERIC_BANNED.has(word) || !materialFacts) return false;
  const i = text.indexOf(word);
  if (i < 0) return false;
  const sent = sentenceAtIndex(text, i);
  const item = sent.match(ITEM_LABEL_RE)?.[0];
  const num = (sent.match(/([0-9０-９]+(?:\.[0-9]+)?)\s*(?:ヶ月|か月|カ月)/)?.[1] ?? "").normalize("NFKC");
  if (!item || !num) return false;
  const mat = materialFacts.normalize("NFKC");
  return mat.split("\n").some((l) => l.includes(item) && new RegExp(`${num.replace(".", "\\.")}\\s*(?:ヶ月|か月|カ月)`).test(l));
}

// ─── ルールの切り方 ───
export const FC_RULES_LIMIT_LEGACY = 2000;
export const FC_RULES_LIMIT = 3000;
export function finalCheckRulesLimit(env?: Env): number { return fcRulesSliceAlignEnabled(env) ? FC_RULES_LIMIT : FC_RULES_LIMIT_LEGACY; }
