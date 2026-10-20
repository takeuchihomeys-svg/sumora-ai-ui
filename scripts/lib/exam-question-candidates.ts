// scripts/lib/exam-question-candidates.ts — 本番の外れから試験の問題の「候補」を作る決め方（純関数・LLM も DB もファイルも触らない）
//
// 2026-10-20 竹内さん（試験のブレインを最優先で改善する・QUALITY⑦）: 本番の外れ（見張り line_watch_turns の道の外れ・
//   大きく直された番 edited-turn-miner・下書きと実送信の直しの型 draft-diff-types＝まだ main に無い）を、試験の問題の候補にする。
//   候補だけ（spec.json に自動で足さない）。人が読んで brain-exam-add.ts --add-batch で足す。個人情報の網を通らない候補は出さない。
//   入口 scripts/exam-question-candidates.ts。単体テスト scripts/lib/__tests__/exam-brain-like-line.test.ts
export type QSource = "見張り" | "直された番" | "直しの型";
export type QCand = {
  source: QSource; conv: string; at: string; type: string; tags: string[]; accept: string[]; mustNot: string[];
  customer: string; staff: string; writer: string; why: string;
  /** 人が決める事（正解の道・依頼の要点 等）。空なら正解の道は台帳と押下で決まっている */
  needs: string[];
  asks?: Array<{ q: string; route: string; point: string }>; ng?: string[]; stage?: "brain" | "draft";
};
/** 個人情報の網: 伏せた後の文に個人の値・申込の書類の印が残る候補は出さない（理由を返す・null＝通る） */
export function piiGate(texts: string[], checks: { piiValueSignal: (t: string) => string | null; applicationMaterialReason: (t: string) => string | null }): string | null {
  for (const t of texts) {
    if (!t) continue;
    const a = checks.applicationMaterialReason(t); if (a) return `申込の書類（${a}）`;
    const v = checks.piiValueSignal(t); if (v) return `個人の値（${v}）`;
  }
  return null;
}
/** もう試験に入っている（同じ会話の window 以内）・候補どうしの重なり（同じ会話の window 以内は新しい方を残す）を外す */
export function dedupeCandidates(cs: QCand[], spec: Array<{ conv?: string; at?: string }>, windowMs = 6 * 3600_000): { keep: QCand[]; dropped: Array<{ conv: string; at: string; why: string }> } {
  const t = (s: string | undefined) => Date.parse(String(s ?? ""));
  const keep: QCand[] = [], dropped: Array<{ conv: string; at: string; why: string }> = [];
  const sorted = [...cs].sort((a, b) => t(b.at) - t(a.at));
  for (const c of sorted) {
    if (spec.some((s) => s.conv === c.conv && Math.abs(t(s.at) - t(c.at)) < windowMs)) { dropped.push({ conv: c.conv, at: c.at, why: "もう試験に入っている" }); continue; }
    const dup = keep.find((k) => k.conv === c.conv && Math.abs(t(k.at) - t(c.at)) < windowMs);
    if (dup) { if (!dup.tags.includes(`も:${c.source}`)) dup.tags.push(`も:${c.source}`); dropped.push({ conv: c.conv, at: c.at, why: `同じ番（${dup.source} の候補と重なる）` }); continue; }
    keep.push({ ...c, tags: [...c.tags] });
  }
  return { keep, dropped };
}
/**
 * 並べ方（点の大きい順）: 竹内さんの番 +2／正解の道が台帳と押下で決まる（人が決める事が無い）+1／試験に少ない型（その型の問題が少ないほど +1 まで）／
 *   2つの源で拾った +0.5／新しい（日が近い）+0.5 まで。理由も返す
 */
export function rankCandidates(cs: QCand[], o: { typeCount: Record<string, number>; now?: number }): Array<QCand & { score: number; rankWhy: string[] }> {
  const now = o.now ?? Date.now();
  return cs.map((c) => {
    const why: string[] = []; let s = 0;
    if (c.writer === "takeuchi") { s += 2; why.push("竹内さんの番"); }
    if (!c.needs.length && c.accept.length) { s += 1; why.push("正解の道が決まっている"); }
    const n = o.typeCount[c.type] ?? 0; const rare = 1 / (1 + n / 5); s += rare; if (n < 5) why.push(`試験に少ない型（${n}問）`);
    if (c.tags.some((t) => t.startsWith("も:"))) { s += 0.5; why.push("2つの源で拾った"); }
    const days = (now - Date.parse(c.at)) / 86_400_000; if (Number.isFinite(days)) s += Math.max(0, 0.5 - days * 0.1);
    return { ...c, score: Math.round(s * 100) / 100, rankWhy: why };
  }).sort((a, b) => b.score - a.score || Date.parse(b.at) - Date.parse(a.at));
}
/** brain-exam-add.ts --add-batch に渡せる形（人が読んで直してから足す。needs が残る候補は正解の道が空＝そのままでは足せない） */
export function toAddBatch(c: QCand): Record<string, unknown> {
  return { conv: c.conv, at: c.at, type: c.type, tags: c.tags.filter((t) => !t.startsWith("も:")), accept: c.accept, mustNot: c.mustNot, ...(c.asks ? { asks: c.asks } : {}), ...(c.ng ? { ng: c.ng } : {}), ...(c.stage ? { stage: c.stage } : {}),
    source: `本番の外れの候補（${c.source}）`, why: c.why, addedBy: "exam-question-candidates（人が確かめて足す）" };
}
