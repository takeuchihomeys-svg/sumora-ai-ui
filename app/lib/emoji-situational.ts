// app/lib/emoji-situational.ts
// 返信の下書きの絵文字を場面で使い分ける（スタッフが絵文字を付けない場面では付けない・付けない割合もスタッフに合わせる）出口（純関数・DB も fetch も持たない）。
//
// 2026-10-02 竹内さん（YUMA の LINE が全部の通に絵文字）「状況に応じて絵文字なしで大丈夫やから、絵文字使わない場面では使わないとか、
//   時折あえて絵文字をなしにする」→（同日・一律20%の案に）「スタッフのを基に構成する」。
// 決まり:
//   ① 下書きを場面に分ける（emojiSceneOf・上から順に最初に当たった場面＝重ならない）
//   ② 場面ごとに「スタッフの手打ちで絵文字なしの割合」（EMOJI_SCENE_RATES・scripts/audit-emoji-scene-rates.ts で測った値）だけ外す。
//      どの下書きを外すかは会話 id＋本文のハッシュで決める（乱数でない＝同じ下書きは同じ結果・数が多ければ割合がスタッフに一致する）
//   ③ スタッフがほぼ必ず外す場面（ALWAYS_AT 以上）は必ず外す・ほぼ必ず付ける場面（NEVER_AT 以下）は外さない
//   🌟（物件の見出し）・✅（見積の定型）は場面に関係なく残す。絵文字の種類と重ねない決まりは emoji-allowlist.ts／emoji-repeat.ts
//   AIX には当てない（スタッフの AIX の送信は 84% が絵文字あり＝AI の割合と離れていない）

export type EmojiScene =
  | "first_greeting" | "apology" | "ended" | "decline" | "second_message" | "short" | "question"
  | "confirm_decl" | "closing" | "money" | "contract" | "phone" | "mid" | "long";

/**
 * 場面ごとのスタッフの「絵文字なし」の割合（2026-10-02 測定・scripts/audit-emoji-scene-rates.ts）。
 *   母集団: ai_reply_examples の line_reply で AI の下書きを使っていない手打ち（6/15〜・2,828通）を emojiSceneOf で分けた物。
 *   second_message だけは messages（6/15〜）の「こちらの手打ちの10分以内に続けた手打ち」（下書きの手本には連投の位置が無いため）
 *   aiRate＝同じ場面の AI の下書きが元から絵文字なしの割合。外す確率は (rate − aiRate)／(1 − aiRate)＝出口の後の割合がスタッフの rate にそろう
 *   （2通目の aiRate は測れない＝下書きは1通目だけ・全体の AI の値 0.10 を置いた）
 */
export const EMOJI_SCENE_RATES: Readonly<Record<EmojiScene, { rate: number; n: number; aiRate: number; ja: string }>> = {
  first_greeting: { rate: 0.01, n: 81, aiRate: 0.01, ja: "初回の挨拶" },
  apology: { rate: 0.8, n: 10, aiRate: 0.5, ja: "謝罪" },
  ended: { rate: 0.66, n: 65, aiRate: 0.17, ja: "募集終了の知らせ" },
  decline: { rate: 0.48, n: 124, aiRate: 0.05, ja: "断り・難しい知らせ" },
  second_message: { rate: 0.33, n: 950, aiRate: 0.1, ja: "続けて送る2通目" },
  short: { rate: 0.51, n: 70, aiRate: 0, ja: "短い一言（25字未満）" },
  question: { rate: 0.32, n: 232, aiRate: 0.08, ja: "質問を含む" },
  confirm_decl: { rate: 0.33, n: 174, aiRate: 0.11, ja: "確認の宣言" },
  closing: { rate: 0.16, n: 32, aiRate: 0.05, ja: "締めの一言" },
  money: { rate: 0.21, n: 555, aiRate: 0.03, ja: "金額・支払い" },
  contract: { rate: 0.36, n: 253, aiRate: 0.01, ja: "審査・契約・書類" },
  phone: { rate: 0.4, n: 43, aiRate: 0, ja: "電話" },
  mid: { rate: 0.37, n: 445, aiRate: 0.31, ja: "中くらい（25〜60字）" },
  long: { rate: 0.24, n: 712, aiRate: 0.11, ja: "長い文（60字以上）" },
};
/** これ以上は必ず外す・これ以下は外さない */
export const ALWAYS_AT = 0.9;
export const NEVER_AT = 0.05;

export type EmojiSituation = { text: string; removed: number; reason: string | null; scene: EmojiScene | null };

/** 外してよい顔の絵文字（🌟・✅ は残す） */
const FACE_EMOJI_RE = /[😊😌✨]️?/gu;
const HAS_FACE_RE = /[😊😌✨]/u;

