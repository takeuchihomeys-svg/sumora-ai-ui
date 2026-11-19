// app/lib/look-hesitation.ts — 「一旦見てみたい・気になります」等の感想の番で、内覧の誘いを止める線を「迷い・引っかかりがある時だけ」に狭める（純関数・DB/LLM なし）
//
// 2026-11-15 作業員H（統括役の頼み③「入れた物で下がった可能性がある型」・見張り 12496＝試験 q428）:
//   REPLY_DIRECTION_NO_VIEWING（返信の方向）と PICKUP_DIRECTION_NO_VIEWING（2段の方向）は、q174（「一旦見てみたい！場所が少し遠い気もしてて、他にも候補」）を直すために
//   「気になります・いいですね・良さそう」まで同じ網で「内覧の一文を足さない・竹内さんはピックアップの約束だけ」と方向の文に足していた。
//   q428（「他はないですか」「気になります」）は竹内さん「周辺ですと現在こちらのお部屋のみ・お気に召されましたらご案内・並行して新着」＝誘っている。
//   線（竹内さん本人の 75日・その網に当たるお客様の通の次の竹内さんの通 30番・読むだけ・11/15）:
//     迷い・引っかかりの語（遠い・気もして・微妙・ちょっと・少し）が無い 25番 = 内覧の誘い 11（返信 5・AIX 6）・ピックアップ 5・どちらも無し 10
//     迷いの語がある 5番 = 内覧の誘い 0・ピックアップ 1・どちらも無し 4
//   → 「足さない」は迷いの語がある時だけ誤り0（0/5）。迷いが無い番で止めると竹内さんの誘い 11/25 を消す。迷いが無い番でも誘いは過半数ではない＝誘いを必須にはしない（止めの一文を外すだけ）。
//   切替: NO_VIEWING_HESITATION_ONLY=on の時だけ（既定 off＝今まで通り網に当たれば足す）。
// テスト: app/lib/__tests__/look-hesitation.test.ts
type Env = Record<string, string | undefined>;
export function noViewingHesitationOnlyOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.NO_VIEWING_HESITATION_ONLY ?? "").trim().toLowerCase() === "on";
}
/** 物件への感想に、迷い・引っかかり（遠い・気もして・微妙・ちょっと・少し）が混ざっているか */
export const HESITATION_RE = /遠い|気もして|微妙|ちょっと|少し/;
/** 「内覧の一文を足さない」を方向の文に足してよいか（網 LOOK に当たった後に呼ぶ）。スイッチ off は常に true＝今まで通り */
export function noViewingNoteAllowed(customerText: string, env?: Env): boolean {
  if (!noViewingHesitationOnlyOn(env)) return true;
  return HESITATION_RE.test(String(customerText ?? ""));
}
