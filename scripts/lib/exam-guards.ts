// scripts/lib/exam-guards.ts — 試験の依頼に「守りの問題」を自動で足す（純関数・LLM も DB も使わない）
//
// 2026-11-07 統括役の決め（竹内さん「使い回して必要な試験を RAG で行うようになっていないのか」・弱い所 418）:
//   11月の brain-exam の依頼 168本は全部 --only の手選びで、守りの問題は人任せだった。係が積む時に、狙いの問題に近い問題（試験の問題の札の
//   埋め込み＝exam-rag の cards）から守りを2問足す。使い回せる問題（夜の基準に前の答えがある・揺れの記録で安定・入力が同じで録音を再生できる）を
//   最優先し、それが無い時だけ前を作る問題を選ぶ。守りは1回。上限に入らない時は1問・0問に減らす（依頼の上限は変えない）。
//   狙いの無い依頼は brain-exam --select=rag（8問・exam-rag-run・差分の言葉と知見）に任せる（係では選ばない）。
export type GuardCard = { id: string; stage: "brain" | "draft"; embedding?: number[] | null };
export type GuardPick = { id: string; sim: number; reusable: boolean; stable: boolean; why: string };

const cos = (a: number[], b: number[]): number => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};

/**
 * 守りの候補（純関数）: 狙いの問題のどれかに近い順（一番近い狙いとの近さ）。
 *   使い回せる（夜の基準にある）＞ 安定 ＞ 近さ の順に並べ、上から max 問。下書きの段の依頼は下書きの札の問題だけ（exam-scope の見方）
 */
export function chooseGuards(input: {
  targets: ReadonlyArray<string>; cards: ReadonlyArray<GuardCard>; nightlyIds: ReadonlySet<string>; stableIds: ReadonlySet<string>;
  max?: number; stage?: "brain" | "draft" | null; minSim?: number; pool?: number;
  /** 2026-11-10 作業員8b（試験の統括②）: 重点の場面の問題（exam-focus の focusPool）。あれば守りはこの中から（狙いとの近さは並べる時の後ろの決め手だけ） */
  focusIds?: ReadonlySet<string>;
}): GuardPick[] {
  const max = input.max ?? 2, minSim = input.minSim ?? 0.3, pool = input.pool ?? 10;
  const t = new Set(input.targets);
  const tv = input.cards.filter((c) => t.has(c.id) && c.embedding?.length).map((c) => c.embedding as number[]);
  const focus = input.focusIds && input.focusIds.size ? input.focusIds : null;
  if ((!tv.length && !focus) || max <= 0) return [];
  const simOf = (c: GuardCard) => (tv.length && c.embedding?.length ? Math.max(...tv.map((v) => cos(v, c.embedding as number[]))) : 0);
  const cands = input.cards
    .filter((c) => !t.has(c.id) && (focus ? focus.has(c.id) : !!c.embedding?.length) && (input.stage !== "draft" || c.stage === "draft"))
    .map((c) => ({ id: c.id, sim: simOf(c) }))
    .filter((c) => focus || c.sim >= minSim)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, focus ? Math.max(pool, 40) : pool);
  const score = (c: { id: string; sim: number }) => (input.nightlyIds.has(c.id) ? 2 : 0) + (input.stableIds.has(c.id) ? 1 : 0);
  return cands
    .sort((a, b) => score(b) - score(a) || b.sim - a.sim)
    .slice(0, max)
    .map((c) => {
      const reusable = input.nightlyIds.has(c.id), stable = input.stableIds.has(c.id);
      return { id: c.id, sim: Math.round(c.sim * 100) / 100, reusable, stable, why: `${focus ? "重点の場面・" : ""}${reusable ? "夜の基準あり" : "前を作る"}・${stable ? "安定" : "揺れ不明"}・近さ ${c.sim.toFixed(2)}` };
    });
}

/** 上限に合わせて守りを減らす（純関数）: 守りの見込み（今の回＋前を作る分）が残りに入る所まで、後ろから外す */
export function fitGuardsToCap(guards: ReadonlyArray<GuardPick>, o: { capUsd: number | null; baseUsd: number; unitUsd: number }): GuardPick[] {
  if (!o.capUsd || o.capUsd <= 0) return [...guards];
  const out = [...guards];
  const costOf = (gs: GuardPick[]) => gs.reduce((s, g) => s + o.unitUsd * (g.reusable ? 1 : 2), 0); // 守りは1回・前を作るならもう1回分
  while (out.length && o.baseUsd + costOf(out) > o.capUsd) out.pop();
  return out;
}

/** 計画の1行に足す言葉（純関数） */
export function guardLine(guards: ReadonlyArray<GuardPick>, unitUsd: number): string {
  if (!guards.length) return "守り なし";
  const usd = guards.reduce((s, g) => s + unitUsd * (g.reusable ? 1 : 2), 0);
  return `守り +${guards.length}問（${guards.map((g) => `${g.id} ${g.why}`).join("／")}・1回）・見込み +$${usd.toFixed(2)}`;
}
