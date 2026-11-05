// scripts/conductor-focus-eval.ts — 近い番の重点が、今の番の竹内さんの重点と合うか（手元の確かめ・LLM なし・費用 0・作業員5・11/05）
//   KB P0 575a7cd5 ⑤（重点で数える）・977cbded ⑤（時間順で前の番だけ・同じ会話とお客様を外す）。材料は conductor-focus-build.ts の exam-cache。
// 実行: npx tsx scripts/conductor-focus-eval.ts [--file=...]
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { nearestFocus, sceneMajorityFocus, type Focus, type FocusNeighbor } from "../app/lib/conductor-focus";

const DIR = join(process.cwd(), "..", "..", "exam-cache", "conductor-focus");
const fileArg = process.argv.find((a) => a.startsWith("--file="))?.slice(7);
const file = fileArg ?? join(DIR, readdirSync(DIR).filter((f) => f.startsWith("turns-")).sort().pop() as string);
type T = { id: string; conv: string; pc: string | null; at: string; scene: string; route: string; aix: string | null; focus: Focus | null; e1: number[]; e2: number[] };
const turns = (JSON.parse(readFileSync(file, "utf8")) as T[]).filter((t) => t.focus);
const norm = (v: number[]) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
for (const t of turns) { t.e1 = norm(t.e1); t.e2 = norm(t.e2); }
const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

const dist = new Map<string, Focus>();
for (const t of turns) dist.set(t.focus as string, t.focus as Focus);
const cnt = (xs: string[]) => Object.entries(xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1]);
console.log(`番 ${turns.length}・重点の分かれ: ${cnt(turns.map((t) => t.focus as string)).map(([k, v]) => `${k} ${v}`).join("・")}`);

const ONLY = process.argv.find((a) => a.startsWith("--route="))?.slice(8) ?? null; // aix＝押した AIX の番だけ（正解の札が確か）
const MIN_PREV = 50; // 前の番がこれより少ない最初の番は数えない（場面の値が作れない）
type Res = { n: number; scene: number; knn: number; mix: number; band: number; bandHit: number; bandScene: number };
function run(emb: "e1" | "e2", band: number, minN: number, k = 30): { all: Res; byScene: Map<string, Res> } {
  const all: Res = { n: 0, scene: 0, knn: 0, mix: 0, band: 0, bandHit: 0, bandScene: 0 };
  const byScene = new Map<string, Res>();
  for (let i = MIN_PREV; i < turns.length; i++) {
    const t = turns[i];
    const prev = turns.slice(0, i).filter((p) => p.at < t.at && p.conv !== t.conv && (!t.pc || p.pc !== t.pc));
    const sf = sceneMajorityFocus(prev.filter((p) => p.scene === t.scene).map((p) => p.focus as Focus));
    if (!sf) continue;
    if (ONLY && t.route !== ONLY) continue;
    const neigh: FocusNeighbor[] = prev.map((p) => ({ id: p.id, focus: p.focus as Focus, dist: 1 - dot(t[emb], p[emb]) })).sort((a, b) => a.dist - b.dist).slice(0, k);
    const nf = nearestFocus(neigh, { band, minN, sceneFocus: sf });
    const knnTop = nearestFocus(neigh.slice(0, 10), { band: 9, minN: 1, sceneFocus: sf });
    const r = byScene.get(t.scene) ?? { n: 0, scene: 0, knn: 0, mix: 0, band: 0, bandHit: 0, bandScene: 0 };
    for (const x of [all, r]) {
      x.n++; if (sf === t.focus) x.scene++; if (knnTop?.focus === t.focus) x.knn++; if (nf?.focus === t.focus) x.mix++;
      if (nf?.inBand) { x.band++; if (nf.focus === t.focus) x.bandHit++; if (sf === t.focus) x.bandScene++; }
    }
    byScene.set(t.scene, r);
  }
  return { all, byScene };
}
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const line = (r: Res) => `場面の値 ${pct(r.scene, r.n)}・近い10件 ${pct(r.knn, r.n)}・束＋外は場面 ${pct(r.mix, r.n)}（${r.mix - r.scene >= 0 ? "+" : ""}${r.mix - r.scene}番）・束に入った ${r.band}/${r.n}: 束 ${pct(r.bandHit, r.band)} 対 同じ番の場面の値 ${pct(r.bandScene, r.band)}`;
for (const emb of ["e1", "e2"] as const) {
  for (const [band, minN] of [[0.12, 3], [0.15, 3], [0.15, 5], [0.2, 5], [0.25, 5]] as const) {
    const { all } = run(emb, band, minN);
    console.log(`${emb} 束 ${band}・${minN}件以上: n=${all.n} ${line(all)}`);
  }
}
const best = process.argv.find((a) => a.startsWith("--band="))?.slice(7) ?? "0.15";
for (const emb of ["e1", "e2"] as const) {
  const { byScene } = run(emb, Number(best), 3);
  console.log(`\n== ${emb} 束 ${best} 場面ごと ==`);
  for (const [s, r] of [...byScene.entries()].sort((a, b) => b[1].n - a[1].n)) console.log(`${s.padEnd(15)} n=${r.n} ${line(r)}`);
}
