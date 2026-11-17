// app/lib/estimate-sent-flag.ts — AIX の記録（aix_usage_logs.estimate_sent）の「御見積書を送った」の印を決める（純関数・DB/LLM なし）
//
// 2026-11-18 作業員L（統括役「記録の側の連携の切れを直す」）: 今は画面から来た estimate_sent=true の時だけ立つ（物件確認した に同封した時）。
//   見積書そのものの AIX（estimate_sheet）は 30日 37回で 1回も立たず、ブレインの【御見積書 送付済み】（aix_usage_logs.estimate_sent を読む）が出なかった。
//   AIX_ESTIMATE_SHEET_FLAG=on（既定 off）: estimate_sheet の時も立てる。同封の印（他の AIX）はそのまま。
type Env = Record<string, string | undefined>;
export const estimateSheetFlagOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.AIX_ESTIMATE_SHEET_FLAG ?? "").trim().toLowerCase() === "on";
export function estimateSentFlagOf(aixType: string | null | undefined, estimateSent: boolean | null | undefined, env?: Env): boolean {
  if (estimateSent === true) return true;
  return estimateSheetFlagOn(env) && aixType === "estimate_sheet";
}
