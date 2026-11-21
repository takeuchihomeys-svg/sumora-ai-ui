// app/lib/trust-b4b5.ts — 信頼の土台（#55）B4・B5 の数えの決まり（純関数・DB/LLM なし）
//
// 2026-11-21 作業員N（統括役の割り振り・竹内さん 11/15「信頼の土台」: 正直 → 確認の約束 → 一つ一つに答える・memory/foundation_flex_trust_1121.md）
//   B4 正直: 確認の結果が不利（申込が入っている・募集終了・2番手）だったお部屋を、次の返信で伏せて内覧・申込に誘っていないか
//     （竹内さんの決まり: 申込が入っていた報告の次は代わりの物件・2番手で並行して探す＝memory feedback_sales_mindset_alternatives・aix-brain-contract の2番手）
//   B5 聞き直さない: お客様がもう答えた条件（エリア・家賃・間取り・入居時期・広さ・設備）を、こちらがまた問いの形で聞いていないか
//     （問いの見分けは our-part-types.splitOurPartsFine・お客様の答えの鍵は conditionKeysOf＝照らし合わせ表 exchange-ledger と同じ語）
// ここは決まった語の計算だけ。数えるのは scripts/audit-trust-b4b5.ts（読むだけ・夜に1本）。
import { splitOurPartsFine, conditionKeysOf } from "./our-part-types";

export type UnfavorableKind = "taken" | "ended" | "second";
export type UnfavorableFact = { kind: UnfavorableKind; name: string | null };

const UNFAV: Array<[UnfavorableKind, RegExp]> = [
  ["second", /[2２二]番手/],
  ["taken", /(?:お部屋)?(?:お?申込み?|お?申し込み)(?:が)?(?:既に|すでに)?(?:入って|入り|ございま|が入りま)|既に(?:お?申込|お申し込み)/],
  ["ended", /募集(?:が)?終了|募集を?終了|成約済|ご紹介(?:が)?(?:でき|出来)(?:ない|かね)/],
];
/** 文の中の建物の名前の候補（カタカナ・漢字・英字の4字以上の並びで、号室・募集状況・は の前にある物）。取れなければ null */
function nameNear(sentence: string): string | null {
  const s = sentence.normalize("NFKC").replace(/[【】「」]/g, " ");
  const m = s.match(/([ァ-ヶーA-Za-z一-龥・&]{4,}(?:[\s　]?[A-Za-zァ-ヶ一-龥]{1,8})?)(?:[\s　]*(?:[0-9]{2,4}号室|募集状況|は|の(?:お部屋|物件)))/);
  return m ? m[1].trim() : null;
}

/** こちらの文（AIX の確認の結果など）の中の不利な事実。1文ごとに種類と建物の名前（取れれば） */
export function unfavorableFactsOf(text: string): UnfavorableFact[] {
  const out: UnfavorableFact[] = [];
  for (const sent of String(text ?? "").split(/(?<=[！!。])\s*|\n+/)) {
    const hit = UNFAV.find(([, re]) => re.test(sent));
    if (hit) out.push({ kind: hit[0], name: nameNear(sent) });
  }
  return out;
}

const INVITE_RE = /ご内覧|ご案内(?:させて|可能|出来|でき)|お申込み?(?:頂|いただ|の方)|お部屋抑え|オススメ出来る|募集中/;
const OPEN_RE = /[2２二]番手|お?申込み?(?:が)?(?:入って|入り)|募集(?:が)?終了|ご紹介(?:が)?(?:でき|出来)ない|代わり|並行して|他の(?:お部屋|物件)|新たに(?:ピックアップ|お探し)|別の(?:お部屋|物件)/;
export type HideVerdict = "hid" | "told" | "not_about" ;
/**
 * 返信が不利な事実を伏せたか。
 *   told … 不利な事実か代わり（並行して探す・他のお部屋）に触れた
 *   hid  … 不利なお部屋の名前を出して誘った（内覧・申込・オススメ・募集中）のに、不利な事実にも代わりにも触れていない
 *   not_about … どちらでもない（そのお部屋に触れていない）
 */
export function hideVerdictOf(reply: string, facts: ReadonlyArray<UnfavorableFact>): HideVerdict {
  const t = String(reply ?? "").normalize("NFKC");
  if (!t.trim() || !facts.length) return "not_about";
  if (OPEN_RE.test(t)) return "told";
  const names = facts.map((f) => f.name).filter((n): n is string => !!n && n.length >= 4);
  const mentions = names.some((n) => t.includes(n.normalize("NFKC")) || t.includes(n.normalize("NFKC").slice(0, 6)));
  return mentions && INVITE_RE.test(t) ? "hid" : "not_about";
}

/** 聞き直しを数える条件の鍵（日程・物件の希望・事情は誘いの言い方と重なるので数えない） */
export const REASK_KEYS = ["area", "rent", "layout", "move_in", "size", "equipment"] as const;
export type ReaskKey = typeof REASK_KEYS[number];
/** こちらの文の問いのうち、お客様がもう答えた条件を聞いている物の鍵 */
export function reaskedKeysOf(ourText: string, priorCustomerTexts: ReadonlyArray<string>): ReaskKey[] {
  const asked = splitOurPartsFine(ourText, new Date(0).toISOString())
    .filter((p) => p.kind === "question")
    .map((p) => p.key.replace(/^question\./, ""))
    .filter((k): k is ReaskKey => (REASK_KEYS as readonly string[]).includes(k));
  if (!asked.length) return [];
  const answered = new Set(priorCustomerTexts.flatMap((t) => conditionKeysOf(String(t ?? ""))));
  return [...new Set(asked.filter((k) => answered.has(k)))];
}
