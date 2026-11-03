// app/lib/kb-tree-watch.ts — 設計知見の木の毎週の見張り（純関数・DB/LLM なし）
//
// 2026-11-03 作業員6（竹内さん KB P1「設計知見そのものにも統括を作る」④）。kb-curate が毎週数える3つ:
//   ①P0 の数（目安 5）②親の無い P1 ③同じ親の下の重なり（子どうしの近さ ≥ 0.85 ＝束ねる候補）。束ねる案は Markdown で出すだけ（自動では退役しない）。
// テスト: app/lib/__tests__/kb-tree-watch.test.ts
export type TreeRow = { id: string; title: string; priority: number | null; parent: string | null; v: number[] | null };
const cos = (a: number[], b: number[]) => { let s = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return s / (Math.sqrt(x * y) || 1); };
export const P0_TARGET = 5;

export function watchKbTree(rows: ReadonlyArray<TreeRow>, o: { overlap?: number } = {}): { p0: number; p0Over: boolean; orphanP1: TreeRow[]; overlaps: Array<{ parent: string; a: TreeRow; b: TreeRow; sim: number }>; cycles: string[] } {
  const th = o.overlap ?? 0.85;
  const p0 = rows.filter((r) => r.priority === 0).length;
  const orphanP1 = rows.filter((r) => r.priority === 1 && !r.parent);
  const byParent = new Map<string, TreeRow[]>();
  for (const r of rows) if (r.parent) { const l = byParent.get(r.parent) ?? []; l.push(r); byParent.set(r.parent, l); }
  const overlaps: Array<{ parent: string; a: TreeRow; b: TreeRow; sim: number }> = [];
  for (const [parent, kids] of byParent) {
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const a = kids[i], b = kids[j];
      if (!a.v || !b.v) continue;
      const s = cos(a.v, b.v);
      if (s >= th) overlaps.push({ parent, a, b, sim: s });
    }
  }
  // 輪（親をたどって自分に戻る）
  const parentOf = new Map(rows.map((r) => [r.id, r.parent]));
  const cycles: string[] = [];
  for (const r of rows) {
    const seen = new Set<string>([r.id]);
    let p = r.parent, n = 0;
    while (p && n++ < 50) { if (seen.has(p)) { cycles.push(r.id); break; } seen.add(p); p = parentOf.get(p) ?? null; }
  }
  return { p0, p0Over: p0 > P0_TARGET, orphanP1, overlaps: overlaps.sort((x, y) => y.sim - x.sim), cycles };
}
export function kbTreeWatchMarkdown(w: ReturnType<typeof watchKbTree>, titleOf: (id: string) => string, today: string): string {
  const s8 = (id: string) => id.slice(0, 8);
  return [
    `# 設計知見の木の見張り（${today}）`, "",
    `- P0 の数: ${w.p0}（目安 ${P0_TARGET}）${w.p0Over ? " ⚠ 多い＝束ねる案を竹内さんに" : ""}`,
    `- 親の無い P1: ${w.orphanP1.length}`, ...w.orphanP1.slice(0, 20).map((r) => `  - ${s8(r.id)} ${r.title.slice(0, 80)}`),
    `- 同じ親の下の重なり（束ねる候補）: ${w.overlaps.length}`, ...w.overlaps.slice(0, 20).map((x) => `  - 親 ${s8(x.parent)}「${titleOf(x.parent).slice(0, 40)}」: ${s8(x.a.id)}「${x.a.title.slice(0, 40)}」＋ ${s8(x.b.id)}「${x.b.title.slice(0, 40)}」近さ ${x.sim.toFixed(2)}`),
    w.cycles.length ? `- ⚠ 輪になっている行: ${w.cycles.map(s8).join("・")}` : "",
  ].filter(Boolean).join("\n");
}
