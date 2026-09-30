// app/lib/second-message-style.ts
// AIX の直後に送る2通目（AIX テンプレート）の「言い回し」の検査と、文の形の数え方（純関数・DB 依存なし）。
//
// 2026-09-30 竹内（YUMA に届いた2通目を見て）:
//   「言い回しが AI くさいから原因見つけて改善する。実際使っている言い回しが出るように改善する。
//    208号室など号室だけのところいれへんし、強みですなどの言い回しもいれていない」
//
// 実物（YUMA・9/30・4通）:
//   「…玉川駅徒歩4分で築浅の2023年築というのは、かなり珍しい好条件です！！／独立洗面台・浴室乾燥機・インターネット無料と、
//     毎日の暮らしで助かる設備が揃っているのも、この208号室ならではの強みです😊！！」
//   「レオパレス天満107号室は家具付きで、お引越しの負担を抑えて始められる点が特に魅力です！！／…お値打ちな条件のお部屋となります😊！！」
//   「…お送りした中でも特に使いやすいお部屋かと思います😊！！」
//   「…かなり使いやすい立地です😊！！／…普段の暮らしで助かる設備が揃っているのもオススメできるポイントです！！」
//
// 線の引き方（scripts/audit-second-message-phrasing.ts・365日・YUMA と申込以降を除く）は下の各行のコメントに数を書く。
// exit=true の語だけが出口（作り直し1回）に使われる。exit=false は数えるだけ（実送信にあるので止めない）。

export type AiPhraseRule = { key: string; re: RegExp; exit: boolean };

/**
 * AI だけが書いて、スタッフが書かない言い回し。
 * ⚠ exit=true にしてよいのは、実送信の2通目で0通・スタッフの文全体でもごく少数の物だけ（誤削除0）。
 */
export const AI_PHRASE_RULES: AiPhraseRule[] = [
  { key: "強みです", re: /強み(?:です|となり|で(?:す|ござい))/, exit: true },
  { key: "ならでは", re: /ならでは/, exit: true },
  { key: "揃っているのも", re: /(?:揃|そろ)って(?:いる|おり|い)(?:の|点)[もが]/, exit: true },
  { key: "助かる設備", re: /(?:暮らし|生活)で助かる|助かる設備/, exit: true },
  { key: "珍しい", re: /珍し[いく]|なかなか(?:出て|で)(?:こない|きません)/, exit: true },
  { key: "好条件です", re: /好条件です/, exit: true },
  { key: "お値打ち", re: /お値打ち/, exit: true },
  { key: "魅力です", re: /魅力(?:です|となり|の(?:一つ|ひとつ))/, exit: true },
  { key: "ポイントです", re: /(?:オススメ|おすすめ)(?:でき|出来)る(?:ポイント|点)です|ポイントです/, exit: true },
  { key: "かと思います", re: /かと思います/, exit: true },
  { key: "使いやすい立地", re: /使いやすい(?:立地|お部屋かと)/, exit: true },
  // 「アクセスも良く」は実送信の2通目に1通ある → 出口にしない（数えるだけ）
  { key: "アクセスが良く", re: /アクセス(?:が|も)?(?:良|よ)[くい]/, exit: false },
  { key: "気になる点があれば", re: /気になる点[^\n]{0,12}(?:あれば|ありましたら|ございましたら)/, exit: true },
  // 監査で止めた: 「充実した設備が揃っており、◯◯さんにかなりオススメ…」が実送信の2通目に2通ある → 出口にしない（数えるだけ）
  { key: "設備が揃って", re: /設備[がも](?:揃|そろ)って(?:おり|い)/, exit: false },
  { key: "個人的にも注目", re: /注目して(?:おり|い)ます|一番オススメしたい/, exit: true },
  { key: "負担を抑えて始め", re: /負担を抑えて|始められる点/, exit: true },
  { key: "というのは", re: /というのは、/, exit: true },
];

export type AiPhraseHit = { key: string; match: string };

/** 号室だけで物件を呼ぶ形（「この208号室」「208号室ならでは」「208号室は」）。建物名に続く号室は当たらない */
export function roomOnlyMentions(text: string | null | undefined): string[] {
  const out: string[] = [];
  const t = String(text ?? "");
  // 指示語＋号室（「この208号室」「こちらの208号室」）
  for (const m of t.matchAll(/(?:この|こちらの|その)[\s　]*([0-9０-９]{2,4})[\s　]*号室/g)) out.push(m[0]);
  // 行頭・句読点の直後にいきなり号室（「、208号室は」「208号室が」）
  for (const m of t.matchAll(/(?:^|[\n、。！!？?])[\s　]*([0-9０-９]{2,4})[\s　]*号室(?=[はがもの])/g)) out.push(m[0].replace(/^[\n、。！!？?\s　]+/, ""));
  return [...new Set(out)];
}

