// app/lib/screening-signal-brain-first.ts — 審査の通りやすさの問いで、場面 S3 の信号がブレインの「なし」を管理会社の確認で埋めない（純関数）
//
// 2026-11-18 作業員H（統括役の決め・P0 9eb6aa9c「判断はすべてブレイン基準」・feedback_remove_non_brain_criteria）:
//   q333「ここって私、審査的には通りそうですかね」（正解 AIX:guarantor_info）で、2段の書き換えを止めても（TWO_STAGE_SCREENING_NO_REWRITE=on）
//   4回中2回は場面 S3 の信号（reasonCode=screening_question → 物件確認した/保証会社）がブレインの「AIX なし」を埋めて外れた（h1118-scrnr-q333）。
//   決まった網が道を決めるのでなく、網は材料（場面の証拠はプロンプトに既にある）にしてブレインが決める形にする。
//   on の時: 審査の通りやすさの問い（screening_question）で、ブレインがはっきり「AIX なし」と言った番だけ、場面 S3 の信号で AIX を埋めない。
//     保証会社そのものの問い（guarantor_question → AIX【保証会社】）・管理会社・ライフライン・代理契約・二人入居の問いは今まで通り（竹内さんの決定の S3）。
//   2段の書き換えの止め（TWO_STAGE_SCREENING_NO_REWRITE）と一緒に試す（片方だけだともう片方が出てくる）。
//   切替: SCREENING_SIGNAL_BRAIN_FIRST=on（既定 off）。テスト: app/lib/__tests__/screening-signal-brain-first.test.ts
type Env = Record<string, string | undefined>;
export function screeningSignalBrainFirstOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SCREENING_SIGNAL_BRAIN_FIRST ?? "").trim().toLowerCase() === "on";
}
/** 場面の信号を使わない番か（true＝信号で埋めない＝ブレインの「なし」のまま） */
export function screeningSignalSkipped(o: { reasonCode: string | null | undefined; brainSaidNoAix: boolean }, env?: Env): boolean {
  if (!screeningSignalBrainFirstOn(env)) return false;
  return o.brainSaidNoAix && o.reasonCode === "screening_question";
}
