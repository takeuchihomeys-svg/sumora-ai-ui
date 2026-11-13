// scripts/compose-element-daily.ts — 文の要素の当たりと外れの根を、毎日（直しを入れるたびに）同じ物差しで測って台帳に足す（AI を呼ばない・DB を読まない・費用0）
//   2026-11-13 作業員10（統括役「文の要素の当たりを要素ごとに毎日同じ物差しで測れる形に」）。物差しは scripts/lib/compose-gold.ts の evalGoldTurn（audit-compose-roots と同じ）
//   正解: 竹内さんの番だけ（KB 41dadfe6）。主は広い正解 gold-1113-wide.json（竹内さんの文そのものから札付けを広げた版）・狭い gold-1113.json を参考に並べる（11/13 統括役）
//   出す物: ① 要素ごとの当たり（主の役目・頭・つなぎ・押さえ・信頼・潜在・締め・事実）と外れの根 A/B/C/D
//           ② 設計図の行（COMPOSE_PLAN_ROWS_V2）が竹内さんの文の役目（6役目）と合うか: 当たり／竹内さんに無いのに立てた
//   台帳: exam-cache/compose-element-daily.jsonl（1回1行）
// 実行: npx tsx scripts/compose-element-daily.ts [--with=COMPOSE_PHRASE_CATALOG,...] [--compare] [--no-write] [--gold=<主> --ref=<参考>]
import { appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { loadGold, loadProbs, loadBrains, evalGoldTurn, pathWrong, ELEMENTS, type El, type Root } from "./lib/compose-gold";
import { readTurnUnderstanding, readSevenFields, buildSentencePlan, readComposeContext, type TakeuchiGold } from "../app/lib/compose-sentence-plan";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { applyOrderTable } from "../app/lib/compose-order-table";
import { applySceneConstraints } from "../app/lib/compose-vocab";
import { buildPlanRowsV2, V2_OF, V2_ROLES, type V2Role } from "../app/lib/compose-plan-rows-v2";
import { asksFactsOf } from "../app/lib/compose-asks-facts";

const ROOT = resolve(__dirname, "..");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=").slice(1).join("=");
const flag = (k: string) => process.argv.includes(`--${k}`);
const golds = [{ label: "広い（主）", file: arg("gold", "scripts/compose-understanding/gold-1113-wide.json") }, { label: "狭い（参考）", file: arg("ref", "scripts/compose-understanding/gold-1113.json") }];
const probs = loadProbs(ROOT);
const withSw = arg("with").split(",").map((x) => x.trim()).filter(Boolean);

type Row = { el: El; has: number; hit: number; roots: Record<Root, number> };
type RowV2 = { role: V2Role; gold: number; hit: number; extra: number };
function measure(gold: TakeuchiGold[], brainOf: ReturnType<typeof loadBrains>, on: string[]): { n: number; rows: Row[]; v2: RowV2[]; v2PerTurn: number; goldPerTurn: number } {
  const saved = new Map(on.map((k) => [k, process.env[k]]));
  for (const k of on) process.env[k] = "on";
  try {
    const rows = new Map<El, Row>(ELEMENTS.map((el) => [el, { el, has: 0, hit: 0, roots: { A: 0, B: 0, C: 0, D: 0 } }]));
    const v2 = new Map<V2Role, RowV2>(V2_ROLES.map((r) => [r, { role: r, gold: 0, hit: 0, extra: 0 }]));
    let n = 0, v2Rows = 0, goldRows = 0;
    for (const g of gold) {
      const b = brainOf.get(g.id); const p = probs.get(g.id);
      if (!b || !p?.staffText) continue;
      n++;
      for (const r of evalGoldTurn(g, b.brain, p)) { const row = rows.get(r.el)!; if (r.goldHas) { row.has++; if (r.hit) row.hit++; } if (r.root) row.roots[r.root]++; }
      // 設計図の行（v2）
      const scene = resolveReplyScene({ customerText: String(p.customer ?? "") }).scene;
      const u = readTurnUnderstanding(b.brain), s7 = readSevenFields(b.brain);
      const plan = applyOrderTable(applySceneConstraints(buildSentencePlan(u, s7, { scene, ctx: readComposeContext(b.brain) }), scene), u, scene).plan;
      const staff = (p.context ?? []).filter((m) => m.s === "staff").map((m) => ({ text: m.t, aix: !!m.aix }));
      const rv2 = buildPlanRowsV2({ plan, s7, meta: b.brain, scene, customerText: String(p.customer ?? ""), facts: asksFactsOf(b.brain), closing: null, recentStaff: staff.slice(-3), staffOnlyTurn: pathWrong(b.brain) }).rows;
      const gs = new Set(g.roles.map((r) => V2_OF[r]).filter(Boolean) as V2Role[]), s2 = new Set(rv2.map((r) => r.role));
      v2Rows += rv2.length; goldRows += g.roles.length;
      for (const r of V2_ROLES) { const x = v2.get(r)!; if (gs.has(r)) { x.gold++; if (s2.has(r)) x.hit++; } else if (s2.has(r)) x.extra++; }
    }
    return { n, rows: [...rows.values()], v2: [...v2.values()], v2PerTurn: n ? v2Rows / n : 0, goldPerTurn: n ? goldRows / n : 0 };
  } finally { for (const [k, v] of saved) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
}
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const commit = (() => { try { return execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim(); } catch { return "?"; } })();
const runs: Array<{ label: string; on: string[] }> = flag("compare") && withSw.length ? [{ label: "今の既定", on: [] }, { label: `on: ${withSw.join("+")}`, on: withSw }] : [{ label: withSw.length ? `on: ${withSw.join("+")}` : "今の既定", on: withSw }];
const all: Array<{ gold: string; file: string; runs: Array<{ label: string; on: string[] } & ReturnType<typeof measure>> }> = [];
for (const gd of golds) {
  const gold = loadGold(ROOT, gd.file);
  const brainOf = loadBrains(ROOT, new Set(gold.map((g) => g.id)));
  const rs = runs.map((r) => ({ ...r, ...measure(gold, brainOf, r.on) }));
  all.push({ gold: gd.label, file: gd.file, runs: rs });
  console.log(`\n■ 正解 ${gd.label}: ${gd.file}（答案のある番 ${rs[0].n}）・コミット ${commit}`);
  console.log(["要素", ...rs.map((r) => `当たり（${r.label}）`), "外れの根 A/B/C/D（最後の列）"].join("｜"));
  for (const el of ELEMENTS) {
    const cells = rs.map((r) => { const x = r.rows.find((y) => y.el === el)!; return `${x.hit}/${x.has}（${pct(x.hit, x.has)}）`; });
    const last = rs[rs.length - 1].rows.find((y) => y.el === el)!;
    console.log([el, ...cells, `${last.roots.A}/${last.roots.B}/${last.roots.C}/${last.roots.D}`].join("｜"));
  }
  const lv = rs[rs.length - 1];
  console.log(`設計図の行 v2（1番あたり ${lv.v2PerTurn.toFixed(1)} 行・竹内さんの文の役目 ${lv.goldPerTurn.toFixed(1)}）: ${lv.v2.map((x) => `${x.role} ${x.hit}/${x.gold}（余分 ${x.extra}）`).join("・")}`);
}
if (!flag("no-write")) {
  const line = { at: new Date().toISOString(), commit, golds: all.map((a) => ({ gold: a.gold, file: a.file, runs: a.runs.map((r) => ({ label: r.label, on: r.on, n: r.n, elements: Object.fromEntries(r.rows.map((x) => [x.el, { hit: x.hit, has: x.has, roots: x.roots }])), rowsV2: { perTurn: r.v2PerTurn, goldPerTurn: r.goldPerTurn, roles: Object.fromEntries(r.v2.map((x) => [x.role, { hit: x.hit, gold: x.gold, extra: x.extra }])) } })) })) };
  appendFileSync(resolve(ROOT, "../../exam-cache/compose-element-daily.jsonl"), JSON.stringify(line) + "\n");
  console.log("\n台帳に足した: exam-cache/compose-element-daily.jsonl");
}
