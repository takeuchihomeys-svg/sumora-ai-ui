// scripts/w1-material-gap-count.ts — 人が直した番（edited-turns の weak-spots.json）を材料の抜けの台帳の①〜⑤で数える（読むだけ・LLM も DB も使わない）
// 実行: npx tsx scripts/w1-material-gap-count.ts [--file=<weak-spots.json>]
import { readFileSync } from "node:fs";
import { countSpots, type WeakSpot } from "./lib/material-gap-count";
import { GAP_WHY_LABEL, GAP_EFFECT_LABEL } from "../app/lib/material-gap-ledger";
const file = process.argv.find((a) => a.startsWith("--file="))?.slice(7) ?? "C:/Users/竹内 悠馬/sumora-ai-ui/.claude/exam-cache/edited-turns/2026-10-16/weak-spots.json";
const j = JSON.parse(readFileSync(file, "utf8")) as { spots: WeakSpot[] };
const r = countSpots(j.spots);
console.log(`材料の抜けの型の番 ${r.total}`);
for (const [k, v] of Object.entries(r.why)) console.log(`  ${k} ${GAP_WHY_LABEL[k as keyof typeof GAP_WHY_LABEL]}: ${v}`);
for (const [k, v] of Object.entries(r.effect)) console.log(`  ⑤ ${GAP_EFFECT_LABEL[k as keyof typeof GAP_EFFECT_LABEL]}: ${v}`);
console.log("上位10（何が｜何のために｜なぜ｜番）");
for (const t of r.top) console.log(`  ${t.what}｜${t.forWhat}｜${t.why}｜${t.n}`);
