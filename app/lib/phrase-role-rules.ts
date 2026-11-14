// app/lib/phrase-role-rules.ts — 竹内さんの1文の役目を決まった語で読む（純関数・LLM なし）と、言い回しの骨（頭の言い方・終わりの言い方・敬語・強さ・形）
//
// 2026-11-15 作業員I（竹内さん 11/15「言い回しも具体的に細かく学ぶ・ちゃんと竹内の LINE から学習する」・設計図 feeling_conductor_linkage_1115 追記3）。
//   役目の名前は takeuchi-anatomy-roles（SENTENCE_ROLES）と同じ。文の切り方も同じ splitSentences。
//   今の役目は DeepSeek の3回読み（roles-r1・198番）だけ＝本番の送信 1,600通には当てられない → 境目の決まり（ROLES_SYSTEM の A〜I）を語の決まりにして、
//   語で言い切れない文は null（役目不明）として数える。roles-r1 の多数の役目に当てて、役目ごとの当たり（精度）を ROLE_RULE_PRECISION に残す（build-phrase-catalog-v2 が測る）。
// テスト: app/lib/__tests__/phrase-role-rules.test.ts
import type { SentenceRole } from "./takeuchi-anatomy-roles";

const N = (s: string) => String(s ?? "").normalize("NFKC").replace(/いただ/g, "頂").replace(/下さい/g, "ください").replace(/でき/g, "出来").replace(/致し/g, "致し");

/** 語の決まり（上から順に見る・最初に当たった役目）。境目は ROLES_SYSTEM の A〜I に合わせた */
export const ROLE_RULES: ReadonlyArray<[SentenceRole, RegExp]> = [
  ["greet", /^(?:〇〇さん|[^\s、。！!]{0,12}さん)?(?:お世話になっております|はじめまして|こんにちは|こんばんは|夜分遅くに失礼|お休みの所)/],
  // E: 抑え・申込の誘い（壁を下げる言葉と同じ文でも誘いを取る）
  ["apply", /お申込(?:み)?(?:し|頂き|頂け)?[^。]{0,12}(?:抑え|押さえ)|お部屋(?:を)?(?:抑え|押さえ)|お申込(?:み)?(?:如何|をオススメ|を推奨)|抑える(?:の|事)を(?:推奨|オススメ)|フォーマット(?:の)?ご入力/],
  ["viewing", /ご内覧|内覧|ご案内させて頂きます|お部屋ご案内|現地(?:エントランス)?お待ち合わせ|ご覧頂け/],
  ["estimate", /御見積|お見積(?:り|書)|見積書/],
  // H: お客様から材料をもらう
  ["ask_send", /お送り(?:頂け|の程|頂きます様)|お聞かせ頂け|お教え頂け|ご都合(?:よろしい|の良い)[^。]{0,12}(?:御座いますでしょうか|ございますでしょうか|教えて)|ご入力(?:頂け|の程)/],
  ["promise", /確認させて頂きます|確認出来次第|確認致します|確認して(?:参り|まいり)ます|お調べ(?:させて頂き|致し)ます|管理会社に確認/],
  // B: ピックアップ・新着を送る約束＝keep（全力でサポートは trust）
  ["keep", /ピックアップ(?:し|させて頂き)?[^。]{0,10}お送りさせて頂きます|ピックアップさせて頂きます|新着[^。]{0,20}(?:お送り|ご連絡)|募集(?:に)?出次第|随時(?:確認|お送り)|(?:気になる点|ご不明点)[^。]{0,16}(?:いつでも|何時でも|お気軽に)|いつでもお気軽にご連絡/],
  ["trust", /担当させて頂きます|全力で(?:サポート|お探し)|ご満足頂(?:く|ける)|最善(?:の)?(?:サポート|方法)|サポートさせて頂きます|弊社一同/],
  // D: 壁を自分から下げる
  ["barrier", /キャンセル料(?:は)?(?:かかり|掛かり)ません|敷金(?:・)?礼金(?:0円|なし|無し)|初期費用(?:を|面も|も)?(?:かなり|出来る限り|最大限)?(?:抑え|割引)|最大限割引|フリーレント|1部屋のみ|一部屋のみ/],
  // C: 受け
  ["uke", /^(?:はい|かしこまりました|承知(?:致し|いたし)?ました|ありがとう(?:ございます|御座います)|有難う(?:ございます|御座います)|(?:全然)?大丈夫です$)|(?:頂き|頂いて)(?:誠に)?ありがとう(?:ございます|御座います)|ありがとう(?:ございます|御座います)$|ごゆっくり|とのこと(?:、)?かしこまりました|大変嬉しく/],
  // F: 何も付かない「お気軽にお申し付けください」・何卒の締め
  ["close", /^(?:引き続き)?何卒(?:宜しく|よろしく)お願い(?:致|いた)します|^(?:引き続き)?(?:宜しく|よろしく)お願い(?:致|いた)します|^お気軽にお申し付けください|^それでは(?:一度)?失礼(?:致|いた)します/],
  // 答え（となります・可能です 等で言い切る文）。問いの無い番の事実の推しは G で役目が変わる＝言い切れないので answer に寄せない（answer は roles-r1 で精度を測る）
  ["answer", /(?:となります|可能です|御座います|ございます|大丈夫です|出来ます|おります)$/],
];

