// scripts/lib/r8-style-targets.ts — 8巡目: 返事の文の「書き方の形」を決定論で取り出す（監査用・純関数）
//   true＝その形で書いた／false＝書かなかった／null＝当てはまらない（例: 呼び名で始まらない文に「呼び名の後の改行」は無い）
const E = "[\\p{Extended_Pictographic}\\u{FE0F}]";
const NAME_HEAD = /^[^\n、！!。？?]{1,14}(?:さん|様)/;
/** 呼び名・挨拶の行を外した本文の頭 */
export function stripHead(s: string): string {
  return s.trim()
    .replace(/^[^\n、！!。？?]{1,14}(?:さん|様)[、,\s]*/, "")
    .replace(/^(?:お世話になっております|お世話になります)[\p{Extended_Pictographic}\u{FE0F}]*[！!。]*\s*/u, "")
    .trim();
}
export type StyleKey = "nanitozo" | "nanitozoLast" | "shokiHiyou" | "nameNewline" | "openerBlank" | "kashikoStart" | "haiStart" | "openerEmoji" | "emojiThenBang" | "itadakiKanji" | "greeting" | "anyEmoji";
export const STYLE_JA: Record<StyleKey, string> = {
  nanitozo: "何卒よろしくお願い致します（どこかに）",
  nanitozoLast: "何卒…で締める（最後の文）",
  shokiHiyou: "「初期費用も最大限割引…」の一文",
  nameNewline: "呼び名の後で改行",
  openerBlank: "開口語の後に空行",
  kashikoStart: "かしこまりましたで始める",
  haiStart: "はいで始める",
  openerEmoji: "開口語に絵文字（かしこまりました😊！！）",
  emojiThenBang: "行末の絵文字の後に！！",
  itadakiKanji: "頂き（漢字）",
  greeting: "お世話になっております",
  anyEmoji: "絵文字を使う",
};
export function styleTargets(raw: string): Record<StyleKey, boolean | null> {
  const s = String(raw ?? "").trim();
  const body = stripHead(s);
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  const emoLines = s.split("\n").map((l) => l.trim()).filter((l) => new RegExp(`${E}+[！!]*$`, "u").test(l));
  const opener = /^(?:はい|かしこまりました|承知(?:いた|致)?しました)/.test(body);
  return {
    nanitozo: /何卒(?:宜しく|よろしく)お願い(?:致|いた)します/.test(s),
    nanitozoLast: /何卒(?:宜しく|よろしく)お願い(?:致|いた)します/.test(last),
    shokiHiyou: /初期費用[もをは面]{0,2}[^\n]{0,4}最大限[^\n]{0,4}割引させて(?:頂|いただ)き(?![^\n]{0,12}(?:御|お)見積)/.test(s),
    nameNewline: NAME_HEAD.test(s) && !/^(?:お客様|皆様)/.test(s) ? /^[^\n、！!。？?]{1,14}(?:さん|様)[ \t　]*\n/.test(s) : null,
    openerBlank: new RegExp(`^(?:はい|かしこまりました|承知(?:いた|致)?しました)${E}*[！!。]*\\n`, "u").test(body) ? new RegExp(`^(?:はい|かしこまりました|承知(?:いた|致)?しました)${E}*[！!。]*\\n[ \\t　]*\\n`, "u").test(body) : null,
    kashikoStart: /^(?:かしこまりました|承知(?:いた|致)?しました)/.test(body),
    haiStart: /^はい/.test(body),
    openerEmoji: opener ? new RegExp(`^(?:はい|かしこまりました|承知(?:いた|致)?しました)${E}`, "u").test(body) : null,
    emojiThenBang: emoLines.length ? emoLines.every((l) => new RegExp(`${E}+[！!]+$`, "u").test(l)) : null,
    itadakiKanji: /頂き|いただき/.test(s) ? (/頂き/.test(s) && !/いただき/.test(s)) : null,
    greeting: /お世話になっております|お世話になります/.test(s),
    anyEmoji: new RegExp(E, "u").test(s),
  };
}

/**
 * 書き手の手掛かり（8巡目で見つけた）→ 2026-10-08 に app/lib/staff-writer.ts へ移した（純関数・テスト付き・確からしさつき）。
 *   変わった所: 「ござ」を B の手掛かりから外した（竹内さんも「ございます」と打つ・夜の手打ち 18%）／資料文（🌟カード・【】見積）は不明。
 *   正＝A・負＝B・0＝分からない（旧の形を残す）。名乗り（鈴木・竹内）・目的の形・時刻は使わない
 */
import { writerFromText, writerLetter } from "../../app/lib/staff-writer";
export function writerScore(s: string): number { return writerFromText(s).score; }
export const writerOf = (s: string): "A" | "B" | "?" => writerLetter(writerFromText(s));