/** 出口の検査: AI の言い回し（exit=true の語）と号室だけの呼び方。無ければ空 */
export function findAiPhrases(text: string | null | undefined): AiPhraseHit[] {
  const t = String(text ?? "");
  const hits: AiPhraseHit[] = [];
  for (const r of AI_PHRASE_RULES) {
    if (!r.exit) continue;
    const m = t.match(r.re);
    if (m) hits.push({ key: r.key, match: m[0] });
  }
  for (const r of roomOnlyMentions(t)) hits.push({ key: "号室だけで呼ぶ", match: r });
  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// 場面（監査と入口が同じ物を見る）
// ─────────────────────────────────────────────────────────────────────────────
export type SecondScene = "compare" | "new_listing" | "single" | "after_pickup";

const COMPARE_RE = /(?:お送り|ご紹介|送らせて|ピックアップ)[^。！\n]{0,24}(?:中でも|中から|中で)|中でも特に/;
const NEW_RE = /新着|募集に(?:出|で)ました|募集(?:が)?(?:出|で)ました/;
const SINGLE_PUSH_RE = /(?:特に|かなり)[^\n。！!]{0,24}(?:オススメ|おすすめ)|(?:オススメ|おすすめ)(?:出来|でき)る(?:お部屋|物件)/;

/** 実送信の2通目の場面（監査用）。文の言い方と1通目の AIX の種類・ピッカーから決める */
export function sceneOfSecond(i: { second: string; first?: string | null; aix?: string | null; newPicker?: boolean }): SecondScene {
  const both = `${i.first ?? ""}\n${i.second}`;
  if (COMPARE_RE.test(i.second)) return "compare";
  if (i.newPicker || NEW_RE.test(both)) return "new_listing";
  if (i.aix === "property_send" && !SINGLE_PUSH_RE.test(i.second)) return "after_pickup";
  if (i.aix === "property_send") return "compare";
  return "single";
}

// ─────────────────────────────────────────────────────────────────────────────
// 文の形を数える
// ─────────────────────────────────────────────────────────────────────────────
const EMOJI_RE = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu;

export type StyleStats = {
  len: number; lines: number; paragraphs: number; sentences: number; sentenceLens: number[];
  emoji: number; emojis: string[]; emojiBeforeBang: number; lastHasEmoji: boolean;
  bangEnd: number; maruEnd: number;
  nameRoom: boolean; kochira: boolean; addressesName: boolean;
  nakaguroList: boolean; bullets: number; joins: number;
};

/** 文に切る（「！！」「。」「？」と改行で切る。絵文字・記号だけの切れ端は前の文に付ける） */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text ?? "").split("\n")) {
    const l = line.trim();
    if (!l) continue;
    const parts = l.match(/[^。！!？?]+[。！!？?]*/g) ?? [l];
    for (const p of parts) {
      const s = p.trim();
      if (!s) continue;
      if (out.length && !/[ぁ-んァ-ヶ一-龥A-Za-z0-9]/.test(s)) out[out.length - 1] += s; else out.push(s);
    }
  }
  return out;
}

export function styleStatsOf(text: string): StyleStats {
  const t = String(text ?? "");
  const sents = splitSentences(t);
  const emojis = [...t.matchAll(EMOJI_RE)].map((m) => m[0]).filter((e) => e !== "🌟" || true);
  const last = sents[sents.length - 1] ?? "";
  return {
    len: t.length,
    lines: t.split("\n").filter((x) => x.trim()).length,
    paragraphs: t.split(/\n\s*\n/).filter((x) => x.trim()).length,
    sentences: sents.length,
    sentenceLens: sents.map((s) => s.length),
    emoji: emojis.length,
    emojis,
    emojiBeforeBang: (t.match(/\p{Extended_Pictographic}️?[！!]/gu) ?? []).length,
    lastHasEmoji: EMOJI_RE.test(last) ? (EMOJI_RE.lastIndex = 0, true) : false,
    bangEnd: sents.filter((s) => /[！!]+$/.test(s)).length,
    maruEnd: sents.filter((s) => /。$/.test(s)).length,
    nameRoom: /[^\s、。！!\n0-9０-９]{2,}[\s　]*[0-9０-９]{2,4}[\s　]*号室/.test(t) && roomOnlyMentions(t).length === 0,
    kochira: /こちらのお部屋|こちらの物件/.test(t),
    addressesName: /さん/.test(t),
    nakaguroList: /[^\n・、。]{2,14}・[^\n・、。]{2,14}・[^\n・、。]{2,14}/.test(t.split("\n").filter((l) => !/^\s*[・･]/.test(l)).join("\n")),
    bullets: (t.match(/^\s*[・･]/gm) ?? []).length,
    joins: (t.match(/(?:で|となり|ており|ですので|の為|ため)、/g) ?? []).length,
  };
}

/**
 * 出口: 絵文字が1つも無い2通目に、最後の「！！」の直前へ 😊 を1つ入れる（足すだけ・消さない）。
 * 実送信の2通目 477組で絵文字なしは 11.3%・絵文字の位置は文の最後の「！！」の直前が 86.3%・最多は 😊。
 * 最後が「！！」で終わらない文（URL・箇条書き等）は触らない。
 */
export function ensureOneEmoji(text: string): { text: string; added: boolean } {
  const t = String(text ?? "");
  EMOJI_RE.lastIndex = 0;
  if (!t.trim() || EMOJI_RE.test(t)) { EMOJI_RE.lastIndex = 0; return { text: t, added: false }; }
  EMOJI_RE.lastIndex = 0;
  const m = t.match(/^([\s\S]*?)(！！)(\s*)$/);
  if (!m) return { text: t, added: false };
  return { text: `${m[1]}😊${m[2]}${m[3]}`, added: true };
}

/**
 * 出口: 「◯◯さんかなりオススメ出来る」→「◯◯さんにかなりオススメ出来る」（助詞の「に」が抜けた形）。
 * 実送信（スタッフの文 13,152通）: 「さんにかなりオススメ」814通 ／「さんかなりオススメ」3通（打ち間違い）。足すだけで意味は変わらない。
 */
export function fixMissingNi(text: string): { text: string; fixed: number } {
  let fixed = 0;
  const out = String(text ?? "").replace(/さん(?=かなりオススメ(?:出来|でき)る)/g, () => { fixed++; return "さんに"; });
  return { text: out, fixed };
}
