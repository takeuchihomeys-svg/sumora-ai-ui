// app/lib/tsunagi-one-place.ts — つなぎ（内覧・申込の誘い）を決める所を1か所にする（純関数・DB/LLM なし）
//
// 2026-11-15 作業員H（竹内さん 11/15「つなぎの部分弱いところ強化」・統括役の決め「appeal-timing の判定1つを決める所にして、
//   CONDUCTOR_DECIDED の誘導先として渡し、書き手と NO_VIEWING の2つは読むだけ」）:
//   今は appeal-timing（APPEAL_TIMING・既定 on）が「誘う」、REPLY_DIRECTION_NO_VIEWING・PICKUP_DIRECTION_NO_VIEWING（既定 on）が
//   お客様の文の網（一旦見てみたい・気になります…）だけで「内覧の一文を足さない」を、別々に方向の文へ足していた（q428＝見張り 12496 の型）。
//   本番の見張りの竹内さんの番 7日 21番で一番多い外れ: 下書き＝次の連絡の約束・竹内さん＝内覧／申込の誘い（12496・12838・12578・12680）。
//   on の時: NO_VIEWING の2つは自分の網で決めず、appeal-timing の判定（meta.appeal_timing）を読む。
//     判定が「内覧を誘う（viewing・must/suggest）」か「申込を誘う」なら止めの一文は足さない／「誘わない（none）・避ける（avoid）」なら足す。
//     判定が無い番（APPEAL_TIMING=off・申込以降で作られない等）は今まで通り網で決める。
//   切替: TSUNAGI_ONE_PLACE=on（既定 off＝今と1文字も同じ）。テスト: app/lib/__tests__/tsunagi-one-place.test.ts
type Env = Record<string, string | undefined>;
export type AppealDecision = { kind: "apply" | "viewing" | "none"; level: "must" | "suggest" | "avoid"; reason?: string } | null | undefined;
export function tsunagiOnePlaceOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TSUNAGI_ONE_PLACE ?? "").trim().toLowerCase() === "on";
}
/**
 * 「内覧・申込の一文を足さない」を方向の文に足してよいか。
 *   fallback＝今までの網の答え（網に当たって内覧の言葉が無い＝true）。on で判定がある時は判定に従う。
 */
export function noViewingByDecision(fallback: boolean, appeal: AppealDecision, env?: Env): boolean {
  if (!tsunagiOnePlaceOn(env) || !appeal) return fallback;
  if (appeal.level === "avoid" || appeal.kind === "none") return fallback; // 誘わない判定＝網の答えのまま（足すなら足す）
  return false; // 誘う判定＝止めの一文は足さない（書き手は appeal-timing の誘いを読む）
}
