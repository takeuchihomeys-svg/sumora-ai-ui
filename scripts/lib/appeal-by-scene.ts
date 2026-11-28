// scripts/lib/appeal-by-scene.ts — 訴求を場面で分けて数える純関数（#755・scripts/audit-appeal-by-scene.ts が使う・試験 scripts/lib/__tests__/appeal-by-scene.test.ts）
export type Row = { conv: string; at: string; node: string | null; branch: string | null; act: string; reached?: boolean; writer?: string | null };

export const APPEAL_ACTS: Record<string, "viewing" | "apply"> = { "reply:invite_viewing": "viewing", "reply:invite_apply": "apply", "aix:viewing_invite": "viewing", "aix:application_push": "apply" };
export const ESTIMATE_PROMISE_ACTS = new Set(["reply:invite_estimate"]);
export type SceneAppeal = { scene: string; n: number; appeal: number; viewing: number; apply: number; estimate: number; reachedAppeal: number; reachedOther: number; other: number };

/** 照らしの行から場面ごとの訴求を数える（純関数） */
export function appealByScene(rows: ReadonlyArray<Row>, o: { writers?: "takeuchi" | "all" } = {}): SceneAppeal[] {
  const by = new Map<string, SceneAppeal>();
  for (const r of rows) {
    if ((o.writers ?? "takeuchi") === "takeuchi" && r.writer !== "takeuchi") continue;
    const scene = r.branch ? `分:${r.branch}` : r.node; if (!scene) continue;
    const s = by.get(scene) ?? { scene, n: 0, appeal: 0, viewing: 0, apply: 0, estimate: 0, reachedAppeal: 0, reachedOther: 0, other: 0 };
    s.n++;
    const ap = APPEAL_ACTS[r.act];
    if (ap) { s.appeal++; s[ap]++; if (r.reached) s.reachedAppeal++; }
    else { s.other++; if (r.reached) s.reachedOther++; if (ESTIMATE_PROMISE_ACTS.has(r.act)) s.estimate++; }
    by.set(scene, s);
  }
  return [...by.values()].sort((a, b) => b.n - a.n);
}