/** 1文の役目（語で言い切れない文は null＝役目不明） */
export function ruleRoleOf(sentence: string): SentenceRole | null {
  const t = N(sentence).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").replace(/[!！?？。、,\s]+$/g, "").trim();
  if (!t) return null;
  for (const [role, re] of ROLE_RULES) if (re.test(t)) return role;
  return null;
}

/** 1通の主の役目（決まった順: 答え→確かめる約束→誘い→新着の約束→壁→信頼→心配→受け→締め）。roles-r1 の main_role と当たりを測る */
export const MAIN_ROLE_ORDER: readonly SentenceRole[] = ["answer", "promise", "apply", "viewing", "estimate", "ask_send", "keep", "barrier", "trust", "worry", "uke", "close", "greet"];
export function mainRoleOf(roles: ReadonlyArray<SentenceRole | null>): SentenceRole | null {
  for (const r of MAIN_ROLE_ORDER) if (roles.includes(r)) return r;
  return null;
}

// ─── 言い回しの骨（本文は出さない・決まった語の札だけ） ─────────────
/** 頭の言い方（文の最初の決まった言い方）。当たらなければ null */
const OPENERS: ReadonlyArray<[string, RegExp]> = [
  ["お世話になっております", /^(?:〇〇さん|[^\s、。！!]{0,12}さん)?お世話になっております/], ["はじめまして", /はじめまして/], ["はい", /^はい/],
  ["かしこまりました", /^かしこまりました/], ["承知しました", /^承知/], ["ありがとうございます", /^(?:ありがとうございます|有難うございます)/],
  ["〜頂きありがとうございます", /頂き(?:誠に)?ありがとうございます/], ["お待たせ", /^お待たせ/], ["お送りさせて頂きました", /^お送りさせて頂きました/],
  ["こちら", /^こちら/], ["何卒", /^(?:引き続き)?何卒/], ["お手隙", /^お手隙/], ["夜分", /^夜分/],
];
export function openerOf(sentence: string): string | null {
  const t = N(sentence).trim();
  for (const [k, re] of OPENERS) if (re.test(t)) return k;
  return null;
}
/** 敬語の段（1通に入っているか） */
export const KEIGO: ReadonlyArray<[string, RegExp]> = [
  ["頂き", /頂き|頂け|頂いて/], ["致します", /致し(?:ます|ました)/], ["させて頂きます", /させて頂きます/], ["如何", /如何/], ["何卒", /何卒/], ["御座います", /御座い/], ["幸いです", /幸いです/],
];
export function keigoOf(text: string): string[] { const t = N(text); return KEIGO.filter(([, re]) => re.test(t)).map(([k]) => k); }
/** 強さ: 1文あたりの「！！」の数・許される絵文字の数と種類・許されない絵文字の数（feedback_emoji_allowlist） */
export const EMOJI_OK = ["😊", "😌", "🌟", "✨"] as const;
export function strengthOf(text: string): { bangPairs: number; bangSingles: number; emojiOk: Record<string, number>; emojiOther: number } {
  const t = String(text ?? "");
  const bangPairs = (t.match(/[！!]{2,}/g) ?? []).length;
  const bangSingles = (t.match(/(?<![！!])[！!](?![！!])/g) ?? []).length;
  const emojiOk: Record<string, number> = {};
  let emojiOther = 0;
  for (const m of t.match(/\p{Extended_Pictographic}/gu) ?? []) { if ((EMOJI_OK as readonly string[]).includes(m)) emojiOk[m] = (emojiOk[m] ?? 0) + 1; else emojiOther++; }
  return { bangPairs, bangSingles, emojiOk, emojiOther };
}
/** 長さと形: 行数・空行の有無・【】・箇条書き（・／①）の有無 */
export function formOf(text: string): { lines: number; blankLines: boolean; brackets: boolean; bullets: boolean; chars: number } {
  const t = String(text ?? "").replace(/\r/g, "");
  const ls = t.split("\n");
  return { lines: ls.filter((l) => l.trim()).length, blankLines: ls.some((l, i) => !l.trim() && i > 0 && i < ls.length - 1), brackets: /【[^】]+】/.test(t), bullets: /(?:^|\n)\s*(?:・|[①-⑨]|\d+[.．、)])/.test(t), chars: t.replace(/\s/g, "").length };
}
/** 名乗り（「〇〇と申します」「〇〇です」の名前）。竹内さん以外の名乗りの番は外す（11/12 統括役・名乗り「鈴木」は確かめるまで入れない） */
export function selfNameOf(text: string): string | null {
  const m = String(text ?? "").match(/担当させて頂きます\s*([^\s、。！!]{1,6})と申します|(?:株式会社|弊社)の?([^\s、。！!]{1,6})(?:です|と申します)/);
  return m ? (m[1] ?? m[2] ?? null) : null;
}
