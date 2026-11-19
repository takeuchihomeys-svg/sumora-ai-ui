// scripts/audit-compose-fact.ts — 文の物差しの「事実」の要素を1番ずつ読む（読むだけ・LLM なし・DB なし・2026-11-15 作業員H）
//   竹内さんの文の事実（正解の part）・設計図の事実の欄（plan.part＋COMPOSE_ASKS_FACTS の依頼ごとの答え）・竹内さんの文を並べ、当たり外れと根（A〜D）を出す。
//   使い方: npx tsx scripts/audit-compose-fact.ts [--gold=scripts/compose-understanding/gold-1113-wide.json] [--with=COMPOSE_ASKS_FACTS] [--miss]
import { resolve } from "node:path";
import { loadGold, loadProbs, loadBrains, evalGoldTurn } from "./lib/compose-gold";

const ROOT = resolve(__dirname, "..");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=").slice(1).join("=");
const gold = loadGold(ROOT, arg("gold", "scripts/compose-understanding/gold-1113-wide.json"));
for (const k of arg("with").split(",").map((x) => x.trim()).filter(Boolean)) process.env[k] = "on";
const probs = loadProbs(ROOT);
const brains = loadBrains(ROOT, new Set(gold.map((g) => g.id)));
let n = 0, has = 0, hit = 0;
for (const g of gold) {
  const b = brains.get(g.id), p = probs.get(g.id);
  if (!b || !p?.staffText) continue;
  n++;
  const all = evalGoldTurn(g, b.brain, p); const r = all.find((x) => x.el === "事実"); const r2 = all.find((x) => x.el === "事実（中身）");
  if (!r?.goldHas) continue;
  has++; if (r.hit) hit++;
  if (process.argv.includes("--miss") && r.hit) continue;
  console.log(`\n${g.id} 話題=${r.hit ? "○" : "×"} 中身=${r2?.hit ? "○" : "×"}（${(r2?.ex ?? "").replace(/^.*中身の重なり=/, "")}）根=${r.root ?? "-"}\n  竹内さんの事実: ${g.part}\n  ${r.ex.replace(/^q\d+「[^」]*」/, "")}\n  竹内さんの文: ${String(p.staffText).replace(/\s+/g, " ").slice(0, 200)}`);
}
console.log(`\n答案のある番 ${n}・事実のある番 ${has}・当たり ${hit}`);
