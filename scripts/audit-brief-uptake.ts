// scripts/audit-brief-uptake.ts — 「渡した物を下書きが入れたか」の確かめ（compose-brief-uptake）を竹内さんの本当の文に当て、誤って「入れ漏れ」と付ける物を数える（読むだけ・LLM/DB なし・費用0）
//   2026-11-15 作業員I。竹内さんの文（試験の問題の staffText）は正解＝そこで「入れ漏れ」と出た物は誤り。誤りが0の欄だけを、書き手に1回直させる形・スタッフへの注記に使ってよい
//   指示書は試験の答案の brain から作る（buildConductorBrief・NEXT_MOVE_CONCRETE=on）。--root=<problems.json と results がある作業ツリー>
// 実行: npx tsx scripts/audit-brief-uptake.ts [--root=<exam-night>] [--show]
import { resolve } from "node:path";
import { loadProbs, loadBrains } from "./lib/compose-gold";
import { buildConductorBrief } from "../app/lib/conductor-brief";
import { briefUptake } from "../app/lib/compose-brief-uptake";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=").slice(1).join("=");
const ROOT = resolve(arg("root", resolve(__dirname, "..")));
process.env.NEXT_MOVE_CONCRETE = process.env.NEXT_MOVE_CONCRETE ?? "on";
const probs = loadProbs(ROOT);
const brains = loadBrains(ROOT, new Set(probs.keys()));
const by = new Map<string, { n: number; miss: number; ex: string[] }>();
let turns = 0;
for (const [id, b] of brains) {
  const p = probs.get(id);
  if (!p?.staffText) continue;
  turns++;
  const items = briefUptake(buildConductorBrief(b.brain), p.staffText);
  for (const i of items) {
    const k = `${i.section}`; const v = by.get(k) ?? { n: 0, miss: 0, ex: [] };
    v.n++; if (!i.used) { v.miss++; if (v.ex.length < 4) v.ex.push(`${id} ${i.label}`); }
    by.set(k, v);
  }
}
console.log(`竹内さんの文 ${turns}番（答案の brain がある問題）`);
for (const [k, v] of by) console.log(`- ${k}: 求めた ${v.n}・竹内さんの文に無い（＝誤って付ける）${v.miss}${v.miss ? `（${v.ex.join("／")}）` : ""}`);
