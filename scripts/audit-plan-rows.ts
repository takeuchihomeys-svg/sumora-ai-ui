// scripts/audit-plan-rows.ts — 設計図の1文ずつの行が「役目・何を（どの欄）・どうやって（型）・なぜその順」の4つを持っているかを数える（AI なし・DB なし・費用0）
//   2026-11-13 作業員10（統括役の点検の前の確かめ）。材料は正解53番の答案の brain（scripts/lib/compose-gold.ts と同じ読み込み）
//   なぜその順: 行ごとの順の根拠は今は行に無い（設計図の外の OrderBasis.why が1つだけ＝COMPOSE_ORDER_TABLE の判断の根拠）→ 行の側では「from（どの読みから）」があるかを見る
// 実行: npx tsx scripts/audit-plan-rows.ts [--with=COMPOSE_PHRASE_CATALOG,...]
import { resolve } from "node:path";
import { readTurnUnderstanding, readSevenFields, buildSentencePlan, readComposeContext } from "../app/lib/compose-sentence-plan";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { applyOrderTable } from "../app/lib/compose-order-table";
import { applySceneConstraints } from "../app/lib/compose-vocab";
import { loadGold, loadProbs, loadBrains } from "./lib/compose-gold";

const ROOT = resolve(__dirname, "..");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=").slice(1).join("=");
for (const k of arg("with").split(",").map((x) => x.trim()).filter(Boolean)) process.env[k] = "on";
const gold = loadGold(ROOT, arg("gold", "scripts/compose-understanding/gold-1113.json"));
const probs = loadProbs(ROOT);
const brains = loadBrains(ROOT, new Set(gold.map((g) => g.id)));
const byRole = new Map<string, { n: number; noPart: number; noHow: number; noNext: number; noFrom: number }>();
let turns = 0, rows = 0, noPart = 0, noHow = 0, noFrom = 0, noOrderWhy = 0, aixMain = 0;
for (const g of gold) {
  const b = brains.get(g.id)?.brain; const p = probs.get(g.id); if (!b || !p) continue;
  turns++;
  const scene = resolveReplyScene({ customerText: String(p.customer ?? "") }).scene;
  const u = readTurnUnderstanding(b), s7 = readSevenFields(b);
  const plan0 = buildSentencePlan(u, s7, { scene, ctx: readComposeContext(b) });
  const ord = applyOrderTable(applySceneConstraints(plan0, scene), u, scene);
  if (!ord.basis.why) noOrderWhy++;
  if (plan0.aixMain) aixMain++;
  for (const r of ord.plan.rows) {
    rows++;
    const x = byRole.get(r.role) ?? { n: 0, noPart: 0, noHow: 0, noNext: 0, noFrom: 0 }; x.n++;
    if (!r.part) { noPart++; x.noPart++; }
    if (!r.how) { noHow++; x.noHow++; }
    if (!r.next) x.noNext++;
    if (!r.from || r.from === "?") { noFrom++; x.noFrom++; }
    byRole.set(r.role, x);
  }
}
const pc = (a: number, b: number) => `${a}/${b}（${b ? Math.round((a / b) * 100) : 0}%）`;
console.log(`番 ${turns}（主が AIX で返信の行が受けだけの番 ${aixMain}）・設計図の行 ${rows}`);
console.log(`役目は全部の行にある（行＝役目）／何を（part）が無い ${pc(noPart, rows)}／どうやって（how）が無い ${pc(noHow, rows)}／どの読みから（from）が無い ${pc(noFrom, rows)}`);
console.log(`なぜその順: 行ごとの根拠は持たない（設計図の外に1つだけ）。順の根拠の文が無い番 ${pc(noOrderWhy, turns)}`);
console.log("役目｜行｜何を無し｜どうやって無し｜次へ無し｜どの読みから無し");
for (const [k, x] of [...byRole.entries()].sort((a, b) => b[1].n - a[1].n)) console.log(`${k}｜${x.n}｜${x.noPart}｜${x.noHow}｜${x.noNext}｜${x.noFrom}`);
