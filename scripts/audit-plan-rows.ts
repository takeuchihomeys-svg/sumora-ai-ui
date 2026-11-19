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

// ── COMPOSE_PLAN_ROWS_V2 の行（竹内さんの文の役目と6役目で比べる） ──
import("../app/lib/compose-plan-rows-v2").then(async ({ buildPlanRowsV2, V2_OF, V2_ROLES }) => {
  const { asksFactsOf } = await import("../app/lib/compose-asks-facts");
  const { pathWrong } = await import("./lib/compose-gold");
  const T = new Map(V2_ROLES.map((r) => [r, { gold: 0, v1: 0, v2: 0, v1hit: 0, v2hit: 0, v2extra: 0 }]));
  let n = 0, v1rows = 0, v2rows = 0, goldRows = 0;
  for (const g of gold) {
    const b = brains.get(g.id)?.brain; const p = probs.get(g.id); if (!b || !p) continue;
    n++;
    const scene = resolveReplyScene({ customerText: String(p.customer ?? "") }).scene;
    const u = readTurnUnderstanding(b), s7 = readSevenFields(b);
    const plan = applyOrderTable(applySceneConstraints(buildSentencePlan(u, s7, { scene, ctx: readComposeContext(b) }), scene), u, scene).plan;
    const staff = (p.context ?? []).filter((m) => m.s === "staff").map((m) => ({ text: m.t, aix: !!(m as { aix?: boolean }).aix }));
    const v2 = buildPlanRowsV2({ plan, s7, meta: b, scene, customerText: String(p.customer ?? ""), facts: asksFactsOf(b), closing: null, recentStaff: staff.slice(-3), staffOnlyTurn: pathWrong(b) }).rows;
    const gs = new Set(g.roles.map((r) => V2_OF[r]).filter(Boolean)), s1 = new Set(plan.rows.map((r) => V2_OF[r.role]).filter(Boolean)), s2 = new Set(v2.map((r) => r.role));
    v1rows += plan.rows.length; v2rows += v2.length; goldRows += g.roles.length;
    for (const r of V2_ROLES) { const x = T.get(r)!; if (gs.has(r)) { x.gold++; if (s1.has(r)) x.v1hit++; if (s2.has(r)) x.v2hit++; } if (s1.has(r)) x.v1++; if (s2.has(r)) { x.v2++; if (!gs.has(r)) x.v2extra++; } }
  }
  console.log(`\nv2: 番 ${n}・1番あたりの行 v1 ${(v1rows / n).toFixed(1)} → v2 ${(v2rows / n).toFixed(1)}（竹内さんの文の役目 ${(goldRows / n).toFixed(1)}）`);
  console.log("6役目｜竹内さんにある番｜v1 で当たり｜v2 で当たり｜v2 で竹内さんに無いのに立てた");
  for (const [r, x] of T) console.log(`${r}｜${x.gold}｜${x.v1hit}｜${x.v2hit}｜${x.v2extra}`);
});

// ── 信頼の札付けを広げて数え直す（11/13 統括役・費用0）: 正解の「trust・barrier の役目」に加え、竹内さんの文そのものに
//   こちらの手間・サポート・期日・選択肢・正直な弱点・少なさ・会社の具体の語がある番も「竹内さんに信頼の文がある」と数える（「となります」だけの事実は数えない）
import("../app/lib/compose-plan-rows-v2").then(async ({ buildPlanRowsV2, V2_OF }) => {
  const { asksFactsOf } = await import("../app/lib/compose-asks-facts");
  const { pathWrong } = await import("./lib/compose-gold");
  const { trustOfText } = await import("../app/lib/compose-phrase-catalog");
  const WIDE = /1部屋のみ|のみとなります|2番手|独立系|保証会社|仲介手数料|弊社/;
  let n = 0, narrowHas = 0, wideHas = 0, v2 = 0, hitN = 0, hitW = 0;
  for (const g of gold) {
    const b = brains.get(g.id)?.brain; const p = probs.get(g.id); if (!b || !p) continue;
    n++;
    const scene = resolveReplyScene({ customerText: String(p.customer ?? "") }).scene;
    const u = readTurnUnderstanding(b), s7 = readSevenFields(b);
    const plan = applyOrderTable(applySceneConstraints(buildSentencePlan(u, s7, { scene, ctx: readComposeContext(b) }), scene), u, scene).plan;
    const staff = (p.context ?? []).filter((m) => m.s === "staff").map((m) => ({ text: m.t, aix: !!(m as { aix?: boolean }).aix }));
    const rows = buildPlanRowsV2({ plan, s7, meta: b, scene, customerText: String(p.customer ?? ""), facts: asksFactsOf(b), closing: null, recentStaff: staff.slice(-3), staffOnlyTurn: pathWrong(b) }).rows;
    const narrow = g.roles.some((r) => V2_OF[r] === "trust");
    const tt = String((p as { staffText?: string }).staffText ?? "");
    const wide = narrow || trustOfText(tt).some((k) => k !== "fact") || WIDE.test(tt);
    const stood = rows.some((r) => r.role === "trust");
    if (narrow) narrowHas++; if (wide) wideHas++; if (stood) { v2++; if (narrow) hitN++; if (wide) hitW++; }
  }
  console.log(`\n信頼の札付けを広げた数え直し（${n}番）: 竹内さんに信頼の文がある番 狭い ${narrowHas} → 広い ${wideHas}／v2 で立てた ${v2} のうち当たり 狭い ${hitN}（余分 ${v2 - hitN}）→ 広い ${hitW}（余分 ${v2 - hitW}）`);
});