const APOLOGY_RE = /申し訳(?:ございません|御座いません|ありません|ない)|大変失礼|お詫び/;
const ENDED_RE = /募集(?:が)?終了|満室|申込(?:み)?(?:が)?入って(?:しまい|おり)|募集に出ていない|募集を?停止/;
const DECLINE_RE = /否決|審査(?:が)?(?:通ら|落ち|厳し)|難しい|厳しい|出来かね|できかね|ご期待に沿え|出来ない|できない|出来ません|できません|致しかね/;
const QUESTION_RE = /[？?]|でしょうか|ますか[！!。]?/;
const CONFIRM_RE = /確認させて(?:頂|いただ)きます|確認出来次第|確認でき次第/;
const CLOSING_RE = /何卒よろしくお願い|よろしくお願い(?:致|いた)します|お気軽にご連絡ください/;
const MONEY_RE = /[0-9０-９,，]+円|万円|手数料|お支払|振込|クレジット|初期費用/;
const CONTRACT_RE = /審査|保証会社|契約|書類|本人確認/;
const PHONE_RE = /お電話/;

/** 顔の絵文字と空白を除いた長さ */
function bodyLen(t: string): number {
  return t.replace(/\s/g, "").replace(FACE_EMOJI_RE, "").length;
}

/**
 * 下書きの場面（上から順に最初に当たった物）。
 *   firstContact   … はじめての返信（挨拶を付ける番）
 *   afterStaffSend … こちらが直前（10分以内）に送った後に続けて送る通（2通目）
 */
export function emojiSceneOf(text: string, o: { firstContact?: boolean; afterStaffSend?: boolean } = {}): EmojiScene {
  const t = String(text ?? "");
  const len = bodyLen(t);
  if (o.firstContact || /はじめまして/.test(t)) return "first_greeting";
  if (APOLOGY_RE.test(t)) return "apology";
  if (ENDED_RE.test(t)) return "ended";
  if (DECLINE_RE.test(t)) return "decline";
  if (o.afterStaffSend) return "second_message";
  if (len < 25) return "short";
  if (QUESTION_RE.test(t)) return "question";
  if (CONFIRM_RE.test(t)) return "confirm_decl";
  if (CLOSING_RE.test(t) && len < 40) return "closing";
  if (MONEY_RE.test(t)) return "money";
  if (CONTRACT_RE.test(t)) return "contract";
  if (PHONE_RE.test(t)) return "phone";
  return len < 60 ? "mid" : "long";
}

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return ((h >>> 0) % 100000) / 100000;
}

/** 場面と、外すかどうか（理由つき） */
export function emojiSituationOf(text: string, o: { seed?: string | null; firstContact?: boolean; afterStaffSend?: boolean } = {}): { drop: boolean; reason: string | null; scene: EmojiScene | null } {
  const t = String(text ?? "");
  if (!HAS_FACE_RE.test(t)) return { drop: false, reason: null, scene: null };
  const scene = emojiSceneOf(t, o);
  const r = EMOJI_SCENE_RATES[scene];
  const pct = `${Math.round(r.rate * 100)}%`;
  if (r.rate >= ALWAYS_AT) return { drop: true, reason: `${r.ja}（スタッフの ${pct} が絵文字なし＝必ず外す）`, scene };
  if (r.rate <= NEVER_AT) return { drop: false, reason: null, scene };
  // 外す確率: AI が元から絵文字なしの分を差し引く（出口の後の割合がスタッフの割合にそろう）
  const p = Math.max(0, Math.min(1, (r.rate - r.aiRate) / Math.max(0.01, 1 - r.aiRate)));
  const key = `${o.seed ?? ""}\n${t.replace(FACE_EMOJI_RE, "")}`;
  if (hash01(key) < p) return { drop: true, reason: `${r.ja}（スタッフの ${pct} が絵文字なし）`, scene };
  return { drop: false, reason: null, scene };
}

/** 場面で絵文字を外す（外さない時は本文そのまま） */
export function applySituationalEmoji(text: string | null | undefined, o: { seed?: string | null; firstContact?: boolean; afterStaffSend?: boolean } = {}): EmojiSituation {
  const t = String(text ?? "");
  const d = emojiSituationOf(t, o);
  if (!d.drop) return { text: t, removed: 0, reason: null, scene: d.scene };
  let removed = 0;
  const out = t.replace(FACE_EMOJI_RE, () => { removed++; return ""; }).replace(/[ 　]+$/gm, "");
  return { text: out, removed, reason: d.reason, scene: d.scene };
}
