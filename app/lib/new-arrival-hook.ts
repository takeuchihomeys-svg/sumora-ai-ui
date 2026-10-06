// app/lib/new-arrival-hook.ts（純関数・DB/LLM なし）
// 新着1件の🌟（物件オススメで1件だけ送る新着）に、お客様が刺さったか。
//
// 2026-10-06 竹内「新着1件は別となる　これは条件近いのを送ってお客さんに連絡を入れるフックなので
//   新着1件でお客さんささっているのは、ちゃんと決めにいっている物件」:
//   ・新着1件の🌟は束から一番を選んだ物ではない（連絡のきっかけ）→ 🌟の並べ方の一致率の物差しから外す（scripts/audit-star-fit-d.ts の既定）
//   ・ただし新着1件にお客様が刺さった（その物件の内覧・見積書・申込・前向きな返事）物件は「決めに行っている物件」＝強い正の材料
//   正誤の決まり（feedback_property_selection_label: 正解はスタッフが選んで送った事実・反応で正誤を決めない）とは別の物:
//     ここで出すのは「フックが刺さった物件の特徴」を学ぶための印。刺さらなかった新着を「間違い」とは扱わない（no は no_signal であって負例ではない）
import { nameKey } from "./candidate-facts";

export type HookMessage = { sender: string; text: string | null; created_at: string; referenced_property_id?: unknown };
export type HookAix = { aix_type: string; generated_text: string | null; created_at: string };
export type NewArrivalHook = {
  /** 刺さった（内覧・見積書・申込のどれかがその物件で動いた／お客様がその物件に前向きに返した） */
  hooked: boolean;
  /** 刺さった印（viewing・estimate・apply・positive_reply・quoted） */
  signals: string[];
  /** お客様がその物件を断った（刺さらなかった印・負例ではない） */
  declined: boolean;
};

/** 前向きの言葉（新着1件への返事でスタッフが内覧・見積書へ進めた形）。実物: 「ここ内覧お願いいたします」「初期費用いくらですか？」「見積りお願いしたいです」 */
const POSITIVE_RE = /内覧|内見|見学|見に行|見積|初期費用|申込|申し込|空いて(?:ます|い)|気にな(?:ります|る|って)|いいですね|良いですね|良さそう|ここ(?:に|が|で|内覧)/;
/** 別の物件を送ってきた返事（ポータルの URL・画面の画像）は、この物件への反応ではない */
const OTHER_LISTING_RE = /https?:\/\/|【物件の画面|\[画像\]/;
/** 断り・懸念（刺さらなかった） */
const DECLINE_RE = /微妙|やめ|辞め|見送|合わな|ないです(?!か)|無しで|ナシ|古い|狭い|遠い|高い(?:です|かな|ので)|NG|いらな|不要|大丈夫です|結構です|厳しい|懸念|残念|😭|別で(?:物件)?見つか|一旦停止/;

const mentions = (text: string, name: string) => {
  const k = nameKey(name);
  return k.length >= 3 && nameKey(text).includes(k.slice(0, Math.min(k.length, 6)));
};

/**
 * 新着1件の🌟（物件名・送った時刻）→ 刺さったか。
 *   AIX（内覧調整・待ち合わせ・見積書・申込）は 14日以内でその物件の名前が出る物
 *   お客様の返事は 48時間以内: 物件名を言う／引用返信／（1件だけ送ったので）最初の返事が前向き。断りの言葉があれば刺さったに数えない
 */
export function newArrivalHookOf(input: { starName: string; sentAt: string; messages: ReadonlyArray<HookMessage>; aix: ReadonlyArray<HookAix>; replyHours?: number; aixDays?: number }): NewArrivalHook {
  const t = Date.parse(input.sentAt);
  const replyMs = (input.replyHours ?? 48) * 36e5, aixMs = (input.aixDays ?? 14) * 864e5;
  const signals: string[] = [];
  for (const a of input.aix) {
    const at = Date.parse(a.created_at);
    if (!(at > t && at <= t + aixMs) || !mentions(String(a.generated_text ?? ""), input.starName)) continue;
    if (/viewing_invite|meeting_place|viewing/.test(a.aix_type)) signals.push("viewing");
    else if (/estimate/.test(a.aix_type)) signals.push("estimate");
    else if (/application/.test(a.aix_type)) signals.push("apply");
  }
  const replies = input.messages.filter((m) => m.sender === "customer" && Date.parse(m.created_at) > t && Date.parse(m.created_at) <= t + replyMs)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  let declined = false;
  replies.forEach((m, i) => {
    const s = String(m.text ?? "");
    // その物件の話か: 名前を言う／引用返信／（1件だけ送ったので）最初の返事で、別の物件（URL・画面の画像）を送ってきた返事でない
    const named = mentions(s, input.starName) || !!m.referenced_property_id;
    if (!named && !(i === 0 && !OTHER_LISTING_RE.test(s))) return;
    if (DECLINE_RE.test(s)) { declined = true; return; }
    if (POSITIVE_RE.test(s)) signals.push(m.referenced_property_id ? "quoted" : "positive_reply");
  });
  const uniq = [...new Set(signals)];
  return { hooked: uniq.length > 0 && !(declined && uniq.every((x) => x === "positive_reply" || x === "quoted")), signals: uniq, declined };
}
