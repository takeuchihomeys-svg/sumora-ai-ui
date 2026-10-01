// app/lib/check-result-closing.ts
// AIX【物件確認した】（募集状況の確認結果）の定型の文の「締め」を決める（純関数・DB 依存なし）。
//
// 2026-10-01 竹内「物件オススメのところが改善されたように、見積書や他のよく使うAIXテンプレートの部分も改善する」
//   実送信を「スタッフが書いた／AI の下書きを直した／ほぼそのまま」に分けて、定型の行をスタッフが残したか消したかを数えた
//   （scripts/audit-check-result-lines.ts・365日・YUMA 除く・下書きと送った文の組 233）:
//     ・一部募集終了の「引き続き条件に合うお部屋を探させていただきます！！」 下書き 50 → 残 16・消 34（68%）／スタッフが自分で書いた通 0/19
//     ・全部募集終了の「引き続き〇〇さんのご条件に合ったお部屋をピックアップしてお送りさせて頂きます！！」 下書き 28 → 残 9・消 19（68%）／0/19
//       （＝こちらがまだしていない約束。設計知見「していない約束を作らない」と同じ向き）
//     ・退去予定1件の「お気に召されましたらお申込みしお部屋を抑えさせていただきます！！」 下書き 12 → 申込を残した 2・ご査収で終わる 6
//       （全体でも申込の誘い 下書き 19 → 消 16・84%）
//     ・下書きが「…御見積書同封させて頂きました！！」で終わる 58組 → スタッフがご査収／ご確認で締めた 36（62%）・同封の行のまま 13
//   → 定型からは約束と申込の誘いを外し、御見積書を同封した時は「お手隙の際にご査収ください！！」で締める（足すだけ）。
//   言い回しは実送信のまま（スタッフが足したご査収の最多の形「お手隙の際にご査収ください！！」43通）。

import { hasClosingSentence } from "./recommend-cta";

export const CHECK_RESULT_RECEIPT_LINE = "お手隙の際にご査収ください！！";

/**
 * 御見積書を同封した確認結果に締めが無ければ、最後に「お手隙の際にご査収ください！！」を足す（足すだけ・消さない）。
 * 既に締め（ご査収・ご確認・内覧のご案内・申込の誘い）がどこかにある時は何もしない。
 */
export function appendCheckResultReceipt(text: string, o: { hasEstimate: boolean }): { text: string; added: boolean } {
  const src = String(text ?? "");
  if (!o.hasEstimate || !src.trim()) return { text: src, added: false };
  if (hasClosingSentence(src, "receipt") || hasClosingSentence(src, "viewing") || hasClosingSentence(src, "apply")) return { text: src, added: false };
  // 内覧の誘い（「ご都合よろしいお日にちにご案内させて頂きます」＝「お気に召されましたら」で始まらない形）も締めとみなす
  if (/ご都合(?:よろしい|の良い)お日にちにご案内させて(?:頂|いただ)きます/.test(src)) return { text: src, added: false };
  return { text: `${src.replace(/\s+$/, "")}\n\n${CHECK_RESULT_RECEIPT_LINE}`, added: true };
}
