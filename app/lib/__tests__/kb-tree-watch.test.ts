// app/lib/__tests__/kb-tree-watch.test.ts — 設計知見の木の見張り（純関数）
import { watchKbTree, kbTreeWatchMarkdown } from "../kb-tree-watch";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const rows = [
  ...Array.from({ length: 6 }, (_, i) => ({ id: `p0-${i}`, title: `P0 ${i}`, priority: 0, parent: null, v: [1, i, 0] })),
  { id: "a", title: "子A", priority: 1, parent: "p0-0", v: [1, 0, 0] },
  { id: "b", title: "子B", priority: 1, parent: "p0-0", v: [1, 0.05, 0] },
  { id: "c", title: "孤児", priority: 1, parent: null, v: [0, 1, 0] },
  { id: "x", title: "輪1", priority: 2, parent: "y", v: null },
  { id: "y", title: "輪2", priority: 2, parent: "x", v: null },
];
const w = watchKbTree(rows);
t("P0 の数と多すぎ", w.p0 === 6 && w.p0Over);
t("親の無い P1", w.orphanP1.map((r) => r.id).join() === "c");
t("同じ親の下の重なり", w.overlaps.length === 1 && w.overlaps[0].parent === "p0-0");
t("輪", w.cycles.includes("x") && w.cycles.includes("y"));
t("Markdown", /P0 の数: 6（目安 5） ⚠/.test(kbTreeWatchMarkdown(w, (id) => id, "2026-11-03")));
console.log(`kb-tree-watch: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
