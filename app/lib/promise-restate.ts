// app/lib/promise-restate.ts — 下書きが「前にこちらがした約束」をもう一度言い直しているかを見分ける（純関数・LLM なし・既定 off）
//
// 2026-11-21 作業員K2（台帳 #442「2通目や次の返信で同じ事を何度も言う」・統括役の頼み）。
//   今朝の表（ai_reply_examples 979番）: 前の塊と同じ文を書いた番は AI の下書き 75・竹内さんたちが送った文 47・AI だけ 32。
//   AI だけ 32 のうち 15 が約束の言い直し（「ピックアップ出来次第お送りさせて頂きます」等を、前の番で言ったのにまた書く）。
//   竹内さんが同じ約束を言い直すのは、お客様が進み具合を聞いた（催促）時と、お客様が新しい条件・物件を足した時（その条件で探す約束＝新しい約束）だけ（0527d63f の分け）。
// 見分け方: draft-repeat.topicRepeats（前のこちらの文に同じ中身の約束がある下書きの約束の文）を元に、
//   ①お客様のこの番が催促（まだ・どうなり・進捗・いつ頃）→ 言い直してよい（reminder）
//   ②お客様のこの番が新しい条件・物件（条件の語・URL・号室・画像）→ 新しい約束（new_scope）
//   ③それ以外 → 約束の言い直し（restate）＝竹内さんは書かない
// 使い方（これから）: 書き手への注記（言い直さない約束の中身）か、最終チェックの印。出口で本文を消すのは監査で誤削除0を確かめてから。
// ■ スイッチ PROMISE_RESTATE_MARK: 既定 off（何もしない）／on（呼ぶ側が印・注記に使う）
// テスト: app/lib/__tests__/promise-restate.test.ts（実物の言い回しを伏せた形）
import { topicRepeats, type PromiseTopic } from "@/app/lib/draft-repeat";

type Env = Record<string, string | undefined>;
export function promiseRestateMarkOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.PROMISE_RESTATE_MARK ?? "").trim().toLowerCase() === "on";
}

const REMINDER_RE = /まだ(?:です|でしょう|ですか|かな)|どう(?:なり|なって)|進捗|いつ頃|いつごろ|いつになり|ご連絡(?:まだ|お待ち)|待って(?:ます|います|おります)|その後/;
const NEW_SCOPE_RE = /https?:\/\/|号室|\[画像\]|家賃|万円|間取り|[1-5]\s*(?:LDK|DK|K)|ワンルーム|エリア|駅|徒歩|築|ペット|駐車場|オートロック|バス.?トイレ|独立洗面|カウンターキッチン|条件|に変更|も(?:探して|見たい|いい)|他(?:に|の)(?:物件|お部屋)/;

export type RestateKind = "restate" | "reminder" | "new_scope";
export type RestateHit = { kind: RestateKind; topic: PromiseTopic; sentence: string; ref: string; back: number };

/**
 * @param draft 下書き
 * @param priorOurTexts 前のこちらの通（新しい順・AIX の文を含む）
 * @param customerTurn お客様のこの番の発言（束）
 */
export function promiseRestates(draft: string, priorOurTexts: ReadonlyArray<string>, customerTurn: ReadonlyArray<string>): RestateHit[] {
  const reps = topicRepeats(draft, priorOurTexts.map((text, i) => ({ text, back: i + 1 })));
  if (!reps.length) return [];
  const cust = customerTurn.join("\n").normalize("NFKC");
  const kind: RestateKind = REMINDER_RE.test(cust) ? "reminder" : NEW_SCOPE_RE.test(cust) ? "new_scope" : "restate";
  return reps.map((r) => ({ kind, ...r }));
}

const TOPIC_JA: Record<PromiseTopic, string> = { pickup: "物件のピックアップ", vacancy: "募集状況の確認", estimate: "御見積書", viewing: "内覧のご案内", mgmt: "管理会社への確認", screening: "審査", contact: "確認できた時のご連絡" };
/** 書き手への注記（restate だけ・無ければ ""） */
export function promiseRestateNote(hits: ReadonlyArray<RestateHit>): string {
  const xs = [...new Set(hits.filter((h) => h.kind === "restate").map((h) => TOPIC_JA[h.topic]))];
  if (!xs.length) return "";
  return `【前にした約束（言い直さない）】${xs.join("・")}は前の通でもう約束している。この番は同じ約束を書き直さない（お客様が進み具合を聞いた時・新しい条件や物件を足した時だけ言い直す）。`;
}
