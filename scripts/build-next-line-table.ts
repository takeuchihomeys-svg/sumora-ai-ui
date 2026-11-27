// scripts/build-next-line-table.ts — after-decision-records.NEXT_LINE_TABLE を #804 の木から作り直す（2026-11-27 作業員A・LLM/DB なし）
//   入力: audit-scene-branches.ts --tree-out の json。深さ1（駅）・深さ2（駅＞細かい状態）の n≥minN の節ごとに、深さ3（お客様の次の通の種類）の多い順の上位2つ。
//   出すのは表の行（貼り替え用）だけ。ファイルは書き換えない（表を変えたら after-decision-records.test を回す）
//   実行: npx tsx scripts/build-next-line-table.ts <tree.json> [--min=5]
import { readFileSync } from "node:fs";
import type { TreeNode } from "../app/lib/scene-map-tree";
const path = process.argv.find((a) => a.endsWith(".json"))!;
const MIN = Number(process.argv.find((a) => a.startsWith("--min="))?.slice(6) ?? "5");
const t = JSON.parse(readFileSync(path, "utf8")) as { nodes: TreeNode[] };
for (const n of t.nodes.filter((x) => x.depth <= 2 && x.n >= MIN)) {
  const ch: Record<string, number> = {};
  for (const m of t.nodes.filter((x) => x.depth === 3 && x.key.startsWith(`${n.key} > `))) { const k = m.key.split(" > ")[2]; ch[k] = (ch[k] ?? 0) + m.n; }
  const top = Object.entries(ch).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
  console.log(`  ${JSON.stringify(n.key)}: { n: ${n.n}, top: ${JSON.stringify(top)} },`);
}
