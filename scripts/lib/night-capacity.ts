// scripts/lib/night-capacity.ts — 1晩の空き枠と流れ残った組（純関数）（台帳 #803・統括役の決め: 組を増やすと晩10時間で終わらない晩が出る＝流れ残りも毎朝の1枚に）
// 2026-11-27 作業員L: 前の晩に流れた試験の組の費用と数から、1晩の上限（$10・竹内さんの決まり 1日 $5〜10）の内の空き枠（組の数）と、朝に列に残った試験の組（流れ残り）を出す
// 2026-11-27 作業員L（竹内さんの決め 11/27「入口の読みだけ OpenAI」）: 晩の上限には OpenAI の分も含めて数える（spentUsd は組の費用＝全部の相手の合計）。
//   openaiUsd はその内の OpenAI（見せるだけ・OpenAI の月の枠の中で回す）
export function nightCapacity(i: { spentUsd: number; jobs: number; leftover: number; capUsd?: number; openaiUsd?: number | null }): { avgUsd: number | null; freeUsd: number; freeJobs: number | null; leftover: number; line: string } {
  const cap = i.capUsd ?? 10;
  const avg = i.jobs ? Math.round((i.spentUsd / i.jobs) * 1000) / 1000 : null;
  const free = Math.max(0, Math.round((cap - i.spentUsd) * 100) / 100);
  const freeJobs = avg ? Math.floor(free / avg) : null;
  const line = `- 晩の空き枠: 前の晩 ${i.jobs}組 $${i.spentUsd.toFixed(2)}（1組 平均 ${avg != null ? `$${avg.toFixed(2)}` : "—"}${i.openaiUsd != null ? `・うち OpenAI $${i.openaiUsd.toFixed(2)}（入口の読み・上限に含めて数える）` : ""}）・上限 $${cap} の内の空き $${free.toFixed(2)}（約 ${freeJobs ?? "—"}組）・流れ残った組 ${i.leftover}${i.leftover ? "（⚠ 晩10時間で終わらなかった＝組を増やす前に流れ残りを見る）" : ""}`;
  return { avgUsd: avg, freeUsd: free, freeJobs, leftover: i.leftover, line };
}
/** 朝に列に残った試験の組（前の晩の22時より前に積まれた・試験の依頼だけ）（純関数） */
export function leftoverJobs(jobs: ReadonlyArray<{ runner?: string; createdAt?: string; readOnly?: boolean }>, nightStartMs: number): number {
  return jobs.filter((j) => (j.runner === "brain-exam" || (j.runner === "cmd" && !j.readOnly)) && j.createdAt && Date.parse(j.createdAt) < nightStartMs).length;
}
