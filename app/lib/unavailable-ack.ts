// app/lib/unavailable-ack.ts — 「募集終了・募集に出ていない・申込が入った」報告の後のお礼の番（純関数・DB/LLM なし）
//
// 2026-10-15 竹内さん（ゆなまるさん 10/09・会話 63fa0c26）: スタッフ「お送り頂きました〇〇につきまして…現在募集に出ていないお部屋となっております！！
//   引き続き新着で…出次第お送りさせて頂きます！！」→ お客様「ありがとうございます！」→ 下書き「お気に召されましたらご都合よろしいお日にち
//   御座いますでしょうか！！ご案内させて頂きます！！」。「募集していないとなっているのに。何の話をしているのかの軸が分からない」。
//   この番の話題（軸）＝こちらの直前の報告（そのお部屋は募集に出ていない）＋残した約束（新着が出次第お送り）。
//   内覧・申込の誘い（お気に召されましたら…）は「気に入って頂けるお部屋」が話題にある時の扉の文で、話題のお部屋が募集に出ていない番では指す物が無い。
// 戻す: UNAVAILABLE_ACK_AXIS=off

const N = (s: string | null | undefined) => String(s ?? "").normalize("NFKC");

export function unavailableAckAxisEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.UNAVAILABLE_ACK_AXIS ?? "").trim().toLowerCase() !== "off";
}

/** 募集に出ていない・終了・申込が入った・成約の報告 */
const UNAVAILABLE_RE = /募集(?:に|が)?(?:出て|でて)(?:い|お)?(?:ない|りません|ございません)|募集(?:が)?終了|募集(?:を)?(?:停止|ストップ)|募集(?:して)?(?:い|お)?(?:ない|りません)|募集(?:が)?(?:無い|ない|ございません)|(?:お?申込み?|お?申し込み)(?:が)?(?:入り|入って|入った|ございま|あり)|成約(?:済|して|となり|になり)|空き(?:が)?(?:無い|ない|ございません)|ご紹介(?:が)?(?:出来|でき)ない/;
/** 同じ報告の中に今ご紹介出来るお部屋がある（一部募集中） */
const AVAILABLE_RE = /(?:現在|今)?募集中(?:と|で|の|です|となり)|空室(?:と|で|です|となり)|ご内覧(?:頂|いただ)ける|ご案内(?:可能|出来|でき)/;

/** こちらの文が「お部屋が募集に出ていない」報告だけか（今ご紹介出来るお部屋が同じ文に無い） */
export function unavailableReportOf(staffText: string | null | undefined): boolean {
  const t = N(staffText);
  if (!UNAVAILABLE_RE.test(t)) return false;
  return !AVAILABLE_RE.test(t);
}

/** 気に入って頂いた時の内覧・申込の誘いの1文（扉の文）。あればその文を返す */
const INVITE_RE = /(?:お気に召され|気に入られ|お気に入り(?:頂|いただ)け)[^。！!\n]{0,40}(?:ご?案内|ご?内覧|お?申込|お?申し込み|抑え|押さえ)|ご都合(?:よろしい|の良い|のよい)お日にち/;
export function inviteSentenceOf(text: string | null | undefined): string | null {
  const t = N(text);
  for (const s of t.split(/\n|(?<=[!！。])(?![!！])/)) if (INVITE_RE.test(s)) return s.trim();
  return null;
}
