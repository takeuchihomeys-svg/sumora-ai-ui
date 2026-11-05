// app/lib/turn-elapsed.ts — 今の番のお客様の通からの経過時間と、その間にこちらの確かめ（物件確認・見積の AIX の準備）が済んだか（純関数）
//
// 2026-11-05 竹内さんの指摘（KB P1「返信を押すのが遅れて、そのまま AIX で送っている番もある・その転機を付けたら精度が上がる」）・作業員1:
//   実測（KB P2・竹内さん本人の番 856・90日）: お客様の通から最初の送信までの遅れごとの「結果の AIX（確認・見積）」の割合（約束の返信＋結果の AIX の中）は
//     0〜60分 4〜16%・60分〜 25〜38%。60分の前後で分かれる（60分を過ぎても約束の返信が多い＝「遅れたら AIX」ではない）。
//   使い方（既定 off・入れる TURN_ELAPSED_TWO_CHOICE=on）:
//     ① ブレインの材料に「今の番から N分・その間に確かめの AIX の準備が【有る／無い】」の1行（判断はブレイン・KB P0 575a7cd5 の重点の材料）
//     ② 確認・見積の2択（約束か、その場の AIX か）の先に選んだ側を、60分を過ぎて確かめの準備が有れば AIX、それ以外は約束の返信にする
//        （2択を作る所の直前＝後の役が前を書き換えない・KB 0dbfbc97）
export const ELAPSED_TURN_MIN = 60;
export function turnElapsedOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TURN_ELAPSED_TWO_CHOICE ?? "").trim().toLowerCase() === "on";
}
const CHECK_AIX = new Set(["property_check_result", "acknowledge_check", "estimate_sheet"]);

export type TurnElapsed = { minutes: number; overLine: boolean; prepared: boolean };
/** turnAt＝今の番のお客様の最初の通。aixRows＝この会話の AIX の記録（押した＝created_at） */
export function turnElapsed(turnAtIso: string | null | undefined, nowMs: number, aixRows: ReadonlyArray<{ aix_type: string; created_at?: string | null }>): TurnElapsed | null {
  const t = Date.parse(String(turnAtIso ?? ""));
  if (!Number.isFinite(t) || nowMs < t) return null;
  const minutes = Math.round((nowMs - t) / 60_000);
  const prepared = aixRows.some((r) => CHECK_AIX.has(r.aix_type) && Date.parse(String(r.created_at ?? "")) >= t);
  return { minutes, overLine: minutes >= ELAPSED_TURN_MIN, prepared };
}
/** ブレインの材料の1行（答えは書かない） */
export function turnElapsedLine(e: TurnElapsed): string {
  const h = e.minutes >= 120 ? `約${Math.floor(e.minutes / 60)}時間` : `${e.minutes}分`;
  return `【今の番からの経過】お客様の今の通から ${h}（${e.overLine ? "60分を過ぎている" : "60分より前"}）。その間にこちらが確認・見積の AIX の準備を${e.prepared ? "始めている（確かめが済んだ可能性が高い）" : "していない（まだ確かめていない）"}。`
    + "竹内さんは60分より前は確認・見積を約束の返信で受けることが多く、60分を過ぎて確かめが済んでいれば結果の AIX で送ることが増える（決めるのはこの番の重点）。";
}
/** 確認・見積の2択の先に選んだ側 */
export function elapsedPreferredSide(e: TurnElapsed | null): "reply" | "aix" {
  return e && e.overLine && e.prepared ? "aix" : "reply";
}
