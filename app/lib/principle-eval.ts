// principle-eval.ts — 学習 cron（update-knowledge）が毎日作る「この返信が優れている核心的な理由」の評価文を見分ける（純関数）
//
// 2026-10-14 区切り4 #9（入口の洗い出し）: update-knowledge は送った例1通ごとに principle を importance 9・題「原則：<場面>」で保存していた。
//   ブレインの【重要原則】（imp>=9 の上位10件）と返信の RAG（principle imp 8〜9）に毎日入り、30日で 159行（うち「〜している」で終わる評価文 110）。
//   中身は決まり（〜する・〜しない）ではなく1通への感想＝ブレイン・生成の材料にならず枠を食う。
// 見分け方: 題が「原則：」で始まる（cron の形）か、文が「〜している／〜ている／〜できている」で終わる評価の形。
// 戻す: PRINCIPLE_EVAL_FILTER=off（外さない）
export function principleEvalFilterEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.PRINCIPLE_EVAL_FILTER ?? "").toLowerCase() !== "off";
}

export function isEvaluativePrinciple(row: { title?: string | null; content?: string | null }): boolean {
  const title = String(row.title ?? "").trim();
  const content = String(row.content ?? "").trim().replace(/[。.！!\s]+$/u, "");
  if (/^原則[：:]/.test(title)) return true;
  return /(?:している|ている|ています|できている|出来ている|優れている|伝わる|与えている)$/.test(content);
}
